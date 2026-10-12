/**
 * 冒烟用的临时账号装置（审计 F1 之后加的）。
 *
 * 为什么需要它：seed 原先下发"口令 = 用户名"的演示摘要（明文写在 git 跟踪的 SQL 里），
 * 三个冒烟脚本就靠那个摘要登录。F1 把摘要撤掉之后**它们全都登不进去**。
 *
 * 为什么不改成"换个口令继续用同一个账号"：那等于把弱口令换个形状留在仓库里——
 * F1 撤掉的是「拿到仓库就能登入」，不是「测试需要一个能登的账号」。
 *
 * 所以账号由脚本**在运行时自建**，口令是当场随机生成的：
 *   · 仓库里不再有任何可用凭据；
 *   · 每次跑用的是不同口令，跑完即删；
 *   · 清单里的 `finally` 已经会删会话与角色，这里再删账号本身。
 *
 * 哈希算法与 `auth.ts` 的 `derive` 同源（scrypt + `mn-demo-salt-<username>`）。
 * 这里复制那一行是**有意的**：冒烟脚本是纯 .mjs，导不进 TS 模块；
 * 而若哪天 `auth.ts` 改了 salt 规则，本装置会在下面那条登录断言上直接红——
 * 那正是我们想要的「不一致会被发现」。
 */
import { randomBytes, scryptSync } from "node:crypto";

const SALT_PREFIX = "mn-demo-salt-";

function hashLike(password, username) {
  return scryptSync(password, `${SALT_PREFIX}${username}`, 64).toString("hex");
}

/**
 * 建一个临时账号并挂上给定的角色 code。
 * @returns {{id: bigint, username: string, password: string}}
 */
export async function createSmokeAccount(sql, { roles, isAdmin = false, suffix = "" }) {
  const username = `mn_smoke_${randomBytes(4).toString("hex")}${suffix}`;
  const password = randomBytes(18).toString("base64url");
  const hash = hashLike(password, username);
  const stamp = BigInt(Date.now() * 1000) + BigInt(Math.floor(Math.random() * 1000));

  const [user] = await sql`
    insert into mn_app_user (id, username, display_name, password_hash, is_enabled, is_admin, activation_status, created_at, updated_at)
    values (${stamp}, ${username}, ${`冒烟临时账号 ${username.slice(-6)}`}, ${hash}, true, ${isAdmin}, 'active', now(), now())
    on conflict ("username") do update set password_hash = excluded.password_hash, is_enabled = true, updated_at = now()
    returning id`;

  for (const [i, code] of roles.entries()) {
    const [role] = await sql`select id from mn_role where code = ${code} limit 1`;
    if (!role) throw new Error(`冒烟账号挂角色失败：mn_role 里没有 code=${code}`);
    await sql`
      insert into mn_app_user_role (id, user_id, role_id, created_at)
      values (${stamp + BigInt(i) + 1n}, ${user.id}, ${role.id}, now())
      on conflict do nothing`;
  }
  return { id: user.id, username, password };
}

/** 删掉临时账号及其会话、角色映射。清场用。 */
export async function dropSmokeAccount(sql, userId) {
  if (userId === undefined || userId === null) return;
  await sql`delete from mn_auth_session where user_id = ${userId}`;
  await sql`delete from mn_app_user_role where user_id = ${userId}`;
  await sql`delete from mn_app_user where id = ${userId}`;
}

export const ROLE_CODES = {
  /** 全局管理：全部记录 + 撤销归档 + 明文导出。冒烟里用它当"权限最大的那个人" */
  fullAdmin: "full_admin",
  /** 参与经办：只看得见自己参与的事 */
  joined: "joined_operator",
  /** 承办经办：只看得见自己经办或创建的 */
  self: "self_operator",
  /** 系统管理：管配置与账号，数据范围压到 owned */
  sysAdmin: "sys_admin",
};