/**
 * 账号准入门禁：停用 / 未开通 / **软删** 三种状态都必须挡住登录。
 *
 * ## 守的是什么
 *
 * 鉴权审计的 F5。账号可以被**软删**（`is_deleted = true`）：行还在库里、名字还在，
 * 只多了一个标记。这是"人已经离开公司"的意思。
 *
 * 两个门禁决定一个人能不能进系统：
 *   · **登录门禁** `api/auth/login/route.ts`
 *   · **每请求门禁** `auth.ts` 的 `readActor()`
 *
 * 两处原本都只查 `is_enabled` 与 `activation_status`，**完全没看 `is_deleted`**。
 * 于是离职的人被软删之后照样登得进去。
 *
 * ## 为什么 F1 之后更要守这条
 *
 * F1 把六个内置账号的口令摘要清成了 NULL，所以它们全登不进去——**F5 被 F1 盖住了**。
 * 这不是修好了：管理员一旦给某个账号设了口令，F5 立刻重新生效。
 * 「现在测不出来」不是「不存在」，所以这条门禁要自己造一个**有口令的软删账号**。
 *
 * ## 反向红已验
 * 见提交说明：注回 `isDeleted` 判定前，第 4 条与第 6 条断言红，且红的是**断言**
 * （401 未返回），不是崩溃也不是编译失败。
 */
import { createSmokeAccount, dropSmokeAccount, ROLE_CODES } from "./_testacct.mjs";

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";
const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`[ ok ] ${name}${extra ? " — " + extra : ""}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}${extra ? " — " + extra : ""}`);
  }
};

async function login(username, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return {
    status: res.status,
    cookie: (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; "),
    body: await res.json().catch(() => null),
  };
}

// ⚠ 账号创建必须在 `try` **之内**（与 `probe-risk-page` 同一条纪律）：
// 原来它在 `try` 外面，那一步抛错就没人清场，库里留孤儿。
const acct = await (async () => {
  try {
    return await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
  } catch (e) {
    console.log(`  · 建账号失败：${String(e.message).split("\n")[0]}`);
    await sql.end();
    process.exit(2);
  }
})();
const uid = BigInt(acct.id);

try {
  // ── 基线：账号是活的，有口令，登得进去 ──
  const good = await login(acct.username, acct.password);
  ok("基线：未软删的账号可登录", good.status === 200 && Boolean(good.cookie), `status=${good.status}`);

  const sess = await fetch(`${BASE}/api/session`, { headers: { cookie: good.cookie } });
  ok("基线：会话可用", sess.status === 200, `status=${sess.status}`);

  // ── 软删 ──
  await sql`update mn_app_user set is_deleted = true, deleted_at = now() where id = ${uid}`;
  const [marked] = await sql`select is_deleted from mn_app_user where id = ${uid}`;
  ok("已把账号软删", marked?.is_deleted === true, `is_deleted=${marked?.is_deleted}`);

  // ── 这四条的形状刻意各不相同：分别钉住"重新登录"与"既有会话"两条独立路径 ──

  // 1) 登录门禁必须挡住：软删账号重新登录
  const after = await login(acct.username, acct.password);
  ok(
    "软删后重新登录被拒（登录门禁）",
    after.status === 401,
    `status=${after.status}${after.status === 200 ? " ⚠ 软删账号仍能登录" : ""}`,
  );

  // 2) 登录门禁必须与"口令错误"给**同一句**提示（防枚举，别把"已软删"标出来）
  const wrong = await login(acct.username, "definitely-not-the-password");
  ok(
    "软删与口令错误同一句提示（不泄露账号状态）",
    after.status === wrong.status && after.body?.message === wrong.body?.message,
    `软删="${after.body?.message}" 错口令="${wrong.body?.message}"`,
  );

  // 3) 既有会话必须立刻失效（readActor 这条路径，登录门禁管不到）
  const oldSess = await fetch(`${BASE}/api/session`, { headers: { cookie: good.cookie } });
  ok(
    "软删后既有会话立刻失效（每请求门禁 readActor）",
    oldSess.status === 401,
    `status=${oldSess.status}${oldSess.status === 200 ? " ⚠ 旧会话仍有效" : ""}`,
  );

  // 4) 业务端点也必须挡住——会话失效若只体现在 /api/session，业务接口会漏
  const biz = await fetch(`${BASE}/api/risk-matters?page=1&pageSize=1`, {
    headers: { cookie: good.cookie },
  });
  ok(
    "软删后业务端点也拒绝旧会话",
    biz.status === 401,
    `status=${biz.status}${biz.status === 200 ? " ⚠ 业务接口放行了软删账号" : ""}`,
  );

  // ── 对照组：停用与未开通本来就被挡住了，别在这次改动里退化 ──
  await sql`update mn_app_user set is_deleted = false, deleted_at = null where id = ${uid}`;
  await sql`update mn_app_user set is_enabled = false where id = ${uid}`;
  const disabled = await login(acct.username, acct.password);
  ok("对照组：停用账号被拒", disabled.status === 401, `status=${disabled.status}`);

  await sql`update mn_app_user set is_enabled = true, activation_status = 'pending' where id = ${uid}`;
  const pending = await login(acct.username, acct.password);
  ok("对照组：未开通账号被拒", pending.status === 401, `status=${pending.status}`);

  // 复原，确认状态位本身没有把账号永久锁死
  await sql`update mn_app_user set activation_status = 'active' where id = ${uid}`;
  const back = await login(acct.username, acct.password);
  ok("复原后账号可再次登录（状态位可逆，不是永久封）", back.status === 200, `status=${back.status}`);
} finally {
  const step = async (label, fn) => {
    try {
      await fn();
    } catch (e) {
      console.log(`  · 清场「${label}」未完成：${String(e.message).split("\n")[0]}`);
    }
  };
  // 先把软删标记撤掉，否则下面删账号会撞 RESTRICT 外键
  await step("撤销软删标记", () => sql`update mn_app_user set is_deleted = false, deleted_at = null where id = ${uid}`);
  await step("删临时账号", () => dropSmokeAccount(sql, acct.id));
  await step("断开数据库", () => sql.end());
}

console.log(`\nPASS：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);