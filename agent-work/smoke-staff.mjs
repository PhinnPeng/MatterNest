import { createSmokeAccount, dropSmokeAccount, ROLE_CODES } from "./_testacct.mjs";
/**
 * 参与人选择面与写路径的真 HTTP 冒烟（MATT-49 / 权限草案 §4.1 + §6 + IQ-14）。
 *
 * 票面的四条硬要求，每条都配**能红**的断言：
 *  ① 案件详情页的参与人选择面可用，且遵守与事项侧同一套收窄规则；
 *  ② 创建期例外（IQ-14）：新建表单的选人面放开为全体在册可用用户；
 *  ③ **收窄落在写路径**，不只在下拉——绕过界面直接提交一个不在选择面内的 id 必须失败；
 *  ④ 软删 / 停用 / 待开通的账号不进入任何选择面，**也不得被指派**。
 *
 * 关键设计：要让"收窄"这条可判，必须有一个**窄范围但又是名单管理者**的账号。
 * 用 L3（`self_operator`，owned 范围）自己建一条案件——它既是创建人（§6 名单管理权），
 * 共现集又恰好只有它自己。L1 做对照：L1 的可选集是全公司。
 */
const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";

let pass = 0;
let fail = 0;
function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`[ ok ] ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function call(method, path, cookie, payload) {
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
}

async function login(username, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return { status: r.status, cookie: (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ") };
}

const stamp = Date.now();
const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

// 夹具：L1（全公司可见）+ L3（owned 范围，自己建案 ⇒ 共现集只有自己）+ L2（participating）
//
// ⚠ L2 与 L3 都要有，且**不能混用**：`visibility.ts` 明写 L3 = `我承办 ∪ 我创建`，
// **刻意不含 `*_staff` 的协办/关注行**。所以"把 L3 加成协办"之后，L3 依然看不见这条案件
// （本轮实测：拿到 404 而不是 403）——那是规格语义，不是缺陷。
// 要测"协办看得见名单、但改不了名单"，必须用 participating（L2）的账号。
const l1 = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
const l3 = await createSmokeAccount(sql, { roles: [ROLE_CODES.self] });
const l2 = await createSmokeAccount(sql, { roles: [ROLE_CODES.joined] });
// 三种"不可被指派"的账号：待开通 / 停用 / 软删
const mkState = async (label, mutate) => {
  const u = await createSmokeAccount(sql, { roles: [ROLE_CODES.joined] });
  await mutate(u.id);
  return u;
};
const pending = await mkState("pending", (id) =>
  sql`update mn_app_user set activation_status = 'pending' where id = ${id}`);
const disabled = await mkState("disabled", (id) =>
  sql`update mn_app_user set is_enabled = false where id = ${id}`);
const deleted = await mkState("deleted", (id) =>
  sql`update mn_app_user set is_deleted = true, deleted_at = now() where id = ${id}`);

const matterIds = [];
const riskIds = [];
const accountIds = [l1, l2, l3, pending, disabled, deleted].map((u) => u.id);

async function cleanup() {
  for (const id of matterIds) {
    await sql.unsafe(`delete from mn_activity_log where matter_id=${id}`).catch(() => {});
    // ⚠ 列名是 `matter_id` / `risk_matter_id`，不是 `host_id`（工厂 `staffTable` 里
    //    按宿主选列名：`const col = host === "matter" ? "matter_id" : "risk_matter_id"`）。
    //    drizzle 侧统一叫 `hostId`，但**裸 SQL 必须写真实列名**——本轮就是在这里踩的。
    await sql.unsafe(`delete from mn_matter_staff where matter_id=${id}`).catch(() => {});
    await sql.unsafe(`delete from mn_matter_node where matter_id=${id}`).catch(() => {});
    await sql.unsafe(`delete from mn_matter_party where matter_id=${id}`).catch(() => {});
    await sql.unsafe(`delete from mn_matter where id=${id}`).catch(() => {});
  }
  for (const id of riskIds) {
    await sql.unsafe(`delete from mn_activity_log where risk_matter_id=${id}`).catch(() => {});
    await sql.unsafe(`delete from mn_risk_matter_staff where risk_matter_id=${id}`).catch(() => {});
    await sql.unsafe(`delete from mn_risk_matter where id=${id}`).catch(() => {});
  }
  await sql`delete from mn_activity_log where operator_id = any(${sql.array(accountIds)}::bigint[])`;
  await sql`delete from mn_auth_session where user_id = any(${sql.array(accountIds)}::bigint[])`;
  await sql`delete from mn_app_user_role where user_id = any(${sql.array(accountIds)}::bigint[])`;
  // ⚠ **不许吞掉失败**：账号删不掉时必须喊出来。它删不掉通常意味着"还有业务行引用它"
  //   （外键 restrict 在正常工作），而孤儿账号的症状出现在**下一轮**——
  //   选择面里多出几个人、管理员数悄悄变成 2，归因却指向"上一轮某个冒烟"。
  //   本轮实测：探针抖动那几轮留下了 3 个孤儿，其中一个 is_admin=true。
  for (const u of [l1, l2, l3, pending, disabled, deleted]) {
    try {
      await dropSmokeAccount(sql, u.id);
    } catch (e) {
      console.log(`[clean] 删不掉 ${u.username} —— ${String(e.message).split("\n")[0]}`);
    }
  }
}

try {
  const l1s = await login(l1.username, l1.password);
  const l2s = await login(l2.username, l2.password);
  const l3s = await login(l3.username, l3.password);
  ok("三个夹具账号都能登录", l1s.status === 200 && l2s.status === 200 && l3s.status === 200, "");

  // 建两条案件：M1 由 L1 建（owner=L1），M2 由 L3 建（owner=L3 ⇒ L3 是创建人+经办人）
  const mkMatter = (cookie, name, ownerId) =>
    call("POST", "/api/matters", cookie, {
      name,
      cause: "建设工程施工合同纠纷",
      caseType: "civil_commercial",
      procedure: "first_instance",
      litigationRole: "defendant",
      level: "high",
      ...(ownerId ? { ownerId } : {}),
    });
  const mkMatterWithOwner = (cookie, name, ownerId) => mkMatter(cookie, name, ownerId);
  const m1 = await mkMatter(l1s.cookie, `选择面冒烟 M1 ${stamp}`);
  const m2 = await mkMatter(l3s.cookie, `选择面冒烟 M2 ${stamp}`);
  ok("两条夹具案件都建出来了", m1.status === 201 && m2.status === 201, `m1=${m1.status} m2=${m2.status}`);
  matterIds.push(m1.body?.id, m2.body?.id);

  // ---- ① 选择面：同一套收窄规则 ----
  const sel1 = await call("GET", `/api/matters/${m1.body.id}/selectable-users`, l1s.cookie);
  const sel1Ids = (sel1.body?.users ?? []).map((u) => u.id);
  ok("L1 的选择面 → 200", sel1.status === 200, `status=${sel1.status}`);
  ok(
    "**L1 的选择面含全公司可用用户**（含 L3）",
    sel1Ids.includes(String(l3.id)),
    `n=${sel1Ids.length}`,
  );
  ok(
    "**L1 的选择面不含待开通/停用/软删的账号**",
    ![pending, disabled, deleted].some((u) => sel1Ids.includes(String(u.id))),
    `pending=${sel1Ids.includes(String(pending.id))} disabled=${sel1Ids.includes(String(disabled.id))} deleted=${sel1Ids.includes(String(deleted.id))}`,
  );

  const sel1AsL3 = await call("GET", `/api/matters/${m1.body.id}/selectable-users`, l3s.cookie);
  ok(
    "**看不见的案件 → 404**（不给「存在但你无权选人」这种可区分信号）",
    sel1AsL3.status === 404,
    `status=${sel1AsL3.status}`,
  );

  const sel2 = await call("GET", `/api/matters/${m2.body.id}/selectable-users`, l3s.cookie);
  const sel2Ids = (sel2.body?.users ?? []).map((u) => u.id);
  ok("L3 在自己建的案件上能选人 → 200", sel2.status === 200, `status=${sel2.status}`);
  ok(
    "**L3 的选择面只有它自己**（共现集为空；L1 不在里面）",
    sel2Ids.length === 1 && sel2Ids[0] === String(l3.id),
    `ids=${sel2Ids.join(",")}`,
  );

  // ---- ③ 收窄落在写路径：L3 是创建人（有名单管理权）但可见集窄 ----
  const stealAdd = await call("POST", `/api/matters/${m2.body.id}/staff`, l3s.cookie, {
    userIds: [String(l1.id)],
    staffRole: "co_owner",
  });
  ok(
    "**不在可见集内的人 → 422 not_selectable**（有管理权 ≠ 能加任何人）",
    stealAdd.status === 422 && stealAdd.body?.error === "not_selectable",
    `status=${stealAdd.status} err=${stealAdd.body?.error}`,
  );
  ok(
    "**拒绝文案不回显是谁不合格**（回显等于把端点变成花名册探测面）",
    !String(stealAdd.body?.message ?? "").includes(l1.username),
    String(stealAdd.body?.message ?? "").slice(0, 60),
  );

  // ---- ④ 在册可用：停用/待开通/软删都不得被指派 ----
  for (const [label, u] of [
    ["待开通", pending],
    ["停用", disabled],
    ["软删", deleted],
  ]) {
    const r = await call("POST", `/api/matters/${m1.body.id}/staff`, l1s.cookie, {
      userIds: [String(u.id)],
      staffRole: "co_owner",
    });
    ok(
      `**${label}账号不得被指派 → 422 not_selectable**`,
      r.status === 422 && r.body?.error === "not_selectable",
      `status=${r.status} err=${r.body?.error}`,
    );
  }

  // ---- 正常加人 + 审计 ----
  const addOk = await call("POST", `/api/matters/${m1.body.id}/staff`, l1s.cookie, {
    userIds: [String(l2.id)],
    staffRole: "co_owner",
  });
  ok("加协办 → 200 且 added=1", addOk.status === 200 && addOk.body?.added === 1, JSON.stringify(addOk.body));
  const [staffAudit] = await sql`
    select payload from mn_activity_log
    where action='STAFF_CHANGED' and matter_id=${m1.body.id} order by created_at desc limit 1`;
  ok(
    "写了 STAFF_CHANGED 审计（载荷记 added/role）",
    staffAudit?.payload?.role === "co_owner" && (staffAudit?.payload?.added ?? []).includes(String(l2.id)),
    JSON.stringify(staffAudit?.payload)?.slice(0, 80),
  );
  const again = await call("POST", `/api/matters/${m1.body.id}/staff`, l1s.cookie, {
    userIds: [String(l2.id)],
    staffRole: "co_owner",
  });
  ok(
    "重复加同一个人 → 幂等（added=0 且 skipped 点名）",
    again.status === 200 && again.body?.added === 0 && (again.body?.skipped ?? []).includes(String(l2.id)),
    JSON.stringify(again.body),
  );

  // ---- ② §6 名单管理权：协办看得见名单，但改不了 ----
  const asCoOwner = await call("POST", `/api/matters/${m1.body.id}/staff`, l2s.cookie, {
    userIds: [String(l2.id)],
    staffRole: "follower",
  });
  ok(
    "**协办（非经办人/非创建人/非 L1）改名单 → 403 forbidden**",
    asCoOwner.status === 403 && asCoOwner.body?.error === "forbidden",
    `status=${asCoOwner.status} err=${asCoOwner.body?.error}`,
  );
  const listAsCoOwner = await call("GET", `/api/matters/${m1.body.id}/staff`, l2s.cookie);
  ok("但协办**读得到**名单（只读不等于看不见谁在办）", listAsCoOwner.status === 200, `status=${listAsCoOwner.status}`);

  // ---- owner 不能从名单里摘 ----
  const rmOwner = await call(
    "DELETE",
    `/api/matters/${m1.body.id}/staff/${m1.body.ownerId ?? l1.id}`,
    l1s.cookie,
  );
  ok(
    "**摘当前经办人 → 403 owner_protected**",
    rmOwner.status === 403 && rmOwner.body?.error === "owner_protected",
    `status=${rmOwner.status} err=${rmOwner.body?.error}`,
  );
  const rmCo = await call("DELETE", `/api/matters/${m1.body.id}/staff/${l2.id}`, l1s.cookie);
  ok("摘协办 → 200 removed=1", rmCo.status === 200 && rmCo.body?.removed === 1, JSON.stringify(rmCo.body));

  // ---- 角色白名单：owner 不从这条路口子进 ----
  const asOwnerRole = await call("POST", `/api/matters/${m1.body.id}/staff`, l1s.cookie, {
    userIds: [String(l2.id)],
    staffRole: "owner",
  });
  ok(
    "**staffRole=owner → 400**（换负责人是字段编辑，不从这里开第二条路）",
    asOwnerRole.status === 400,
    `status=${asOwnerRole.status}`,
  );

  // ---- ② 创建期例外：全体在册可用用户，不受共现集限制 ----
  const createSel = await call("GET", "/api/selectable-users", l3s.cookie);
  const createIds = (createSel.body?.users ?? []).map((u) => u.id);
  ok("创建期选人面 → 200", createSel.status === 200, `status=${createSel.status}`);
  ok(
    "**L3 在创建期能看到 L1**（创建期例外不受共现集限制）",
    createIds.includes(String(l1.id)),
    `n=${createIds.length}`,
  );
  ok(
    "**创建期也排除待开通/停用/软删**",
    ![pending, disabled, deleted].some((u) => createIds.includes(String(u.id))),
    `pending=${createIds.includes(String(pending.id))} disabled=${createIds.includes(String(disabled.id))} deleted=${createIds.includes(String(deleted.id))}`,
  );

  // ---- 创建路径的写校验：被指派者不合格 → 422（两侧宿主各一条）----
  const badMatter = await mkMatterWithOwner(l1s.cookie, `停用经办人案件 ${stamp}`, String(disabled.id));
  ok(
    "**建案时指定停用账号为负责人 → 422 not_selectable**",
    badMatter.status === 422 && badMatter.body?.error === "not_selectable",
    `status=${badMatter.status} err=${badMatter.body?.error}`,
  );
  const badRisk = await call("POST", "/api/risk-matters", l1s.cookie, {
    name: `软删经办人事项 ${stamp}`,
    type: "contract",
    level: "high",
    description: "冒烟：被指派者已软删",
    ownerId: String(deleted.id),
  });
  ok(
    "**建事项时指定软删账号为负责人 → 422 not_selectable**",
    badRisk.status === 422 && badRisk.body?.error === "not_selectable",
    `status=${badRisk.status} err=${badRisk.body?.error}`,
  );

  // ---- 创建期的关注人（IQ-5 表单可选填 + IQ-14 例外）----
  const mWithFollower = await call("POST", "/api/matters", l1s.cookie, {
    name: `带关注人的案件 ${stamp}`,
    cause: "买卖合同纠纷",
    caseType: "civil_commercial",
    procedure: "first_instance",
    litigationRole: "plaintiff",
    level: "high",
    followerIds: [String(l2.id), String(l2.id)], // 故意重复：去重是服务层的事
  });
  ok("建案时带关注人 → 201", mWithFollower.status === 201, `status=${mWithFollower.status}`);
  if (mWithFollower.status === 201) {
    matterIds.push(mWithFollower.body.id);
    const [fc] = await sql`
      select count(*)::int n from mn_matter_staff
      where matter_id=${mWithFollower.body.id} and staff_role='follower'`;
    ok("**关注人真的落库且去重**（重复 id 只插一行）", fc.n === 1, `follower 行=${fc.n}`);
    const detail = await call("GET", `/api/matters/${mWithFollower.body.id}`, l1s.cookie);
    ok(
      "详情里能看到关注人（与 owner/协办同源同一张 staff 表）",
      (detail.body?.staff ?? []).some((s) => s.userId === String(l2.id)),
      `staff 角色=${(detail.body?.staff ?? []).map((s) => s.staffRole).join(",")}`,
    );
  }
  const rWithFollower = await call("POST", "/api/risk-matters", l1s.cookie, {
    name: `带关注人的事项 ${stamp}`,
    type: "contract",
    level: "high",
    description: "冒烟：创建时带关注人",
    followerIds: [String(l2.id)],
  });
  ok("建事项时带关注人 → 201", rWithFollower.status === 201, `status=${rWithFollower.status}`);
  if (rWithFollower.status === 201) {
    riskIds.push(rWithFollower.body.id);
    const [fc] = await sql`
      select count(*)::int n from mn_risk_matter_staff
      where risk_matter_id=${rWithFollower.body.id} and staff_role='follower'`;
    ok("事项的关注人也落库了", fc.n === 1, `follower 行=${fc.n}`);
  }
  const badFollower = await call("POST", "/api/matters", l1s.cookie, {
    name: `停用关注人的案件 ${stamp}`,
    cause: "买卖合同纠纷",
    caseType: "civil_commercial",
    procedure: "first_instance",
    litigationRole: "plaintiff",
    level: "high",
    followerIds: [String(disabled.id)],
  });
  ok(
    "**创建时把停用账号设为关注人 → 422 not_selectable**（关注人不是免检通道）",
    badFollower.status === 422 && badFollower.body?.error === "not_selectable",
    `status=${badFollower.status} err=${badFollower.body?.error}`,
  );

  // ---- 归档态：名单仍可读，写一律拒 ----
  const arch = await call("POST", `/api/matters/${m1.body.id}/status`, l1s.cookie, {
    to: "archived",
    reason: "冒烟：归档后试写名单",
  });
  ok("把案件归档 → 200", arch.status === 200, `status=${arch.status}`);
  const addArchived = await call("POST", `/api/matters/${m1.body.id}/staff`, l1s.cookie, {
    userIds: [String(l2.id)],
    staffRole: "follower",
  });
  ok(
    "**归档后加人 → 403 archived**（归档是只读终态）",
    addArchived.status === 403 && addArchived.body?.error === "archived",
    `status=${addArchived.status} err=${addArchived.body?.error}`,
  );
} catch (e) {
  fail++;
  console.log(`[FAIL] 脚本中断 —— ${e?.stack ?? e}`);
} finally {
  try {
    await cleanup();
    console.log("[clean] 清场完成");
  } catch (e) {
    console.log(`[clean] 清场失败 —— ${e?.message ?? e}`);
  }
  await sql.end();
}

console.log(`\n${fail ? "FAIL" : "PASS"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
