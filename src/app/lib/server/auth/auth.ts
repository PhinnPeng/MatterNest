import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { cache } from "react";
import { eq } from "drizzle-orm";
import { type DataScope, widestDataScope } from "@/shared/enums";
import { nextId } from "@/shared/ids/snowflake";
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

/** 摘要密钥只从 env 取；缺了就抛，不用硬编码默认值糊过去（技术选型 §6） */
function pepper(): string {
  const v = process.env.MN_SESSION_PEPPER;
  if (!v) throw new Error("缺 MN_SESSION_PEPPER：会话摘要密钥不许走默认值");
  return v;
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
      activationStatus: appUser.activationStatus,
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
  if (!row.isEnabled || row.activationStatus !== "active") return null;

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
    privileges: {
      canUnarchive: grants.some((g) => g.canUnarchive),
      canReadPlain: grants.some((g) => g.canReadPlain),
      canManageUser: grants.some((g) => g.canManageUser),
      canManageConfig: grants.some((g) => g.canManageConfig),
    },
  };
});

export const SESSION_COOKIE = COOKIE;
