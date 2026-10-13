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
 * @提及那一段（⑧）的反向红在 `revred-mention.mjs`，用法相同。
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
 *   ⑧ **@提及（MATT-58）**：评论里 @ 某人 → 那个人收到一条 `mention`；
 *      收件人是被 @ 的人（不是关注人/创建人/作者）；同一批的多个 @ 合成一条事件；
 *      `{quoted}` 来自评论片段；被 @ 的人看不到宿主时走**占位**且不发摘要字段
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
/** 本脚本建的全部临时账号。清场与残留断言共用一份，免得两处各写一遍四个 id */
const smokeUserIds = [admin.id, reporter.id, follower.id, outsider.id].map(String);

/**
 * 清场。**注册到崩溃路径上**（范围外发现 4，2026-10-14）。
 *
 * 改之前它只是脚本末尾的一段线性代码：夹具一崩（本轮实测过的形态——注入把锚点拆掉后
 * `evA` 为空、postgres.js 对模板里的 `undefined` 直接抛 `UNDEFINED_VALUE`），
 * 清场整段跳过，于是 **4 个 `mn_smoke_*` 账号**（其中一个是 `is_admin`）留在库里。
 * 最贵的一点是**症状出现在完全不相干的地方**：`db:check` 的 C14 报残留账号 ——
 * 排查的人会先去查 C14 那条检查项，而根因在一个他根本没跑过的冒烟脚本上。
 *
 * 形态与 `smoke-import.mjs` 一致（那里已经踩过同一个坑）：幂等函数 + 挂
 * `unhandledRejection` / `uncaughtException`。本仓的冒烟是**顶层 await 的 ESM**，
 * 中途抛错走的就是 unhandledRejection —— 它覆盖的范围与把整个脚本体包进 `try/finally`
 * 相同，而不用为此把 794 行整体缩进一级（那会让这次改动在 diff 里盖住真正的改动，
 * 而本仓的工作树里同时有别的 agent 在写）。
 *
 * 原则：**只动本脚本显式点名的账号与行**（宿主 id 从 riskIds/matterIds 来、
 * 账号从 smokeUserIds 来）。宿主已经不在的孤儿事件行是唯一的例外，见下面那段。
 */
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  console.log(`\n══ 清场 ══`);
  await sql`delete from mn_notification_delivery where user_id in ${sql(smokeUserIds)}`;
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
  await sql`delete from mn_user_watch where user_id in ${sql(smokeUserIds)}`;
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

  // 逐个 try：一个账号删不掉不该挡住其余账号（`dropSmokeAccount` 自己会报出是哪张表拦的）
  for (const u of [outsider, follower, reporter, admin]) {
    try {
      await dropSmokeAccount(sql, u.id);
    } catch (e) {
      // 大声报错**并且让它影响退出码**：删不掉的账号就是下一轮 db:check C14 的红
      fail++;
      failedNames.push(`清场：账号 ${u.username} 删不掉`);
      console.error(`清场：账号 ${u.username}（${u.id}）删不掉 —— ${e?.message ?? e}`);
    }
  }
  console.log("清场完成");
}

// 顶层 await 抛错走 `unhandledRejection`；同步抛错走 `uncaughtException`。两条都要挂
// （与 `smoke-import.mjs` 同一形态，理由见上：它等价于把整个脚本体包进 try/finally，
//  而不必为此缩进 794 行）。
for (const ev of ["unhandledRejection", "uncaughtException"]) {
  process.on(ev, async (e) => {
    console.error(
      `\n冒烟中断：${e?.message ?? e}\n` +
        `正在清场（4 个 mn_smoke_* 账号与夹具行不留库：它们的残留会毒到 db:check 的 C14）…`,
    );
    try {
      await cleanup();
    } catch (err) {
      console.error(`清场也失败了 —— 库里会留下残留：${err?.message ?? err}`);
    }
    await sql.end({ timeout: 5 }).catch(() => {});
    process.exit(1);
  });
}

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
/**
 * ⚠ **这条与消费次数对账，不写死 `=== 1`**（2026-10-14 排障结论；与 ⑧-4 同一条机制，
 * 只是上界的算法不同）。机制：`pumpNotifications()` 挂在**每一个** `GET /api/notifications`
 * 上，消费是"至少一次"、无锁（去重靠 `dedupe_key` 唯一键）。**另一个冒烟脚本同时在跑**时
 * 它也会 GET 通知中心，于是同一行可能被消费两次以上 ⇒ `merge_count` 变大，
 * 而**代码完全正确**（`agent-work/_probe-merge.mjs` 逐次打出过 `attempts=1→2`、
 * `merge_count=1→3`）。
 *
 * 这里的上界为什么是 `2 × attempts − 1` 而不是 ⑥b 的 `attempts − 1`：
 * `risk_converted` 一行展开出 **2 个 payload**，所以
 *   · **首次**消费只吸收 1 条（另一条建出了事件本身），
 *   · 之后每次消费把 2 条都吸收掉。
 * ⇒ `merge_count = 2 × attempts − 1`（吸收与 `attempts` 的 +1 在**同一个事务**里，
 * 所以两者不会互相漂移：要么都可见，要么都回滚）。
 *
 * 下界 `≥ 1` 是必须成立、也是这条断言真正独有的价值：把第二个 payload 丢掉时
 * **"事件数 = 1"仍然绿**（重复被静默丢弃，而不是被聚合成一条）——只有这里会红。
 * 反向红实测见报告 §②：注入"只处理第一个 payload"后本断言红、上面那条绿。
 */
const [convAgg] = await sql`
  select e.merge_count, o.attempts
  from mn_notification_event e
  join mn_event_outbox o on o.batch_id = e.event_batch_id
  where e.event_type = 'risk_converted' and e.host_id = ${riskId}`;
ok(
  "`merge_count ≥ 1` 且不超过消费次数能解释的上界（被吸收掉的原始条数，§7.2 口径）",
  convAgg !== undefined &&
    convAgg.merge_count >= 1 &&
    convAgg.merge_count <= 2 * convAgg.attempts - 1,
  `merge_count=${convAgg?.merge_count} attempts=${convAgg?.attempts}`,
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
/**
 * ⚠ **同样与消费次数对账，不写死 `=== 1`**（机制见上面 ② 那段注释）。
 * 这一行的展开是 **1 个 payload** ⇒ 首次消费建事件（记 0），之后每次消费各吸收 1 条，
 * 所以 `merge_count = attempts − 1`。
 *
 * 这里用 `<=` 而不是 ⑧-4 的 `===`：消费端**失败**那条路径也会 `attempts + 1`
 * （`consumeOutbox` 的 catch），于是"某次尝试没吸收却记了一次尝试"会让恒等式差 1——
 * 那是并发下的正常噪声，不是缺陷；而"多记一笔"（超过 attempts 能解释的量）照样红。
 */
const [replayRow] = await sql`
  select e.merge_count, o.attempts
  from mn_notification_event e
  join mn_event_outbox o on o.payload->>'comment_id' = ${commentId ?? null}
  where e.event_type = 'new_comment' and e.host_id = ${riskId}`;
ok(
  "`merge_count` 记下这次吸收，且不超过消费次数能解释的上界",
  replayRow !== undefined &&
    replayRow.merge_count >= 1 &&
    replayRow.merge_count <= replayRow.attempts - 1,
  `merge_count=${replayRow?.merge_count} attempts=${replayRow?.attempts}`,
);
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

/* ── ⑧ @提及（MATT-58 / T4b）：评论里 @ 到的人要真的收到 ─────────────────── */
console.log(`\n══ ⑧ @提及：评论里 @ 某人 → 那个人收到一条 mention ══`);

/**
 * 三个角色刚好覆盖 AC 的三句话，一个夹具不用另造：
 *
 * | 谁 | 与 riskId 的关系 | 用来钉什么 |
 * |---|---|---|
 * | `admin` | 负责人（L1），**评论作者** | 作者自己**不是**收件人 |
 * | `reporter` | **创建人**，能看见 | 被 @ 且看得见 ⇒ 渲染出 `{quoted}` |
 * | `outsider` | 无关（L3 self_operator），**看不见** | 被 @ 但看不见 ⇒ 占位、不发摘要 |
 *
 * ⚠ `follower` 在这一步已经被移出关注人（上面第 ③ 段），所以他也看不见 riskId ——
 * 但他**没被 @**，因此一条 mention 都不该有。这正是"收件人是被 @ 的那个人，
 * 不是关注人"的反证。
 *
 * 显示名一律**从库里读**，不在脚本里重算 `冒烟临时账号 ${username.slice(-6)}` 那个公式：
 * 公式抄一遍就多一处能与 `_testacct.mjs` 漂移的地方，而 @ 的匹配**全靠这个名字**。
 */
const nameOf = async (id) => {
  const [row] = await sql`select display_name from mn_app_user where id = ${id}`;
  return row?.display_name ?? "";
};
const adminName = await nameOf(admin.id);
const reporterName = await nameOf(reporter.id);
const outsiderName = await nameOf(outsider.id);
const followerName = await nameOf(follower.id);
ok(
  "夹具：四个账号的显示名互不相同（同名会让 @ 的归属无法判定）",
  new Set([adminName, reporterName, outsiderName, followerName]).size === 4,
  `${adminName} / ${reporterName} / ${outsiderName} / ${followerName}`,
);

const mentionEventsOf = async () =>
  sql`select id, dedupe_key, recipient_count, merge_count, event_batch_id, payload
      from mn_notification_event where event_type = 'mention' and host_id = ${riskId}
      order by id`;
const mentionItemsOf = async (cookie) => {
  const r = await call("GET", "/api/notifications", cookie);
  return { status: r.status, items: (r.body?.items ?? []).filter((i) => i.eventType === "mention"), raw: r.body };
};

/* ⑧-1 只 @ 一个"看不见这条事项"的人 —— 最干净地证明收件人不是关注人/创建人 */
const cmA = await call("POST", `/api/risk-matters/${riskId}/comments`, adminC, {
  body: `@${outsiderName} 冒烟：这条只点名了一位看不到本事项的同事`,
});
ok("⑧-1 发一条 @ 了看不见本事项的人的评论 201", cmA.status === 201, `status=${cmA.status}`);
const cmAId = cmA.body?.id;

const [cmARow] = await sql`select mention_ids from mn_comment where id = ${cmAId ?? null}`;
ok(
  "**@ 在库里的形态**：`mn_comment.mention_ids` 落的是被 @ 的 user id",
  (cmARow?.mention_ids ?? []).map(String).join(",") === String(outsider.id),
  `mention_ids=${JSON.stringify((cmARow?.mention_ids ?? []).map(String))} 期望=${outsider.id}`,
);

const [obA] = await sql`
  select payload, published_at from mn_event_outbox
  where payload->>'comment_id' = ${cmAId ?? null}`;
ok(
  "**@提及走既有 outbox**（与 new_comment 同一行，`comment_added`；不是新开的直发路径）",
  obA !== undefined && obA.published_at === null,
  `outbox 行=${obA === undefined ? "无" : "有"} published_at=${obA?.published_at}`,
);
ok(
  "被 @ 的人随 outbox payload 一起落库（重放时不再二次解析正文）",
  (obA?.payload?.mention_ids ?? []).map(String).join(",") === String(outsider.id),
  `payload.mention_ids=${JSON.stringify(obA?.payload?.mention_ids)}`,
);

const [evBeforeMention] = await sql`
  select count(*)::int as n from mn_notification_event
  where event_type = 'mention' and host_id = ${riskId}`;
ok("**不直发**：评论刚写完时还没有 mention 事件", evBeforeMention.n === 0, `n=${evBeforeMention.n}`);

const pumpA = await call("GET", "/api/notifications", adminC);
ok("⑧-1 轮询（GET 通知中心）200", pumpA.status === 200, `status=${pumpA.status}`);

const evA = await mentionEventsOf();
ok("**评论里 @ 某人 → 库里多出一条 mention 事件**", evA.length === 1, `事件数=${evA.length}`);
ok(
  "**收件人是被 @ 的那个人**（不是负责人/作者、不是创建人、不是关注人）",
  evA[0]?.recipient_count === 1,
  `recipient_count=${evA[0]?.recipient_count}`,
);
/**
 * ⚠ **不能写 `event_id = ${evA[0]?.id}`** —— 锚点被注入拆掉时 `evA` 是空的，
 * 而 postgres.js 对模板里的 `undefined` 直接抛 `UNDEFINED_VALUE`：
 * 冒烟**崩在中间**，⑧ 段后面那些断言一条都跑不到，账号也留在库里。
 *
 * 实测踩过：`mention-drop` / `mention-parse-off` 两轮反向红就是这样"崩溃红"的
 * （见 `agent-work/_revred-mention-out/*.red.txt` 的 `UNDEFINED_VALUE`，以及它留下的
 * 4 个 `mn_smoke_*` 账号把 `db:check` 的 C14 弄红）。反向红要的是**断言红**：
 * 宁可这里取到 0 行、断言如实变红，也不要让脚本半路死掉。
 */
const delivA = evA[0]
  ? await sql`select user_id, status, error from mn_notification_delivery where event_id = ${evA[0].id}`
  : [];
ok(
  "投递行只有被 @ 的那一个人（作者 admin 与创建人 reporter 都不在其中）",
  delivA.length === 1 && String(delivA[0].user_id) === String(outsider.id),
  `投递=${delivA.map((d) => `${d.user_id}:${d.status}`).join(",")}`,
);

const outMention = await mentionItemsOf(outsiderC);
ok(
  "**被 @ 的人看不到宿主 → 走不可见降级占位**（行还在，不隐藏整行）",
  outMention.items.length === 1 && outMention.items[0].visible === false,
  `items=${outMention.items.length} visible=${outMention.items[0]?.visible}`,
);
ok(
  "占位行标题是「无权查看的记录」",
  outMention.items[0]?.title === "无权查看的记录",
  `title=${outMention.items[0]?.title}`,
);
ok(
  "**占位行不发摘要字段**（body / hostId 都是 null）",
  outMention.items[0]?.body === null && outMention.items[0]?.hostId === null,
);
ok(
  "**摘要一个字节都没漏**：被 @ 的评论片段不出现在响应里",
  !JSON.stringify(outMention.raw ?? {}).includes("这条只点名了一位看不到本事项的同事"),
);
ok(
  "占位行**不算未读**（未读计数按可见行计，与既有口径一致）",
  (outMention.raw?.unread ?? -1) === 0,
  `unread=${outMention.raw?.unread}`,
);
const adminMention = await mentionItemsOf(adminC);
ok("评论作者自己**不是**收件人（@ 不是「我发的所以我收到」）", adminMention.items.length === 0, `items=${adminMention.items.length}`);
const reporterMentionBefore = await mentionItemsOf(reporterC);
ok("没被 @ 的创建人此刻**没有** mention（收件人 ≠ 创建人）", reporterMentionBefore.items.length === 0);
const followerMention = await mentionItemsOf(followerC);
ok("没被 @ 的关注人**没有** mention（收件人 ≠ 关注人）", followerMention.items.length === 0);

/* ⑧-2 一条评论里 @ 两个人 —— 同一批的多个 @ 怎么算 */
const cmB = await call("POST", `/api/risk-matters/${riskId}/comments`, adminC, {
  body: `@${reporterName} @${outsiderName} 冒烟：同一批里点了两个人`,
});
ok("⑧-2 一条评论里 @ 两个人 201", cmB.status === 201, `status=${cmB.status}`);
const cmBId = cmB.body?.id;
const [cmBRow] = await sql`select mention_ids from mn_comment where id = ${cmBId ?? null}`;
ok(
  "**多个 @ 按出现顺序落库**（不是集合，顺序是排障时的第一手证据）",
  (cmBRow?.mention_ids ?? []).map(String).join(",") === `${reporter.id},${outsider.id}`,
  `mention_ids=${JSON.stringify((cmBRow?.mention_ids ?? []).map(String))}`,
);
await call("GET", "/api/notifications", adminC);
const evB = await mentionEventsOf();
ok(
  "**同一批（同一条评论）的多个 @ 合成 1 条事件**，不是一人一条",
  evB.length === 2,
  `事件数=${evB.length}（期望 2：⑧-1 一条 + ⑧-2 一条）`,
);
ok(
  "⑧-2 那条事件的收件人数 = 2（被 @ 的两个人）",
  evB[1]?.recipient_count === 2,
  `recipient_count=${evB[1]?.recipient_count}`,
);
ok(
  "两条事件的 `dedupe_key` 不同（batch_id 不同：一条评论 = 一次业务操作）",
  evB[0]?.dedupe_key !== evB[1]?.dedupe_key,
);
ok(
  "**`dedupe_key` 口径与同批聚合一致**：`mention:<宿主 id>:<event_batch_id>:<收件人摘要>`",
  typeof evB[1]?.dedupe_key === "string" &&
    evB[1].dedupe_key.startsWith(`mention:${riskId}:`) &&
    evB[1].dedupe_key.includes(String(evB[1].event_batch_id)),
  `dedupe_key=${evB[1]?.dedupe_key}`,
);

const repMention = await mentionItemsOf(reporterC);
ok(
  "**被 @ 且看得见的人收到一条 mention**（可见，不是占位）",
  repMention.items.length === 1 && repMention.items[0].visible === true,
  `items=${repMention.items.length} visible=${repMention.items[0]?.visible}`,
);
ok(
  "mention 标题带**评论作者**的名字（模板 `{actor}`）",
  typeof repMention.items[0]?.title === "string" && repMention.items[0].title.includes(adminName),
  `title=${repMention.items[0]?.title}`,
);
ok(
  "**`{quoted}` 有真实来源**：正文带评论片段",
  typeof repMention.items[0]?.body === "string" &&
    repMention.items[0].body.includes("同一批里点了两个人"),
  `body=${repMention.items[0]?.body}`,
);
ok(
  "占位符被真正替换（正文里不残留字面 `{quoted}` / `{name}` / `{code}`）",
  typeof repMention.items[0]?.body === "string" &&
    !/\{(quoted|name|code|actor)\}/.test(`${repMention.items[0].title}${repMention.items[0].body}`),
  `body=${repMention.items[0]?.body}`,
);
ok(
  "同一批的 new_comment 照常发出（规则 8 的口径没被本票改动）",
  (await call("GET", "/api/notifications", reporterC)).body?.items?.some(
    (i) => i.eventType === "new_comment",
  ) === true,
);

/* ⑧-3 普通评论不产生 mention（回归锁：别把每个 `@` 都当成提及） */
const cmC = await call("POST", `/api/risk-matters/${riskId}/comments`, adminC, {
  body: "冒烟：这条评论一个 @ 都没有，不该产生 mention",
});
ok("⑧-3 发一条没有 @ 的评论 201", cmC.status === 201, `status=${cmC.status}`);
const [obC] = await sql`
  select payload from mn_event_outbox where payload->>'comment_id' = ${cmC.body?.id ?? null}`;
ok(
  "没有 @ 时 `mention_ids` 是空数组（不是缺字段）",
  Array.isArray(obC?.payload?.mention_ids) && obC.payload.mention_ids.length === 0,
  `mention_ids=${JSON.stringify(obC?.payload?.mention_ids)}`,
);
await call("GET", "/api/notifications", adminC);
ok("普通评论**不产生** mention 事件", (await mentionEventsOf()).length === 2);

/* ⑧-4 至少一次语义：重放同一条 outbox 行不产生第二条 mention */
await sql`update mn_event_outbox set published_at = null where payload->>'comment_id' = ${cmBId ?? null}`;
await call("GET", "/api/notifications", adminC);
const evReplay = await mentionEventsOf();
ok("**重放后 mention 事件数不变**（dedupe_key 唯一键吸收）", evReplay.length === 2, `n=${evReplay.length}`);
/**
 * ⚠ **这条断言刻意写成"与消费次数对账"，不写死 `=== 1`**（2026-10-14 排障结论）。
 *
 * `pumpNotifications()` 挂在**每一个** `GET /api/notifications` 上，而消费是"至少一次"语义、
 * 没有锁（这是设计：去重靠 `dedupe_key` 唯一键）。所以只要**另一个冒烟脚本同时在跑**
 * （它也会 GET 通知中心），我在这里手工重置的那一行就可能被两个请求同时选中、
 * 被消费两次 —— `merge_count` 于是变成 2 或 3，而**代码完全正确**。
 *
 * 实测证据：反向红六轮里有 3 轮的"复绿"跑出 `merge_count=2/3`（红的却是 T4 的断言），
 * 而紧接着连跑三次冒烟 93/0/93/0/93/0 全绿；`agent-work/_probe-merge.mjs` 单跑时
 * 逐次打出 `attempts=1→2`、`merge_count=0→1`，证明机制本身是一次消费一次记账。
 *
 * 所以这里钉的是**恒等式**：`merge_count === attempts - 1`（首次消费建事件记 0，
 * 之后每次消费各吸收 1 条）。它比写死 1 更强——并发多消费一次也照样成立，
 * 而"漏记一笔"或"多记一笔"都躲不过。
 */
const [mentionReplayRow] = await sql`
  select e.merge_count, o.attempts
  from mn_notification_event e, mn_event_outbox o
  where e.event_type = 'mention' and e.host_id = ${riskId}
    and o.payload->>'comment_id' = ${cmBId ?? null}
  order by e.id desc limit 1`;
ok(
  "被吸收的那条记进 `merge_count`（§7.2：被本事件吸收掉的原始条数 = 消费次数 − 1）",
  mentionReplayRow !== undefined &&
    mentionReplayRow.merge_count >= 1 &&
    mentionReplayRow.merge_count === mentionReplayRow.attempts - 1,
  `merge_count=${mentionReplayRow?.merge_count} attempts=${mentionReplayRow?.attempts}`,
);
const repMention2 = await mentionItemsOf(reporterC);
ok("重放后收件人**不会**多出一条 mention", repMention2.items.length === 1, `items=${repMention2.items.length}`);

/* ── ⑧-5 §7.2 合并规则 1：同一个人既关注又被 @ ⇒ 恰好 1 条 ─────────────── */
console.log(`\n══ ⑧-5 合并规则 1：关注人 / 创建人同时被 @ 只出 1 条 ══`);

/**
 * 这一批（= 一次业务操作）里的全部事件与投递行，用来回答
 * "**这个人在这一批里收到了几条**"——`mention` 与 `new_comment` 共用一行 outbox，
 * 所以 `event_batch_id` 就是判定"同一批"的唯一依据（§7.2 合并规则 1 的条件）。
 */
const batchRowsOf = async (commentId) =>
  sql`select e.event_type, e.id as event_id, d.user_id, d.status
      from mn_notification_event e
      left join mn_notification_delivery d on d.event_id = e.id
      where e.event_batch_id =
        (select batch_id from mn_event_outbox where payload->>'comment_id' = ${commentId ?? null})
      order by e.id, d.user_id`;

/**
 * ⚠ 这一段的夹具**故意让两个身份重叠**。裁定依据是 §7.2 的「问题」那句
 * ——「同一用户可同时是负责人+关注人+**被 @**；……原设计会产生成倍重复推送」——
 * 与它下面两条合并规则：
 *   · 规则 1「同一 `event_batch_id` 内，同一收件人只出 1 条事件」：条件只有**批次 + 收件人**，
 *     `event_type` 不在条件里（括号里的"归档+通知+节点"也是三种 type）；
 *   · 规则 2「命中角色重叠（owner ∩ follower ∩ **mention**）→ 收件人集合去重到 user 级」：
 *     括号里直接把 `mention` 列进了重叠集合。
 * 所以"既是关注人又被 @"的同事**只收 1 条**：他收更具体的 `mention`，不再重复收广播。
 *
 * 断言钉在**投递行数**上而不是"通知中心里有几条"：后者会被别的批次的同类型通知稀释，
 * 而合并规则 1 的条件恰恰是"同一 `event_batch_id` 内"。
 */
const reAddF = await call("POST", `/api/risk-matters/${riskId}/staff/followers`, adminC, {
  userIds: [String(follower.id)],
});
ok(
  "⑧-5 把 follower 加回关注人 200（他从此同时是：关注人 + 被 @）",
  reAddF.status === 200,
  `status=${reAddF.status} ${JSON.stringify(reAddF.body)?.slice(0, 80)}`,
);

const cmD = await call("POST", `/api/risk-matters/${riskId}/comments`, adminC, {
  body: `@${followerName} 冒烟：同一个人既是关注人又被 @`,
});
ok("⑧-5 发一条 @ 了关注人的评论 201", cmD.status === 201, `status=${cmD.status}`);
const cmDId = cmD.body?.id;
await call("GET", "/api/notifications", adminC);

const batchD = await batchRowsOf(cmDId);
const followerBatch = batchD.filter((r) => String(r.user_id) === String(follower.id));
ok(
  "**§7.2 合并规则 1**（同一 `event_batch_id` 内同一收件人只出 1 条事件）：既是关注人又被 @ 的同事**恰好 1 条**通知",
  followerBatch.length === 1 && followerBatch[0]?.event_type === "mention",
  `该批内 follower 的投递=${followerBatch.map((r) => `${r.event_type}:${r.status}`).join(",") || "无"}`,
);
ok(
  "那 1 条是 **`mention`**（更具体的那条：点了名 + 带 `{quoted}`），不是广播 `new_comment`",
  followerBatch[0]?.event_type === "mention" && followerBatch[0]?.status === "sent",
  `event_type=${followerBatch[0]?.event_type} status=${followerBatch[0]?.status}`,
);
ok(
  "**没被 @ 的创建人照常收 `new_comment`**（规则 8 的档位没被减，减掉的只是被 @ 的那个人）",
  batchD.some((r) => r.event_type === "new_comment" && String(r.user_id) === String(reporter.id)),
  `该批 new_comment 的收件人=${batchD.filter((r) => r.event_type === "new_comment").map((r) => r.user_id).join(",")}`,
);

/**
 * ⑧-5b 是 ⑧-5 的**镜像**：这次让"创建人"落在重叠集合里。
 * 两句合起来才覆盖 §7.2 规则 2 括号里的 `owner ∩ follower ∩ mention` 那个交集形态，
 * 同时也证明了**没被 @ 的关注人照常收广播**（本票只减 `mention_ids` 里的那几个人）。
 */
const cmE = await call("POST", `/api/risk-matters/${riskId}/comments`, adminC, {
  body: `@${reporterName} 冒烟：只点名创建人，关注人没被点`,
});
ok("⑧-5b 发一条 @ 了创建人的评论 201", cmE.status === 201, `status=${cmE.status}`);
const cmEId = cmE.body?.id;
await call("GET", "/api/notifications", adminC);

const batchE = await batchRowsOf(cmEId);
const reporterBatchE = batchE.filter((r) => String(r.user_id) === String(reporter.id));
ok(
  "**§7.2 合并规则 1**：既是创建人又被 @ 的同事同样**恰好 1 条**（同一收件人在同一批只出一条事件）",
  reporterBatchE.length === 1 && reporterBatchE[0]?.event_type === "mention",
  `该批内 reporter 的投递=${reporterBatchE.map((r) => `${r.event_type}:${r.status}`).join(",") || "无"}`,
);
ok(
  "**没被 @ 的关注人照常收 `new_comment`**（本票没把规则 8 改成\"被 @ 就不再广播\"）",
  batchE.some((r) => r.event_type === "new_comment" && String(r.user_id) === String(follower.id)),
  `该批 new_comment 的收件人=${batchE.filter((r) => r.event_type === "new_comment").map((r) => r.user_id).join(",")}`,
);

/* ── 清场 ──────────────────────────────────────────────────────────────── */
/**
 * ③ 崩溃路径探针（默认关闭）。用它**一条命令**验证"断言一抛错也会清场"：
 *
 *   SMOKE_ABORT_BEFORE_CLEANUP=1 node --env-file=.env agent-work/smoke-notifications.mjs
 *   ⇒ 应当打印「冒烟中断 …」+「清场完成」，退出码 1，且
 *      `node --env-file=.env agent-work/_probe-smoke-residue.mjs` 显示 0 残留。
 *
 * 为什么留着它而不是"临时改一行再改回来"：这条路径**只有崩的时候才走到**，
 * 而它正是范围外发现 4 的现场（残留账号毒到 db:check 的 C14）。
 * 一个需要人工改代码才能复现的守护，等于没有守护——留着开关，它才是可复验的。
 */
if (process.env.SMOKE_ABORT_BEFORE_CLEANUP === "1") {
  throw new Error("③ 探针：故意在清场之前中断（验证 unhandledRejection 清场路径）");
}

await cleanup();

/**
 * 残留断言。**它盯的正是那个"毒到别的 check 项"的失败形态**：
 * 账号（尤其 `is_admin` 的那个）留在库里，症状却出现在 `db:check` 的 C14 上。
 * 与 `smoke-import.mjs` 末尾那条残留断言同一姿态——清场写完不算数，
 * 要有一个当场看得见的数字证明它真的干净了。
 */
const [residue] = await sql`
  select
    (select count(*)::int from mn_app_user where id in ${sql(smokeUserIds)}) as users,
    (select count(*)::int from mn_event_outbox
       where payload->>'risk_matter_id' in ${sql(riskIds)} or payload->>'host_id' in ${sql(riskIds)}) as outbox,
    (select count(*)::int from mn_notification_event
       where host_id in ${sql([...riskIds, ...matterIds])}) as events`;
ok(
  "清场：临时账号 / 夹具 outbox 行 / 夹具通知事件都不在库里了（残留会毒到 db:check C14）",
  residue.users === 0 && residue.outbox === 0 && residue.events === 0,
  `账号=${residue.users} outbox=${residue.outbox} 事件=${residue.events}`,
);

await sql.end();
console.log(`\n${fail === 0 ? "✅ 全绿" : "❌ 有红"}：${pass} 通过 / ${fail} 失败`);
if (fail > 0) console.log(`红的断言：\n  - ${failedNames.join("\n  - ")}`);
process.exit(fail === 0 ? 0 : 1);
