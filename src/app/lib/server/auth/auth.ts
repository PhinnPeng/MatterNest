import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { cache } from "react";
import { eq } from "drizzle-orm";
import { type DataScope, widestDataScope } from "@/shared/enums";
import { nextId } from "@/shared/ids/snowflake";
import { KEY_BYTES, parseKeyMaterial } from "../crypto/field-crypto";
import { getDb } from "../db/client";
import { appUser, appUserRole, authSession, role } from "../db/schema";

/**
 * 认证：服务端 session 表 + httpOnly cookie（技术选型 §3.4；§13.2 继承的 C4「Next 无第一方 session」）。
 *
 * 四条是安全前提而不是偏好，写在代码旁边以免被"顺手优化"掉：
 *   · cookie 里放**随机 token**，DB 只存 HMAC 摘要 ⇒ 库被读也拿不到可用会话；
 *   · 口令校验用 `scrypt` + `timingSafeEqual`，不用 `===`（短路比较会把口令校验变成计时探针）；
 *   · `readActor()` 只在 `/api/**` 内部调用 —— 禁令⑤：Next 官方明令鉴权不得只依赖
 *     middleware/proxy（matcher 未命中的路径会连带跳过该路径上的 Server Function）；
 *   · `cookies()` 在 Next 16 是**异步**的（写成同步拿到的是 Promise，`.get()` 直接 undefined）。
 */

const COOKIE = "mn_session";
/** 演示期 8 小时绝对过期；离职回收降级（P1-16）正是靠这个窗口兜底 */
const SESSION_TTL_SECONDS = 60 * 60 * 8;

/**
 * 摘要密钥只从 env 取；缺了就抛，不用硬编码默认值糊过去（技术选型 §6）。
 *
 * **形状与另两把逐字相同**（MATT-36 决策第 4 项）：走 `parseKeyMaterial`，
 * 即 32 字节（43 字符 base64url / 64 字符 hex），长度不符即拒。
 * 在此之前它是三把里**唯一**只查「非空」的 —— 而它恰恰是**唯一能造成权限提升**
 * 的那把（拿到即可为任意 `userId` 算出合法 `token_hash`）。弱值在这里
 * 不是「不够安全」，是「本该拦住的没拦住」。NIST 对 HMAC 密钥的门限是
 * ≥112 bit，32 字节 = 256 bit。
 *
 * **模块级缓存**（与 `field-crypto.ts` 的 `aesKey()` 同一形状，MATT-36 收紧第 2 项）：
 * 它在**热路径**上 —— `pepper()` → `tokenHashOf()` → `readActor()`，
 * 而 `withActor()` 是**每个** `/api/**` handler 的包装器（`http.ts:188`），
 * 即每个需鉴权的请求都重读一次 `process.env`。
 *
 * ⚠ 缓存的代价写在下面，因为它不显然：**改了 `.env` 里的 pepper 而不重启，
 * 这个值不会生效**。已发出的 cookie 仍按旧 pepper 校验（继续能用），
 * 新发的会话也仍用旧 pepper —— 于是 `.env` 里显示新值、跑的却是旧值。
 *
 * 这不是缺陷，是缓存的定义；要说清楚的是**为什么它值得写下来**：
 * 改动之前（每次重读 `process.env`）这件事是「改了就生效」的，
 * 加了缓存之后不再是 ⇒ **从「改 `.env` 即可」变成了「改 `.env` + 重启」**。
 * 步骤多了一步，而漏掉那一步的形态是静默的（服务照常、会话照常、只是没换）。
 * ⚠ 换 pepper 的运维手册必须写「改 env **+ 重启**」两步。
 *
 * ⚠ 标注：本仓**未实测** Next dev 是否会在 `.env` 变化时热重载 `process.env`。
 * 上面那句结论**不依赖**那个答案 —— 无论它会不会重载，缓存都会让新值不生效。
 */
let pepperCache: string | null = null;
function pepper(): string {
  if (pepperCache === null) {
    const raw = process.env.MN_SESSION_PEPPER;
    // 抛错时用的是它自己的消息（已中性化，不再说「字段加密的密钥」——
    // 那是另两把的语境，出现在 pepper 上会把人引去查错文件）
    parseKeyMaterial(raw, "MN_SESSION_PEPPER", KEY_BYTES);
    pepperCache = raw!.trim();
  }
  return pepperCache;
}

/**
 * 启动期自检（对称于 `field-crypto.ts` 的 `assertFieldCryptoConfigured()`）。
 *
 * ## 为什么它必须存在，而不是「让 `pepper()` 在第一次鉴权时抛」
 *
 * 没有它的话，缺 `MN_SESSION_PEPPER` 的形态是：应用 ready、`/login` 页面 200、
 * 然后**每一个** `/api/**` 请求 500。那是「看起来起来了、其实全不可用」——
 * 而部署健康检查打的就是 `/login`，它会报绿。
 *
 * 调用点在 `instrumentation-node.ts` 的 `registerNode()`，排在起定时器之前。
 */
export function assertSessionPepperConfigured(): void {
  pepper();
}

function tokenHashOf(token: string): string {
  return createHmac("sha256", pepper()).update(token).digest("hex");
}

/** 与 seed 同一套派生（salt 由用户名决定）。生产要换成每用户随机 salt + 参数入列。 */
function derive(password: string, username: string): Buffer {
  return scryptSync(password, `mn-demo-salt-${username}`, 64);
}

export function verifyPassword(password: string, username: string, stored: string | null): boolean {
  if (!stored) return false;
  const got = derive(password, username);
  const want = Buffer.from(stored, "hex");
  return want.length === got.length && timingSafeEqual(got, want);
}

export function hashPassword(password: string, username: string): string {
  return derive(password, username).toString("hex");
}

export type Actor = {
  userId: string;
  displayName: string;
  /** 多角色取最宽并集（权限草案 §2）；比较逻辑只有 `widestDataScope` 一处 */
  dataScope: DataScope;
  /**
   * `mn_app_user.is_admin`：绕过数据范围的最后开关（草案 §3）。
   * 它**不是**第五个特权开关 —— 只放开"看得见哪些行"，不给出 `can_unarchive` 之类的不可逆动作。
   */
  isAdmin: boolean;
  /**
   * `mn_app_user.is_system_owner`：**凭据生命线的持有者**（MATT-53 / 迁移 0007）。
   *
   * 与 `isAdmin` 不是一回事：`isAdmin` 是权限模型的逃生口（只短路数据范围、不给特权）；
   * 本字段是身份本身，判定的是"谁能启动恢复"——一期唯一用法是 F6-9 本地凭据设置/重置。
   * 全局至多一人由 `uk_mn_app_user_owner` 这个 partial unique index 兜底。
   *
   * 它**不进** `privileges`：那四个是"角色授予的特权"（多角色取并集），
   * 而本字段是账号上的标记，并集语义对它没有意义。
   */
  isSystemOwner: boolean;
  privileges: {
    canUnarchive: boolean;
    canReadPlain: boolean;
    canManageUser: boolean;
    canManageConfig: boolean;
  };
};

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  const db = await getDb();
  await db.insert(authSession).values({
    // 主键列是 bigint mode，只在这里跟 BigInt 打交道；对外一律 string（P1-19）
    id: BigInt(nextId()),
    userId: BigInt(userId),
    tokenHash: tokenHashOf(token),
    authVia: "local",
    expiresAt: expiresAt.toISOString(),
  });
  return { token, expiresAt };
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) {
    const db = await getDb();
    await db.delete(authSession).where(eq(authSession.tokenHash, tokenHashOf(token)));
  }
  jar.delete(COOKIE);
}

/**
 * 当前操作者；无会话 / 过期 / 停用 / 未开通一律 null，由调用方出 401。
 *
 * `cache()` 做**请求级**去重：一次请求里列表、计数、按钮可见性各自都要 actor，
 * 不去重就是三次查库加三次 JOIN。
 */
export const readActor = cache(async (): Promise<Actor | null> => {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;

  const db = await getDb();
  const rows = await db
    .select({
      userId: appUser.id,
      displayName: appUser.displayName,
      isEnabled: appUser.isEnabled,
      isAdmin: appUser.isAdmin,
      isSystemOwner: appUser.isSystemOwner,
      activationStatus: appUser.activationStatus,
      // 软删：会话一旦建立就不会自己作废，所以**每个请求**都得重判一次（审计 F5）
      isDeleted: appUser.isDeleted,
      expiresAt: authSession.expiresAt,
    })
    .from(authSession)
    .innerJoin(appUser, eq(appUser.id, authSession.userId))
    .where(eq(authSession.tokenHash, tokenHashOf(token)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) return null;
  // 停用/离职与"自动建号但未批准"都在此拦住（§5 失效链路、§7 假设 F）
  if (!row.isEnabled || row.activationStatus !== "active" || row.isDeleted) return null;

  const grants = await db
    .select({
      dataScope: role.dataScope,
      canUnarchive: role.canUnarchive,
      canReadPlain: role.canReadPlain,
      canManageUser: role.canManageUser,
      canManageConfig: role.canManageConfig,
    })
    .from(appUserRole)
    .innerJoin(role, eq(role.id, appUserRole.roleId))
    .where(eq(appUserRole.userId, row.userId));
  if (grants.length === 0) return null;

  return {
    userId: String(row.userId),
    displayName: row.displayName,
    dataScope: widestDataScope(grants.map((g) => g.dataScope as DataScope)),
    isAdmin: row.isAdmin,
    isSystemOwner: row.isSystemOwner,
    privileges: {
      canUnarchive: grants.some((g) => g.canUnarchive),
      canReadPlain: grants.some((g) => g.canReadPlain),
      canManageUser: grants.some((g) => g.canManageUser),
      canManageConfig: grants.some((g) => g.canManageConfig),
    },
  };
});

export const SESSION_COOKIE = COOKIE;
