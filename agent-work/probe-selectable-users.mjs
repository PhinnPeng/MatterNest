/**
 * 可选处理人门禁（权限草案 §4.1 / §6，PRD F6-7 + Q1 收窄）。
 *
 * ## 守的是什么
 *
 * Q1 裁定：**加参与人时被加者必须落在操作者的可见用户集内**；L1 可加全公司，
 * L2/L3 只能加**共现过**的同事。§6 的被加者条件是三重的：
 * `is_enabled = true` **且** `activation_status = 'active'` **且** 落在可见用户集内。
 *
 * 这条门禁重点守的是**写路径**。只把下拉收窄是装饰——任何一个看得见这条事项的登录用户，
 * 直接 PATCH 一个任意 `ownerId` 就能绕过，那 Q1 收窄等于没生效。
 * 下面第 5 条就是那个绕过，用的是**另一个账号 + 直接 POST/PATCH**，完全不经过界面。
 *
 * ## 刻意不守的（各有出处，别当成漏了）
 *
 * - **创建期例外（IQ-14）**：登记表单上放开到全体 active 用户。本门禁只测"创建之后"的变更。
 * - **裸 `/users` 列表**：§4.1 明写第一期不提供。所以门禁断言它**不存在**（404/405）。
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

async function as(acct) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: acct.username, password: acct.password }),
  });
  return {
    status: r.status,
    cookie: (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; "),
  };
}
const call = async (method, path, cookie, payload) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(payload ? { "content-type": "application/json" } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
};

const step = async (label, fn) => {
  try {
    await fn();
  } catch (e) {
    console.log(`  · 清场「${label}」未完成：${String(e.message).split("\n")[0]}`);
  }
};

let l1 = null;
let l2 = null;
let stranger = null;
let riskId = null;
try {
  // L1：全公司可加  ·  L2：只能加共现过的  ·  stranger：与 L2 无任何共现
  l1 = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
  l2 = await createSmokeAccount(sql, { roles: [ROLE_CODES.joined] });
  stranger = await createSmokeAccount(sql, { roles: [ROLE_CODES.self] });

  const c1 = await as(l1);
  const c2 = await as(l2);
  const c3 = await as(stranger);
  ok("三个账号登录", c1.status === 200 && c2.status === 200 && c3.status === 200);

  const now = new Date().toISOString();
  const [r] = await sql`
    insert into mn_risk_matter (id, code, name, type, level, status, description, discover_date, created_by, created_at, updated_at)
    values (${BigInt(Date.now() * 1000) + 3n}, ${"SEL-" + Date.now().toString(36).toUpperCase()},
            ${"选人门禁探针"}, 'other', 'mid', 'open', '跑完即删', ${now}, ${l1.id}, ${now}, ${now})
    returning id`;
  riskId = r.id;
  // 让 L2 成为参与人 ⇒ L2 与 stranger **仍然**无共现（这是本门禁的关键前提）
  // 列名是 `risk_matter_id`（drizzle 侧映射成 hostId，别照抄那边）
  await sql`insert into mn_risk_matter_staff (id, risk_matter_id, user_id, staff_role, created_at)
            values (${BigInt(Date.now() * 1000) + 5n}, ${riskId}, ${l2.id}, 'owner', now())`;
  // L1 也**必须**是 staff 行：§4.1 的"共现"只认 `*_staff` 成员，**不认 owner/creator**。
  // L1 是这条事项的 created_by，光靠 creator 身份不算共现——所以这里补一行 staff，
  // 才测得到"共现过 ⇒ 选得到"这个正面分支。
  await sql`insert into mn_risk_matter_staff (id, risk_matter_id, user_id, staff_role, created_at)
            values (${BigInt(Date.now() * 1000) + 6n}, ${riskId}, ${l1.id}, 'co_owner', now())`;

  // 1) 端点存在且要宿主上下文
  const sel1 = await call("GET", `/api/risk-matters/${riskId}/selectable-users`, c1.cookie);
  ok("L1 取可选处理人 200", sel1.status === 200, `status=${sel1.status}`);
  const users1 = sel1.body?.users ?? [];
  ok("返回是数组且带中文名与 id", Array.isArray(users1) && users1.length > 0
      && users1.every((u) => u.id && u.displayName), `n=${users1.length}`);

  // 2) L1 能看到全部三个（自身 + L2 + stranger），L2 不能看到 stranger
  const has = (list, id) => list.some((u) => u.id === String(id));
  ok("L1 可见全部在册同事（L1=all）", has(users1, l1.id) && has(users1, l2.id) && has(users1, stranger.id),
     `返回 ${users1.length} 人`);

  const sel2 = await call("GET", `/api/risk-matters/${riskId}/selectable-users`, c2.cookie);
  const users2 = sel2.body?.users ?? [];
  ok("L2 取可选处理人 200", sel2.status === 200, `status=${sel2.status}`);
  ok("L2 能选到自己", has(users2, l2.id), "");
  ok("L2 能选 L1（与它共现于同一事项的 staff）", has(users2, l1.id), "");
  ok(
    "L2 **选不到**只有 creator 身份、无 staff 行的 stranger（§4.1 只认 *_staff）",
    !has(users2, stranger.id),
    `返回 ${users2.length} 人`,
  );

  // 3) 不可见的宿主 → 404，不给"存在但无权"的信号（元规则 3）
  const selStranger = await call("GET", `/api/risk-matters/${riskId}/selectable-users`, c3.cookie);
  ok("看不见该事项的账号拿到 404", selStranger.status === 404, `status=${selStranger.status}`);

  // 4) 裸 /users 不提供（§4.1 明写第一期不提供）
  //
  // ⚠ 这条断言**改过一次**，原因值得记：它原先断言 `404 || 405`（"接口不存在"），
  //   写于 `/api/users` 尚未建的时候。MATT-10 按自己的 AC 建了它——AC 原文是
  //   "**不得提供裸的用户列表接口**……只有持「管理账号」特权者的管理页可读企业内全部用户"。
  //   所以接口**按设计存在**，但普通账号拿不到花名册。
  //   要断的是**实质**（拿不到名单），不是"路径不存在"：404 与 403 都合格，唯独 200 不行。
  //   把状态码钉死成 404 会让这条门禁在"设计如此"的改动下变红——而它一红，
  //   人就会去改断言，于是真正该守的那条（拿不到名单）反而没人看。
  const bare = await call("GET", "/api/users", c1.cookie);
  const bareBody = JSON.stringify(bare.body ?? "");
  ok(
    "裸 /users 不提供花名册（403/404 皆可，唯独不能 200）",
    bare.status !== 200 && (bare.status === 403 || bare.status === 404),
    `status=${bare.status} body=${bareBody.slice(0, 80)}`,
  );
  ok(
    "非 200 时响应体里没有用户行",
    bare.status === 200 || !/username|displayName|"items"/.test(bareBody),
    `body=${bareBody.slice(0, 80)}`,
  );

  // 5) ★ 写路径收窄：L2 直接 PATCH 一个它**选不到**的 ownerId，必须被拒
  const bypass = await call("PATCH", `/api/risk-matters/${riskId}`, c2.cookie, {
    ownerId: String(stranger.id),
  });
  ok(
    "L2 直接 PATCH 无共现者被拒（绕过界面也不行）",
    bypass.status >= 400,
    `status=${bypass.status}${bypass.status < 400 ? " ⚠ 收窄被绕过了" : ""}`,
  );
  const after = await sql`select owner_id from mn_risk_matter where id = ${riskId}`;
  ok("被拒后 owner_id 未被改写", after[0].owner_id === null,
     `owner_id=${after[0].owner_id}`);

  // 6) 正向：L2 派给自己，必须成功
  const good = await call("PATCH", `/api/risk-matters/${riskId}`, c2.cookie, { ownerId: String(l2.id) });
  ok("L2 派给自己成功", good.status === 200, `status=${good.status}`);
  const after2 = await sql`select owner_id from mn_risk_matter where id = ${riskId}`;
  ok("owner_id 已写成 L2", String(after2[0].owner_id) === String(l2.id), `owner_id=${after2[0].owner_id}`);

  // 7) §6 三个条件：`pending` 账号不可被加
  const [pend] = await sql`
    insert into mn_app_user (id, username, display_name, password_hash, is_enabled, is_admin, activation_status, created_at, updated_at)
    values (${BigInt(Date.now() * 1000) + 9n}, ${"mn_smoke_pend_" + Date.now().toString(36)},
            ${"待开通探针"}, ${"x"}, true, false, 'pending', now(), now()) returning id`;
  const sel3 = await call("GET", `/api/risk-matters/${riskId}/selectable-users`, c1.cookie);
  ok("L1 的可选集里不含 pending 账号（§6 条件二）",
     !(sel3.body?.users ?? []).some((u) => u.id === String(pend.id)), "");
  const pendAssign = await call("PATCH", `/api/risk-matters/${riskId}`, c1.cookie, { ownerId: String(pend.id) });
  ok("把 pending 指派为处理人被拒（防绕过批准）", pendAssign.status >= 400, `status=${pendAssign.status}`);

  // 8) §4.1 规格外补的一条：软删账号不可被派活（F5 的另一面）
  await sql`update mn_app_user set is_deleted = true, deleted_at = now() where id = ${stranger.id}`;
  const sel4 = await call("GET", `/api/risk-matters/${riskId}/selectable-users`, c1.cookie);
  ok("软删账号不在可选集里（派活也不该派给离职的人）",
     !(sel4.body?.users ?? []).some((u) => u.id === String(stranger.id)), "");
  const delAssign = await call("PATCH", `/api/risk-matters/${riskId}`, c1.cookie, { ownerId: String(stranger.id) });
  ok("把软删账号指派为处理人被拒", delAssign.status >= 400, `status=${delAssign.status}`);
  await sql`update mn_app_user set is_deleted = false, deleted_at = null where id = ${stranger.id}`;

  // 9) 退回未指派仍然人人可用（这是"变更处理人"存在的意义）
  // 此刻 owner 是 L2（第 6 条设的），所以 PATCH null 是一个**真实变更**。
  // 别学我上一版：先在 SQL 里置成 null 再 PATCH null，那是"没有字段发生变化"，
  // 服务层判 422 empty —— 服务层是对的，用例是错的。
  const clear = await call("PATCH", `/api/risk-matters/${riskId}`, c1.cookie, { ownerId: null });
  ok("退回未指派：看得见的人就能置空", clear.status === 200, `status=${clear.status}`);
  const cleared = await sql`select owner_id from mn_risk_matter where id = ${riskId}`;
  ok("owner_id 已回到 null（未指派）", cleared[0].owner_id === null, `owner_id=${cleared[0].owner_id}`);
} finally {
  /**
   * 清场**按 code 前缀**定位，不靠捕获的 `riskId`。
   *
   * 上一版靠 `if (riskId)`：一旦插事项那步之后任何地方抛错、`riskId` 还是 null，
   * 三个删除步骤会被整块跳过 → 事项、staff 行、活动日志全留着 → staff 行再把
   * 三个账号的删除卡住（`mn_risk_matter_staff.user_id` 是 NOT NULL + RESTRICT）。
   * 实测反向红那轮就是这样漏了 6 个账号 + 1 条事项。
   * 按前缀清则与"这轮跑到哪一步"无关，跑一半被打断也能收干净。
   *
   * 顺序有讲究：staff 行与活动日志都是 RESTRICT，必须先于事项删。
   *
   * ⚠ 子查询**每处内联一次**，不要抽成一个查询对象复用：postgres.js 的 query 片段
   *   是一次性的，第二次插入会渲染成 `syntax error at or near "select"`。
   *   （这个坑我自己踩过——抽了个 `sel` 变量给三条语句用，三条全炸。）
   */
  await step("删自己插的 staff 行", () =>
    sql`delete from mn_risk_matter_staff
         where risk_matter_id in (select id from mn_risk_matter where code like 'SEL-%')`,
  );
  await step("删该事项的活动日志", () =>
    sql`delete from mn_activity_log
         where risk_matter_id in (select id from mn_risk_matter where code like 'SEL-%')`,
  );
  await step("删探针事项", () => sql`delete from mn_risk_matter where code like 'SEL-%'`);
  await step("删 pending 探针账号", () =>
    sql`delete from mn_app_user where username like 'mn_smoke_pend_%'`,
  );
  // 账号顺序无关：三个探针账号之间无引用关系
  for (const a of [l1, l2, stranger]) {
    if (a) await step(`删账号 ${a.username}`, () => dropSmokeAccount(sql, a.id));
  }
  await step("断开数据库", () => sql.end());
}

console.log(`\nPASS：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);