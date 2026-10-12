/**
 * 事项侧成链的真 HTTP 冒烟（T1）：详情 · 状态 · 处置记录 · 手动节点 · 归档 · 软删。
 *
 * 只走 HTTP，不直接写库——T10 把"没有入口只能写库"那段补掉了，
 * 这条链现在必须能纯靠接口跑通。若哪一步又需要写库，说明产品又缺了东西。
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

async function login(username, password = username) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, cookie };
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

const stamp = Date.now();
const l1 = await login("wangkf"); // 全局管理 L1（持 can_unarchive）
ok("L1 登录", l1.status === 200, `status=${l1.status}`);
const cookie = l1.cookie;

const createdRiskIds = new Set();
const createdMatterIds = new Set();
const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

async function cleanup() {
  const rids = [...createdRiskIds].map(BigInt);
  const mids = [...createdMatterIds].map(BigInt);
  if (rids.length) {
    await sql`delete from mn_activity_log where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
    await sql`delete from mn_comment where target_type='risk_matter' and target_id = any(${sql.array(rids)}::bigint[])`;
    await sql`delete from mn_risk_matter_node where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
    await sql`delete from mn_risk_matter_party where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
    await sql`delete from mn_risk_matter_staff where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
    await sql`delete from mn_risk_matter_case where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
    await sql`delete from mn_risk_matter where id = any(${sql.array(rids)}::bigint[])`;
  }
  if (mids.length) {
    await sql`delete from mn_activity_log where matter_id = any(${sql.array(mids)}::bigint[])`;
    await sql`delete from mn_matter_node where matter_id = any(${sql.array(mids)}::bigint[])`;
    await sql`delete from mn_matter_staff where matter_id = any(${sql.array(mids)}::bigint[])`;
    await sql`delete from mn_matter_party where matter_id = any(${sql.array(mids)}::bigint[])`;
    await sql`delete from mn_matter where id = any(${sql.array(mids)}::bigint[])`;
  }
  await sql`delete from mn_party where name like ${`%${stamp}%`}`;
}

try {
  // ---- 1. 建事项：不填经办人（IQ-5 事项侧 owner 可空）----
  const created = await call("POST", "/api/risk-matters", cookie, {
    name: `T1 冒烟事项 ${stamp}`,
    type: "contract",
    level: "high",
    description: "冒烟：事项侧成链",
  });
  ok("建事项（不填经办人）→ 201", created.status === 201, `status=${created.status}`);
  const riskId = created.body?.id;
  createdRiskIds.add(riskId);

  // ---- 2. 详情：块齐、无预设节点、状态取事项侧那一套 ----
  const detail = await call("GET", `/api/risk-matters/${riskId}`, cookie);
  ok("详情 → 200", detail.status === 200, `status=${detail.status}`);
  const d = detail.body ?? {};
  ok("详情含全部块", ["nodes", "staff", "parties", "comments", "activity", "statuses", "convertedCases"].every((k) => Array.isArray(d[k])), Object.keys(d).join(","));
  ok("**新建事项节点数为 0**（IQ-5 无预设节点）", d.nodes?.length === 0, `nodes=${d.nodes?.length}`);
  ok("状态取事项侧那一套（了结而非已结案）", (d.statuses ?? []).some((s) => s.code === "closed" && s.name === "了结"), (d.statuses ?? []).map((s) => s.code + "=" + s.name).join(" "));
  ok("**经办人为空**（owner 可空）", d.ownerId === null, `ownerId=${d.ownerId}`);
  ok("已转案件反查为空", d.convertedCases?.length === 0, `n=${d.convertedCases?.length}`);

  // ---- 3. 无主事项：任何人都能推状态（否则永久卡住）----
  const toProgress = await call("POST", `/api/risk-matters/${riskId}/status`, cookie, { to: "in_progress" });
  ok("无主事项可推状态（否则永久卡死）", toProgress.status === 200, `status=${toProgress.status} ${JSON.stringify(toProgress.body)?.slice(0, 70)}`);

  // ---- 4. 处置记录：发 / 编辑 / 已编辑标记 / 审计 ----
  const c1 = await call("POST", `/api/risk-matters/${riskId}/comments`, cookie, { body: "冒烟：第一条处置记录" });
  ok("发处置记录 → 201", c1.status === 201, `status=${c1.status}`);
  const commentId = c1.body?.id;
  const cEdit = await call("PATCH", `/api/risk-matters/${riskId}/comments?commentId=${commentId}`, cookie, { body: "冒烟：改过的内容" });
  ok("编辑自己的处置记录 → 200", cEdit.status === 200, `status=${cEdit.status}`);
  const d2 = await call("GET", `/api/risk-matters/${riskId}`, cookie);
  const mine = (d2.body?.comments ?? []).find((c) => c.id === commentId);
  ok("编辑后带 isEdited 标记（前端显示「已编辑」）", mine?.isEdited === true, `isEdited=${mine?.isEdited}`);
  ok("编辑后正文已更新", mine?.body === "冒烟：改过的内容", String(mine?.body));
  const [updAudit] = await sql`select count(*)::int as n from mn_activity_log where action='COMMENT_UPDATED' and risk_matter_id = ${riskId}`;
  ok("写了 COMMENT_UPDATED 审计", updAudit.n === 1, `n=${updAudit.n}`);

  // 编辑别人的 → 403（用 L2 账号试）
  const l2 = await login("suny");
  const cOther = await call("PATCH", `/api/risk-matters/${riskId}/comments?commentId=${commentId}`, l2.cookie, { body: "别人来改" });
  ok("编辑别人的处置记录 → 403（不可见则 404）", cOther.status === 403 || cOther.status === 404, `status=${cOther.status}`, );

  // ---- 5. 手动节点：只有时间点 ----
  const [pointType] = await sql`select id::text as id from mn_node_type_config where host_type='risk_matter' and time_type='point' limit 1`;
  const [rangeType] = await sql`select id::text as id from mn_node_type_config where host_type='risk_matter' and time_type='range' limit 1`;
  const n1 = await call("POST", `/api/risk-matters/${riskId}/nodes`, cookie, { nodeTypeId: pointType.id, startTime: "2026-11-01" });
  ok("手动加时间点节点 → 201", n1.status === 201, `status=${n1.status} ${JSON.stringify(n1.body)?.slice(0, 70)}`);
  const nodeId = n1.body?.id;

  // 案件侧的节点类型不能用来建事项节点
  const [matterType] = await sql`select id::text as id from mn_node_type_config where host_type='matter' limit 1`;
  const crossType = await call("POST", `/api/risk-matters/${riskId}/nodes`, cookie, { nodeTypeId: matterType.id });
  ok("拿案件侧节点类型建事项节点 → 404（类型与宿主不符）", crossType.status === 404, `status=${crossType.status}`);

  if (rangeType) {
    const range = await call("POST", `/api/risk-matters/${riskId}/nodes`, cookie, { nodeTypeId: rangeType.id });
    ok("时间段节点类型 → 422 range_not_allowed", range.status === 422 && range.body?.error === "range_not_allowed", `status=${range.status} err=${range.body?.error}`);
  } else {
    // 事项侧现在**没有任何 range 类型**（IQ-5），所以这条防御分支平时跑不到。
    // 跑不到的守卫等于没有——所以临时把一条配置翻成 range 来真跑它，finally 里还原。
    // 不改产品数据，只在一个事务式的"翻—测—翻回"里过一遍。
    await sql`update mn_node_type_config set time_type='range' where id = ${pointType.id}`;
    try {
      const range = await call("POST", `/api/risk-matters/${riskId}/nodes`, cookie, { nodeTypeId: pointType.id });
      ok("时间段节点类型 → 422 range_not_allowed（临时翻配置真跑）", range.status === 422 && range.body?.error === "range_not_allowed", `status=${range.status} err=${range.body?.error}`);
      const savedRange = await sql`select count(*)::int as n from mn_risk_matter_node where risk_matter_id=${riskId}`;
      ok("被拒后没有留下节点（没先建再报）", savedRange[0].n === 1, `节点数=${savedRange[0].n}`);
    } finally {
      await sql`update mn_node_type_config set time_type='point' where id = ${pointType.id}`;
    }
  }

  const d3 = await call("GET", `/api/risk-matters/${riskId}`, cookie);
  ok("节点已挂上且 source_kind=manual", (d3.body?.nodes ?? []).every((n) => n.sourceKind === "manual"), JSON.stringify((d3.body?.nodes ?? []).map((n) => n.sourceKind)));
  ok("节点全是时间点（无 endTime）", (d3.body?.nodes ?? []).every((n) => n.timeType === "point" && n.endTime === null), JSON.stringify((d3.body?.nodes ?? []).map((n) => n.timeType)));

  // ---- 6. 节点状态：完成 / 取消要原因 ----
  const done = await call("PATCH", `/api/risk-matters/${riskId}/nodes?nodeId=${nodeId}`, cookie, { status: "completed" });
  ok("节点置完成 → 200", done.status === 200, `status=${done.status}`);
  const noReason = await call("PATCH", `/api/risk-matters/${riskId}/nodes?nodeId=${nodeId}`, cookie, { status: "cancelled" });
  ok("取消节点不填原因 → 422 reason_required", noReason.status === 422, `status=${noReason.status}`);
  const withReason = await call("PATCH", `/api/risk-matters/${riskId}/nodes?nodeId=${nodeId}`, cookie, { status: "cancelled", cancelReason: "冒烟：不需要了" });
  ok("取消节点带原因 → 200", withReason.status === 200, `status=${withReason.status}`);

  // 串目标防护：拿别的事项的 id 配真 nodeId
  const other = await call("POST", "/api/risk-matters", cookie, { name: `T1 冒烟另一条 ${stamp}`, type: "contract", level: "mid", description: "冒烟" });
  createdRiskIds.add(other.body?.id);
  const crossNode = await call("PATCH", `/api/risk-matters/${other.body?.id}/nodes?nodeId=${nodeId}`, cookie, { status: "completed" });
  ok("父资源 id 对不上 → 404（不是 200）", crossNode.status === 404, `status=${crossNode.status}`);

  // ---- 7. 变更处理人：普通字段编辑 + OWNER_CHANGED ----
  // 取一个**与创建人不同**的用户：若取到创建人自己，这次编辑就是空操作（422 empty），
  // 断言会以"看不出问题"的方式通过——已经踩过一次。
  const [creator] = await sql`select id::text as id from mn_app_user where username='wangkf'`;
  const [u] = await sql`select id::text as id, display_name from mn_app_user
    where is_enabled and not is_deleted and id::text <> ${creator.id} order by id limit 1`;
  ok("拿到一个与创建人不同的用户作为新经办人", u?.id && u.id !== creator.id, `creator=${creator.id} 新=${u?.id}`);
  const setOwner = await call("PATCH", `/api/risk-matters/${riskId}`, cookie, { ownerId: u.id });
  ok("变更处理人 → 200", setOwner.status === 200, `status=${setOwner.status}`);
  const [ownerAudit] = await sql`select count(*)::int as n from mn_activity_log where action='OWNER_CHANGED' and risk_matter_id = ${riskId}`;
  ok("变更处理人沿用 OWNER_CHANGED（不新造审计动作）", ownerAudit.n === 1, `n=${ownerAudit.n}`);
  const d4 = await call("GET", `/api/risk-matters/${riskId}`, cookie);
  ok("详情能看到新经办人与其姓名", d4.body?.ownerId === u.id && typeof d4.body?.ownerName === "string", `ownerId=${d4.body?.ownerId} name=${d4.body?.ownerName}`);

  // 改字段也写 RISK_UPDATED
  const renamed = await call("PATCH", `/api/risk-matters/${riskId}`, cookie, { name: `T1 冒烟事项改名 ${stamp}` });
  ok("改主表字段 → 200", renamed.status === 200, `status=${renamed.status}`);
  const noop = await call("PATCH", `/api/risk-matters/${riskId}`, cookie, { name: `T1 冒烟事项改名 ${stamp}` });
  ok("没有变化时 → 422 empty（不假装改成功）", noop.status === 422, `status=${noop.status}`);

  // ---- 8. 归档：终态 + 特权守卫 ----
  const arch = await call("POST", `/api/risk-matters/${riskId}/status`, cookie, { to: "archived", reason: "冒烟：归档" });
  ok("归档 → 200", arch.status === 200, `status=${arch.status} ${JSON.stringify(arch.body)?.slice(0, 60)}`);
  const [archRow] = await sql`select is_archived, archived_at from mn_risk_matter where id = ${riskId}`;
  ok("归档同时翻 is_archived 与 archived_at", archRow.is_archived === true && archRow.archived_at !== null, `is_archived=${archRow.is_archived}`);

  const editArchived = await call("PATCH", `/api/risk-matters/${riskId}`, cookie, { name: "改归档的" });
  ok("归档是只读终态 → 403", editArchived.status === 403, `status=${editArchived.status}`);

  const l2unarch = await call("POST", `/api/risk-matters/${riskId}/status`, l2.cookie, { to: "in_progress", reason: "想撤归档" });
  ok("无 can_unarchive 者撤归档 → 403 或 404", l2unarch.status === 403 || l2unarch.status === 404, `status=${l2unarch.status}`);
  const [stillArch] = await sql`select is_archived from mn_risk_matter where id = ${riskId}`;
  ok("被拒后仍在归档态（没先改再报）", stillArch.is_archived === true, `is_archived=${stillArch.is_archived}`);

  const unarch = await call("POST", `/api/risk-matters/${riskId}/status`, cookie, { to: "in_progress", reason: "冒烟：撤归档" });
  ok("持 can_unarchive 撤归档 → 200", unarch.status === 200, `status=${unarch.status} ${JSON.stringify(unarch.body)?.slice(0, 60)}`);

  // ---- 9. 归档事项不能再转案件 ----
  const arch2 = await call("POST", `/api/risk-matters/${riskId}/status`, cookie, { to: "archived", reason: "再归档" });
  const conv = await call("POST", `/api/risk-matters/${riskId}/convert`, cookie, { cases: [{ name: `不该建成 ${stamp}`, cause: "合同纠纷", caseType: "civil_commercial", procedure: "first_instance", litigationRole: "defendant", level: "mid" }] });
  ok("归档事项转案件 → 422 archived", conv.status === 422 && conv.body?.error === "archived", `status=${conv.status} err=${conv.body?.error}`);
  await call("POST", `/api/risk-matters/${riskId}/status`, cookie, { to: "in_progress", reason: "撤归档" });

  // ---- 10. 软删：没有回收站界面 ----
  const del = await call("DELETE", `/api/risk-matters/${other.body?.id}`, cookie);
  ok("软删 → 200", del.status === 200, `status=${del.status}`);
  const afterDel = await call("GET", `/api/risk-matters/${other.body?.id}`, cookie);
  ok("软删后详情 → 404（普通用户不可见已删行）", afterDel.status === 404, `status=${afterDel.status}`);
  const [delRow] = await sql`select is_deleted from mn_risk_matter where id = ${other.body?.id}`;
  ok("软删是标记不是物理删除（库内可恢复）", delRow.is_deleted === true, `is_deleted=${delRow.is_deleted}`);

  // ---- 11. 不可见一律 404 ----
  const bad = await call("GET", "/api/risk-matters/abc", cookie);
  ok("非法 id → 400", bad.status === 400, `status=${bad.status}`);
  const gone = await call("GET", "/api/risk-matters/999999999999", cookie);
  ok("不存在 → 404（不是 403）", gone.status === 404, `status=${gone.status}`);

  // ---- 12. 「只看未指派处理人」筛选（T1 列表面）----
  // 必须验：事项侧经办人可空（IQ-5），而这个筛选器是 L1 找到"没人管的那些"的唯一入口。
  const unassigned = await call("POST", "/api/risk-matters", cookie, {
    name: `T1 未指派 ${stamp}`,
    type: "contract",
    level: "low",
    description: "冒烟：未指派处理人",
  });
  createdRiskIds.add(unassigned.body?.id);

  const onlyEmpty = await call("GET", "/api/risk-matters?page=1&pageSize=100&ownerEmpty=1", cookie);
  ok("ownerEmpty=1 → 200", onlyEmpty.status === 200, `status=${onlyEmpty.status}`);
  const listedIds = (onlyEmpty.body?.items ?? []).map((r) => r.id);
  ok("结果里能查到刚建的那条未指派事项", listedIds.includes(unassigned.body?.id), `n=${listedIds.length}`);
  ok(
    "**结果里全是未指派的**（已指派的被排除）",
    (onlyEmpty.body?.items ?? []).every((r) => r.ownerId === null),
    JSON.stringify((onlyEmpty.body?.items ?? []).map((r) => r.ownerId)),
  );

  const noFilter = await call("GET", "/api/risk-matters?page=1&pageSize=100", cookie);
  const allIds = (noFilter.body?.items ?? []).map((r) => r.id);
  ok(
    "两种结果集确实不同（加筛选后已指派的那条不见了）",
    allIds.includes(riskId) && !listedIds.includes(riskId),
    `全部 ${allIds.length} 条 / 未指派 ${listedIds.length} 条`,
  );

  const bogusEmpty = await call("GET", "/api/risk-matters?page=1&pageSize=20&ownerEmpty=yes", cookie);
  ok("ownerEmpty=yes → 400（值域只有 1/true）", bogusEmpty.status === 400, `status=${bogusEmpty.status}`);
} catch (err) {
  fail++;
  console.log(`[FAIL] 脚本中断 —— ${err?.message ?? err}`);
} finally {
  try {
    await cleanup();
    console.log("[clean] 清场完成");
  } catch (e) {
    console.log(`[clean] 清场失败（需手工查）—— ${e?.message ?? e}`);
  }
  await sql.end();
}

console.log(`\n${fail ? "FAIL" : "PASS"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);