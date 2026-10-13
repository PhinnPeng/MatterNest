import { createSmokeAccount, dropSmokeAccount, ROLE_CODES } from "./_testacct.mjs";

/**
 * 通知回音（MATT-41 / T4）的**真 HTTP 冒烟**。
 *
 * ## 跑法
 *
 *   node --env-file=.env agent-work/smoke-notifications.mjs     # dev server 在 3777（SMOKE_BASE 可覆盖）
 *
 * ## 先反向红一次（本仓纪律：没有反向红的冒烟等于没有冒烟）
 *
 *   node agent-work/revred-notifications.mjs creator-watch     # 注入"上报人入关注列表"
 *   node --env-file=.env agent-work/smoke-notifications.mjs    # ⇒ 必须红
 *   node agent-work/revred-notifications.mjs restore
 *   node --env-file=.env agent-work/smoke-notifications.mjs    # ⇒ 必须绿
 *
 * 多模式注入的完整清单见 `revred-notifications.mjs` 头部。
 *
 * ## 断言清单（票面 AC 逐条）
 *
 *   ① 状态变更 / 新评论推给**创建人**，且**不写 `user_watch` 行**（IQ-13-V5）
 *   ② 同批多条按 `dedupe_key` **聚合为一条**（一次转案件 2 个案件 → 1 条事件 + `merge_count=1`）
 *   ③ 通知中心：跨宿主倒序 / 不可见降级占位 / 未读计数**按可见行** / 标记已读
 *   ④ 节点到期扫描**只走带 `is_time_confirmed` 的 partial index 那一路**（含 EXPLAIN 佐证）
 *   ⑤ 通知文案时间一律 `Asia/Shanghai`（会话钉 UTC，差 8 小时）
 *   ⑥ 投递走 outbox 不直发；至少一次语义下**重放不产生第二条**
 *   ⑦ 归档记录不再产生新通知
 *
 * ## 夹具为什么有一部分走 SQL
 *
 * 节点的时间/确认位/`remind_days` 没有对应的写接口（`/api/risk-matters/[id]/nodes` 只建节点，
 * 案件侧连建节点都没有——预设节点由建案时实例化）。要构造"3 天后到期 + 已确认时间"
 * 这一档，只能直接改预设节点行。**被测的东西仍然是 HTTP**：扫描由
 * `GET /api/notifications` 触发的 `pumpNotifications()` 跑。
 */
const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";

let pass = 0;
let fail = 0;
const failedNames = [];
function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`[ ok ] ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    failedNames.push(name);
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function login(username, password) {
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

const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

/**
 * 前置探活：**隧道断了不是断言失败**。
 *
 * 共享 dev 机的端口映射是分钟级断续的（本仓反复踩过）。这里先探一次，
 * 连不上就带人话退出（exit 2），而不是让 20 条断言集体变红、
 * 然后把"隧道抖了一下"当成"代码坏了"去查。
 */
try {
  await sql`select 1`;
} catch (e) {
  console.error(
    `数据库连不上（${e?.message ?? e}）—— 隧道可能正在抖。\n` +
      `这不是断言失败：等一会儿重跑 \`node --env-file=.env agent-work/_tables.mjs\` 探活成功再来。`,
  );
  process.exit(2);
}

const stamp = Date.now();
const admin = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
const reporter = await createSmokeAccount(sql, { roles: [ROLE_CODES.self] });
const follower = await createSmokeAccount(sql, { roles: [ROLE_CODES.joined] });
const outsider = await createSmokeAccount(sql, { roles: [ROLE_CODES.self] });
const adminC = (await login(admin.username, admin.password)).cookie;
const reporterC = (await login(reporter.username, reporter.password)).cookie;
const followerC = (await login(follower.username, follower.password)).cookie;
const outsiderC = (await login(outsider.username, outsider.password)).cookie;

const riskIds = [];
const matterIds = [];
const partyIds = [];

/** 上海业务日（`YYYY-MM-DD`）。时区断言与扫描夹具都按它算，不用本机时区 */
function shanghaiDay(offsetDays = 0) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

console.log(`\n══ 夹具 ══`);
const riskRes = await call("POST", "/api/risk-matters", reporterC, {
  name: `冒烟回音事项-${stamp}`,
  type: "contract",
  level: "mid",
  description: "冒烟：上报人回音（MATT-41）",
  // 经办人 = admin（L1）：状态流转要过归属护栏（`ownsAttribution`）
  ownerId: String(admin.id),
  parties: [
    {
      name: `冒烟回音对手方-${stamp}`,
      type: "legal_person",
      partyRole: "defendant",
      idType: "unified_social_credit",
      idNumber: `91320100MA1X9${String(stamp).slice(-5)}A`,
    },
  ],
});
ok("夹具：上报人建事项 201", riskRes.status === 201, `status=${riskRes.status}`);
const riskId = riskRes.body?.id;
if (riskId) riskIds.push(riskId);
const [riskRow] = await sql`select code, created_by from mn_risk_matter where id = ${riskId}`;
ok(
  "夹具：事项创建人 = 上报人（created_by 落的是他）",
  String(riskRow?.created_by) === String(reporter.id),
  `created_by=${riskRow?.created_by} reporter=${reporter.id}`,
);

const matterRes = await call("POST", "/api/matters", adminC, {
  name: `冒烟回音案件-${stamp}`,
  cause: "买卖合同纠纷",
  caseType: "civil_commercial",
  procedure: "first_instance",
  litigationRole: "plaintiff",
  level: "mid",
  ownerId: String(admin.id),
});
ok("夹具：建案件 201", matterRes.status === 201, `status=${matterRes.status}`);
const matterId = matterRes.body?.id;
if (matterId) matterIds.push(matterId);

/* ── ① 状态变更推给创建人，且不写 user_watch ─────────────────────────────── */
console.log(`\n══ ① creator 收件人（状态变更） ══`);
const st1 = await call("POST", `/api/risk-matters/${riskId}/status`, adminC, { to: "in_progress" });
ok("状态变更 200", st1.status === 200, `status=${st1.status}`);

const repList1 = await call("GET", "/api/notifications", reporterC);
ok("上报人拿到通知中心 200", repList1.status === 200, `status=${repList1.status}`);
const stItem = repList1.body?.items?.find((i) => i.eventType === "status_changed");
ok("**上报人收到状态变更通知**（receivers 含 creator）", Boolean(stItem), `items=${repList1.body?.items?.length}`);
ok("通知可见（不是占位行）", stItem?.visible === true);
ok(
  "标题带事项编号",
  typeof stItem?.title === "string" && stItem.title.includes(riskRow?.code ?? "@@"),
  `title=${stItem?.title}`,
);
ok(
  "正文用**状态显示名**（已登记 → 进行中），不是 code",
  typeof stItem?.body === "string" && stItem.body.includes("已登记 → 进行中"),
  `body=${stItem?.body}`,
);
ok(
  "正文带操作人姓名",
  typeof stItem?.body === "string" &&
    stItem.body.includes(`冒烟临时账号 ${admin.username.slice(-6)}`),
  `body=${stItem?.body}`,
);

const [watchRows] = await sql`select count(*)::int as n from mn_user_watch where user_id = ${reporter.id}`;
ok("**不写 user_watch 行**（关注保持主动 star 才算，IQ-13-V5）", watchRows.n === 0, `n=${watchRows.n}`);

const [evSt] = await sql`
  select id, merge_count, recipient_count from mn_notification_event
  where event_type = 'status_changed' and host_id = ${riskId}`;
ok("事件行落库且收件人数 ≥ 1", evSt !== undefined && evSt.recipient_count >= 1, `recipient_count=${evSt?.recipient_count}`);

/* ── ⑥ 投递走 outbox 不直发（新评论） ───────────────────────────────────── */
console.log(`\n══ ⑥ 新评论：只落 outbox，不直发 ══`);
const cm1 = await call("POST", `/api/risk-matters/${riskId}/comments`, adminC, {
  body: "冒烟：这条评论应当先落 outbox",
});
ok("发评论 201", cm1.status === 201, `status=${cm1.status}`);
const commentId = cm1.body?.id;

const [obPending] = await sql`
  select count(*)::int as n from mn_event_outbox
  where event_type = 'comment_added' and payload->>'comment_id' = ${commentId} and published_at is null`;
ok("**业务事务只写 outbox**（评论已落库、事件还没生成）", obPending.n === 1, `未投递行=${obPending.n}`);

const [evBefore] = await sql`
  select count(*)::int as n from mn_notification_event
  where event_type = 'new_comment' and host_id = ${riskId}`;
ok("**不直发**：此刻还没有 new_comment 事件", evBefore.n === 0, `n=${evBefore.n}`);

const repList2 = await call("GET", "/api/notifications", reporterC);
const cmItem = repList2.body?.items?.find((i) => i.eventType === "new_comment");
ok("**上报人收到新评论通知**（消费者把 outbox 展开成事件）", Boolean(cmItem), `items=${repList2.body?.items?.length}`);
ok("评论通知正文带作者名与摘录", typeof cmItem?.body === "string" && cmItem.body.includes("冒烟临时账号"), `body=${cmItem?.body}`);
const [obAfter] = await sql`
  select published_at, attempts from mn_event_outbox where payload->>'comment_id' = ${commentId}`;
ok("outbox 行已打上投递时间戳（至少一次语义）", obAfter?.published_at !== null, `published_at=${obAfter?.published_at}`);

/* ── ② 同批多条按 dedupe_key 聚合为一条 ─────────────────────────────────── */
console.log(`\n══ ② 同批多条聚合（一次转案件 2 个案件） ══`);
const conv = await call("POST", `/api/risk-matters/${riskId}/convert`, adminC, {
  cases: [
    {
      name: `冒烟聚合案件 A-${stamp}`,
      cause: "买卖合同纠纷",
      caseType: "civil_commercial",
      procedure: "first_instance",
      litigationRole: "defendant",
      level: "high",
    },
    {
      name: `冒烟聚合案件 B-${stamp}`,
      cause: "买卖合同纠纷",
      caseType: "civil_commercial",
      procedure: "first_instance",
      litigationRole: "defendant",
      level: "high",
    },
  ],
});
ok("转案件 201（一次 2 个案件）", conv.status === 201, `status=${conv.status} ${JSON.stringify(conv.body)?.slice(0, 90)}`);
for (const c of conv.body?.cases ?? []) matterIds.push(c.id);

/**
 * ⚠ **先触发一次轮询再查库**。转案件只把 outbox 行写下去（这正是"不直发"），
 * 事件要等消费侧跑过才有。初版把断言写在这一步之前，于是"事件数=0"——
 * 那不是聚合没生效，是**被测的东西还没被触发**。这条注释留着，
 * 免得下一个人把顺序再写反一次。
 */
const pumpAfterConvert = await call("GET", "/api/notifications", reporterC);
ok("轮询（GET 通知中心）200", pumpAfterConvert.status === 200, `status=${pumpAfterConvert.status}`);

const convEvents = await sql`
  select id, merge_count, recipient_count, dedupe_key from mn_notification_event
  where event_type = 'risk_converted' and host_id = ${riskId}`;
ok(
  "**2 条意图聚合成 1 条事件**（同 batch_id + 同 target ⇒ 同一个 dedupe_key）",
  convEvents.length === 1,
  `事件数=${convEvents.length}`,
);
ok(
  "`merge_count = 1`（被吸收掉的原始条数，§7.2 口径）",
  convEvents[0]?.merge_count === 1,
  `merge_count=${convEvents[0]?.merge_count}`,
);
const repList3 = await call("GET", "/api/notifications", reporterC);
const convItems = (repList3.body?.items ?? []).filter((i) => i.eventType === "risk_converted");
ok("上报人的通知中心里也只有 1 条转案件通知", convItems.length === 1, `n=${convItems.length}`);

/* ── ⑥b 至少一次语义下的去重（重放同一条 outbox 行） ────────────────────── */
console.log(`\n══ ⑥b 至少一次：重放不产生第二条 ══`);
await sql`update mn_event_outbox set published_at = null where payload->>'comment_id' = ${commentId}`;
await call("GET", "/api/notifications", reporterC);
const [replayEvents] = await sql`
  select count(*)::int as n from mn_notification_event
  where event_type = 'new_comment' and host_id = ${riskId}`;
ok("**重放后事件数不变**（dedupe_key 唯一键吸收）", replayEvents.n === 1, `n=${replayEvents.n}`);
const [replayRow] = await sql`
  select merge_count from mn_notification_event where event_type = 'new_comment' and host_id = ${riskId}`;
ok("`merge_count` 记下这次吸收", replayRow?.merge_count === 1, `merge_count=${replayRow?.merge_count}`);
const [replayPub] = await sql`
  select published_at from mn_event_outbox where payload->>'comment_id' = ${commentId}`;
ok("重放的行重新打上投递时间戳", replayPub?.published_at !== null);

/* ── ③ 通知中心：跨宿主倒序 / 占位 / 未读按可见行 / 标记已读 ────────────── */
console.log(`\n══ ③ 通知中心 ══`);
await call("POST", `/api/matters/${matterId}/status`, adminC, { to: "in_progress" });
const adminList = await call("GET", "/api/notifications", adminC);
const adminItems = adminList.body?.items ?? [];
ok("跨宿主混在一条时间轴上（同时有 matter 与 risk_matter）", new Set(adminItems.map((i) => i.hostKind)).size >= 2, `hostKinds=${[...new Set(adminItems.map((i) => i.hostKind))].join(",")}`);
const sortedDesc = adminItems.every(
  (it, i) => i === 0 || Date.parse(adminItems[i - 1].createdAt) >= Date.parse(it.createdAt),
);
ok("**跨宿主倒序**（按事件时间从新到旧）", sortedDesc);

const addF = await call("POST", `/api/risk-matters/${riskId}/staff/followers`, adminC, {
  userIds: [String(follower.id)],
});
ok("把 follower 加进关注人 200", addF.status === 200, `status=${addF.status} ${JSON.stringify(addF.body)}`);
await call("POST", `/api/risk-matters/${riskId}/status`, adminC, { to: "closed" });

const fList1 = await call("GET", "/api/notifications", followerC);
const fItem = fList1.body?.items?.find((i) => i.visible && i.eventType === "status_changed");
ok("关注人收到状态变更（规则 2 的 follower 那一档）", Boolean(fItem), `items=${fList1.body?.items?.length}`);
ok("关注人此刻未读 ≥ 1", (fList1.body?.unread ?? 0) >= 1, `unread=${fList1.body?.unread}`);

const delF = await call(
  "DELETE",
  `/api/risk-matters/${riskId}/staff/followers/${follower.id}`,
  adminC,
);
ok("把 follower 移出关注人 200", delF.status === 200, `status=${delF.status}`);
const fList2 = await call("GET", "/api/notifications", followerC);
const fItems2 = fList2.body?.items ?? [];
const fPlaceholder = fItems2.find((i) => i.visible === false);
ok("**不可见降级占位**：行还在（不隐藏整行）", Boolean(fPlaceholder), `items=${fItems2.length}`);
ok("占位行标题是「无权查看的记录」", fPlaceholder?.title === "无权查看的记录", `title=${fPlaceholder?.title}`);
ok("占位行**不发摘要字段**（body/hostId 都是 null）", fPlaceholder?.body === null && fPlaceholder?.hostId === null);
ok(
  "**未读计数按可见行计**（占位行不算未读）",
  fList2.body?.unread === 0 && (fList2.body?.total ?? 0) >= 1,
  `unread=${fList2.body?.unread} total=${fList2.body?.total}`,
);

const uc1 = await call("GET", "/api/notifications/unread-count", adminC);
ok("未读计数接口可用", uc1.status === 200 && typeof uc1.body?.unread === "number", JSON.stringify(uc1.body));
const readAll = await call("POST", "/api/notifications/read", adminC, { all: true });
ok("标记全部已读", readAll.status === 200 && readAll.body?.updated >= 1, JSON.stringify(readAll.body));
const uc2 = await call("GET", "/api/notifications/unread-count", adminC);
ok("标记后未读归零", uc2.body?.unread === 0, `unread=${uc2.body?.unread}`);
const badRead1 = await call("POST", "/api/notifications/read", adminC, {});
ok("ids 与 all 都不给 → 400", badRead1.status === 400, `status=${badRead1.status}`);
const badRead2 = await call("POST", "/api/notifications/read", adminC, { all: true, ids: ["1"] });
ok("ids 与 all 同时给 → 400", badRead2.status === 400, `status=${badRead2.status}`);

/* ── ④ 节点到期扫描：只走带 is_time_confirmed 的 partial index ──────────── */
console.log(`\n══ ④ 节点到期扫描 ══`);
const shDate = shanghaiDay(3);
/** 上海 06:00 那一刻：它的 UTC 写法是**前一天 22:00**，正好用来区分时区口径 */
const deadlineIso = new Date(`${shDate}T06:00:00+08:00`).toISOString();
const utcWrong = `${new Date(deadlineIso).toISOString().slice(0, 10)} 22:00`;

await sql`
  update mn_matter_node n set start_time = ${deadlineIso}, is_time_confirmed = true,
    remind_days = '{3}', status = 'not_started'
  from mn_node_type_config c
  where c.id = n.node_type_id and n.matter_id = ${matterId} and c.code = 'filing'`;
await sql`
  update mn_matter_node n set start_time = ${deadlineIso}::timestamptz - interval '10 days',
    end_time = ${deadlineIso}, is_time_confirmed = true, remind_days = '{3}', status = 'not_started'
  from mn_node_type_config c
  where c.id = n.node_type_id and n.matter_id = ${matterId} and c.code = 'evidence'`;
await sql`
  update mn_matter_node n set start_time = ${deadlineIso}, is_time_confirmed = false,
    remind_days = '{3}', status = 'not_started'
  from mn_node_type_config c
  where c.id = n.node_type_id and n.matter_id = ${matterId} and c.code = 'hearing'`;
// 第 4 个：时间已确认但**已完成** —— 索引谓词的第二个条件要挡住它
const [judgmentType] = await sql`
  select id from mn_node_type_config where host_type = 'matter' and code = 'judgment' limit 1`;
const completedNodeId = (BigInt(Date.now()) * 1000n + 7n).toString();
await sql`
  insert into mn_matter_node (id, matter_id, node_type_id, name, time_type, start_time,
    is_time_confirmed, remind_days, status, source_kind, sort_order, created_at, updated_at)
  values (${completedNodeId}, ${matterId}, ${judgmentType.id}, '冒烟已完成节点', 'point',
    ${deadlineIso}, true, '{3}', 'completed', 'manual', 99, now(), now())`;

const nodeIds = await sql`
  select n.id, c.code from mn_matter_node n join mn_node_type_config c on c.id = n.node_type_id
  where n.matter_id = ${matterId}`;
const idOf = (code) => String(nodeIds.find((r) => r.code === code)?.id ?? "");

// ⚠ 断言接口**返回 200**，而不只是"没有事件"：扫描器一旦在命中节点时抛错，
//    "零条事件"与"接口 500"在下面那些断言里长得一模一样（本轮的 uuid 缺陷就是这样藏了一轮）
const pumpScan = await call("GET", "/api/notifications", adminC);
ok("轮询（GET 通知中心）200 —— 扫描命中节点时不许 500", pumpScan.status === 200, `status=${pumpScan.status}`);
const dueEvents = await sql`
  select event_type, target_id, payload, dedupe_key from mn_notification_event
  where event_type in ('node_due_start','node_due_end') and target_id in ${sql([idOf("filing"), idOf("evidence"), idOf("hearing"), completedNodeId])}`;
ok(
  "**时间已确认的到期节点各出一条**（point→node_due_start，range→node_due_end）",
  dueEvents.length === 2,
  `事件数=${dueEvents.length}（${dueEvents.map((e) => e.event_type).join(",")}）`,
);
ok(
  "point 节点给 node_due_start",
  dueEvents.some((e) => e.event_type === "node_due_start" && String(e.target_id) === idOf("filing")),
);
ok(
  "range 节点给 node_due_end",
  dueEvents.some((e) => e.event_type === "node_due_end" && String(e.target_id) === idOf("evidence")),
);
ok(
  "**is_time_confirmed=false 的节点不提醒**（partial index 的谓词那一路）",
  !dueEvents.some((e) => String(e.target_id) === idOf("hearing")),
);
ok(
  "**已完成节点不提醒**（索引谓词的 status IN (...) 那一路）",
  !dueEvents.some((e) => String(e.target_id) === completedNodeId),
);

// 幂等：同一天重扫不该出第二条（scheduled key = 事件:节点:业务日）
await call("GET", "/api/notifications", adminC);
const [dueEvents2] = await sql`
  select count(*)::int as n from mn_notification_event
  where event_type in ('node_due_start','node_due_end') and target_id in ${sql([idOf("filing"), idOf("evidence"), idOf("hearing"), completedNodeId])}`;
ok("同一天重扫不产生第二条（scheduled dedupe_key 含业务日）", dueEvents2.n === 2, `n=${dueEvents2.n}`);

// EXPLAIN：证明这个查询形状**能**走 partial index（关掉 seqscan 让它必须选一个索引）
const windowStart = new Date(`${shanghaiDay(0)}T00:00:00+08:00`).toISOString();
const windowEnd = new Date(`${shanghaiDay(400)}T00:00:00+08:00`).toISOString();
const plan = await sql.begin(async (tx) => {
  await tx.unsafe("set local enable_seqscan = off");
  return tx.unsafe(
    `explain select id from mn_matter_node
       where is_time_confirmed and status in ('not_started','in_progress')
         and deadline_time >= $1 and deadline_time < $2 and not is_deleted`,
    [windowStart, windowEnd],
  );
});
const planText = plan.map((r) => r["QUERY PLAN"]).join(" | ");
ok(
  "EXPLAIN：扫描谓词命中 `ix_mn_matter_node_scan`（partial index 那一路）",
  planText.includes("ix_mn_matter_node_scan"),
  planText.slice(0, 160),
);

/* ── ⑤ 时区：通知文案时间一律 Asia/Shanghai ─────────────────────────────── */
console.log(`\n══ ⑤ 时区 ══`);
const adminList2 = await call("GET", "/api/notifications", adminC);
const nodeItem = (adminList2.body?.items ?? []).find((i) => i.eventType === "node_due_start");
ok(
  `正文里的期限是**上海时间** ${shDate} 06:00`,
  typeof nodeItem?.body === "string" && nodeItem.body.includes(`${shDate} 06:00`),
  `body=${nodeItem?.body}`,
);
ok(
  `正文里**不出现** UTC 写法（${utcWrong}）—— 会话钉 UTC，直接格式化就差 8 小时`,
  typeof nodeItem?.body === "string" && !nodeItem.body.includes(utcWrong),
  `body=${nodeItem?.body}`,
);

/* ── ⑦ 归档记录不再产生新通知 ───────────────────────────────────────────── */
console.log(`\n══ ⑦ 归档记录不再产生新通知 ══`);
const [beforeArchive] = await sql`
  select count(*)::int as n from mn_notification_event where host_id = ${matterId}`;
const arch = await call("POST", `/api/matters/${matterId}/status`, adminC, {
  to: "archived",
  reason: "冒烟：归档",
});
ok("归档案件 200", arch.status === 200, `status=${arch.status} ${JSON.stringify(arch.body)?.slice(0, 80)}`);
const [afterArchive] = await sql`
  select count(*)::int as n from mn_notification_event where host_id = ${matterId}`;
ok(
  "**归档这一步本身不发通知**（M4「什么时候不用」：归档记录不再产生新通知）",
  afterArchive.n === beforeArchive.n,
  `归档前=${beforeArchive.n} 归档后=${afterArchive.n}`,
);

const cmArch = await call("POST", `/api/matters/${matterId}/comments`, adminC, {
  body: "冒烟：归档后仍可评论，但不应发通知",
});
ok("归档后仍可新增评论（基线 1.7）", cmArch.status === 201, `status=${cmArch.status}`);
const [archOb] = await sql`
  select count(*)::int as n from mn_event_outbox where payload->>'comment_id' = ${cmArch.body?.id}`;
ok("**归档记录不写 outbox**（评论照写、通知不发）", archOb.n === 0, `outbox 行=${archOb.n}`);
await call("GET", "/api/notifications", adminC);
const [afterArchComment] = await sql`
  select count(*)::int as n from mn_notification_event where host_id = ${matterId}`;
ok("归档后评论不产生新通知", afterArchComment.n === beforeArchive.n, `n=${afterArchComment.n}`);

/* ── 旁证：不可见一律 404 ──────────────────────────────────────────────── */
console.log(`\n══ 旁证：数据范围 ══`);
const outDetail = await call("GET", `/api/matters/${matterId}`, outsiderC);
ok("无关的人看案件详情 404（元规则 3）", outDetail.status === 404, `status=${outDetail.status}`);
const outList = await call("GET", "/api/notifications", outsiderC);
ok("无关的人通知中心是空的", (outList.body?.items ?? []).length === 0 && outList.body?.unread === 0);

/* ── 清场 ──────────────────────────────────────────────────────────────── */
console.log(`\n══ 清场 ══`);
const allUsers = [admin.id, reporter.id, follower.id, outsider.id].map(String);
await sql`delete from mn_notification_delivery where user_id in ${sql(allUsers)}`;
await sql`delete from mn_notification_delivery where event_id in (select id from mn_notification_event where host_id in ${sql([...riskIds, ...matterIds])})`;
await sql`delete from mn_notification_event where host_id in ${sql([...riskIds, ...matterIds])}`;
await sql`delete from mn_event_outbox where payload->>'risk_matter_id' in ${sql(riskIds)}`;
await sql`delete from mn_event_outbox where payload->>'host_id' in ${sql(riskIds)}`;
await sql`delete from mn_comment where target_id in ${sql([...riskIds, ...matterIds])}`;
await sql`delete from mn_activity_log where matter_id in ${sql(matterIds)} or risk_matter_id in ${sql(riskIds)}`;
await sql`delete from mn_matter_staff where matter_id in ${sql(matterIds)}`;
await sql`delete from mn_risk_matter_staff where risk_matter_id in ${sql(riskIds)}`;
await sql`delete from mn_matter_node where matter_id in ${sql(matterIds)}`;
await sql`delete from mn_matter_party where matter_id in ${sql(matterIds)}`;
await sql`delete from mn_risk_matter_party where risk_matter_id in ${sql(riskIds)}`;
await sql`delete from mn_risk_matter_case where risk_matter_id in ${sql(riskIds)}`;
await sql`delete from mn_matter where id in ${sql(matterIds)}`;
await sql`delete from mn_risk_matter where id in ${sql(riskIds)}`;
await sql`delete from mn_user_watch where user_id in ${sql(allUsers)}`;
await sql`delete from mn_party where name like ${"冒烟回音对手方-" + stamp + "%"}`;

/**
 * **孤儿事件清扫**（范围外发现的副产物，2026-10-14）。
 *
 * 本票把通知的**生产点**接进了 `changeStatus` / `addComment` 之后，**别的票的冒烟**
 * （批量改状态、转案件、发评论）也会经由这两条路径产生 `mn_notification_event` 行——
 * 而它们的清场脚本不认识这两张新表（`_cleanup_smoke_accounts.mjs` 认识
 * `mn_notification_delivery` / `mn_user_watch`，**不认识 event**，而 event 对
 * `app_user` 没有外键、宿主列也是多态的，所以谁都不会连带删它）。
 *
 * 实测：反向红跑九轮之后库里积了 31 条宿主已经不存在的孤儿事件行。
 * 这里按"宿主没了就删"清掉：宿主还在的行**一定**不动（那是别人正在跑的夹具）。
 */
const swept = await sql`
  delete from mn_notification_event e
  where not exists (select 1 from mn_matter m where m.id = e.host_id)
    and not exists (select 1 from mn_risk_matter r where r.id = e.host_id)
  returning id`;
if (swept.length) console.log(`顺带清掉 ${swept.length} 条孤儿通知事件（宿主已不存在）`);

for (const u of [outsider, follower, reporter, admin]) await dropSmokeAccount(sql, u.id);
console.log("清场完成");

await sql.end();
console.log(`\n${fail === 0 ? "✅ 全绿" : "❌ 有红"}：${pass} 通过 / ${fail} 失败`);
if (fail > 0) console.log(`红的断言：\n  - ${failedNames.join("\n  - ")}`);
process.exit(fail === 0 ? 0 : 1);
