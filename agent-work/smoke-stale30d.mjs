import {
  createSmokeAccount,
  dropSmokeAccount,
  finishSmoke,
  noteCleanupFailure,
  ROLE_CODES,
} from "./_testacct.mjs";
/**
 * 规则 4「长期未更新提醒」的真 HTTP 冒烟（MATT-61 / T4e）。
 *
 * ## 这批断言要钉住什么
 *
 * 规则 4 此前是**声明了但没有生产者**的事件类型：`preset_04_stale_30d_notify` 在规则表里、
 * 模板已 seed、E29 的 CHECK 里有 `stale_30d` —— 但没有任何代码路径会造出这个事件。
 * 而"没有生产者"与"没人该收"在库里是**同一个形态**（事件表里零行），
 * 所以本脚本的第一条判据不是"事件数对"，而是"**扫描器真的跑过**"（`last_run_at` 前进）。
 *
 * ## 三处刻意的设计
 *
 * 1. **夹具靠改 `last_progress_at`，不靠等 30 天**（与 `smoke-rule9.mjs` 改 `closing_date` 同一手法）。
 *    而本票**必须**先有 MATT-59：那一列过去只在建案时写过一次初值，改它之前
 *    "把基准往前挪"是没有意义的（基准本来就不动）。
 * 2. **`freeze()`（把规则的 `is_enabled` 关掉）改夹具**。本脚本跑在共享开发库上，
 *    而扫描挂在 `GET /api/notifications` 的读请求上 —— 改夹具时若规则开着，
 *    别的流的轮询可能替本脚本落一条事件，"事件恰好 N 条"就会随机变红
 *    （`smoke-rule9.mjs` 里那段注释是同一条教训）。
 *    反过来，冻结期内的 pump 必须**一条都不产生** —— 那正是"规则可停用"这条 AC 的落点。
 * 3. **收件人按规则行里读到的 `receivers` 断言，不按票面文字**。票面括注写的是
 *    "owner + follower"，而规则目录与 seed **一致地写着 `["owner"]`**；
 *    脚本先把库里的实际值读出来打进报告，再按它断言 —— 于是"目录改了"会在这里红，
 *    而不是静默地两边各说一套。
 */
const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";
const RULE_CODE = "preset_04_stale_30d_notify";

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
  return {
    status: r.status,
    cookie: (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; "),
  };
}

/** 上海日历日（+08:00）的 `YYYY-MM-DD`，`offsetDays` 为负表示过去 */
function shanghaiDay(offsetDays) {
  return new Date(Date.now() + offsetDays * 86_400_000 + 8 * 3_600_000)
    .toISOString()
    .slice(0, 10);
}

/** `now` 的 ISO 瞬时（改 `last_progress_at` 用，那一列是 timestamptz） */
function isoNow() {
  return new Date().toISOString();
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

const admin = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
const owner = await createSmokeAccount(sql, { roles: [ROLE_CODES.self] });
const follower = await createSmokeAccount(sql, { roles: [ROLE_CODES.joined] });

let ruleId = null;
const matterIds = [];
const riskIds = [];

async function cleanup() {
  // 顺序按外键。⚠ 通知事件**没有**指向宿主的外键（`host_id` 是冗余列，见 schema 的注），
  //   所以删不掉也不会报错 —— 只会留下一堆指向不存在案件的事件行（"孤儿事件"）。
  //   这正是"清场要认新表"那一类，靠外键报错是等不来的。
  // ⚠ 投递行要先走：它指向事件，而事件被删之后"哪个用户收到过什么"就再也拼不回来，
  //   残留会让下一条冒烟的"投递行数恰好 N"凭空多出几条（`smoke-rule9.mjs` 的清场顺序）。
  const allUsers = [admin.id, owner.id, follower.id].map(String);
  await sql`delete from mn_notification_delivery where user_id in ${sql(allUsers)}`.catch((e) =>
    noteCleanupFailure("投递行（按用户）", e),
  );
  for (const id of matterIds) {
    await sql`delete from mn_notification_delivery
               where event_id in (select id from mn_notification_event where host_id = ${id})`.catch(
      (e) => noteCleanupFailure(`投递行 ${id}`, e),
    );
    await sql`delete from mn_notification_event where host_id = ${id}`.catch((e) =>
      noteCleanupFailure(`事件行 ${id}`, e),
    );
    await sql`delete from mn_event_outbox where payload->>'host_id' in ${sql([String(id)])}`.catch(
      (e) => noteCleanupFailure(`outbox ${id}`, e),
    );
    for (const q of [
      `delete from mn_activity_log where matter_id=${id}`,
      `delete from mn_matter_progress where matter_id=${id}`,
      `delete from mn_matter_staff where matter_id=${id}`,
      `delete from mn_matter_node where matter_id=${id}`,
      `delete from mn_matter_party where matter_id=${id}`,
      `delete from mn_matter where id=${id}`,
    ]) {
      await sql.unsafe(q).catch((e) => noteCleanupFailure(`夹具行 ${q}`, e));
    }
  }
  for (const id of riskIds) {
    await sql`delete from mn_notification_event where host_id = ${id}`.catch((e) =>
      noteCleanupFailure(`事件行 ${id}`, e),
    );
    for (const q of [
      `delete from mn_activity_log where risk_matter_id=${id}`,
      `delete from mn_risk_matter_staff where risk_matter_id=${id}`,
      `delete from mn_risk_matter where id=${id}`,
    ]) {
      await sql.unsafe(q).catch((e) => noteCleanupFailure(`夹具行 ${q}`, e));
    }
  }
  // 规则开关必须还原：忘了它会让**后续所有**规则 4 的提醒全部消失，
  // 而症状（零事件）与"没人该收"同形，排查方向会被带到完全错误的地方
  if (ruleId) {
    await sql`update mn_automation_rule set is_enabled = true where id = ${ruleId}`.catch((e) =>
      noteCleanupFailure(`规则 ${RULE_CODE} 开关还原`, e),
    );
  }
  await sql`delete from mn_user_watch where user_id in ${sql(allUsers)}`.catch((e) =>
    noteCleanupFailure("关注清单", e),
  );
  for (const acc of [admin, owner, follower]) {
    if (!acc?.id) continue;
    await sql`delete from mn_activity_log where operator_id = ${acc.id}`.catch((e) =>
      noteCleanupFailure(`活动日志 ${acc.id}`, e),
    );
    await sql`delete from mn_auth_session where user_id = ${acc.id}`.catch((e) =>
      noteCleanupFailure(`会话 ${acc.id}`, e),
    );
    await sql`delete from mn_app_user_role where user_id = ${acc.id}`.catch((e) =>
      noteCleanupFailure(`角色 ${acc.id}`, e),
    );
    try {
      await dropSmokeAccount(sql, acc.id);
    } catch (e) {
      noteCleanupFailure(`临时账号 ${acc.username}（${acc.id}）`, e);
    }
  }
}

/** 规则 4 的开关。改夹具时关掉它，改完再打开（理由见文件头第 2 条） */
async function freeze(on) {
  await sql`update mn_automation_rule set is_enabled = ${on} where id = ${ruleId}`;
}

/** 触发一次轮询 —— 扫描挂在通知中心的读请求上（`pump-gate.ts` 的 `pumpAll`） */
const pump = (cookie) => call("GET", "/api/notifications", cookie);

function eventsOf(matterId) {
  return sql`
    select id, dedupe_key, payload, source_rule_id, created_at
      from mn_notification_event
     where event_type = 'stale_30d' and host_id = ${matterId}
     order by created_at, id`;
}

try {
  // ── 0. 规则行：先把"库里到底写着多少"读出来打进报告 ──
  const [rule] = await sql`
    select id, code, host_type, trigger_type, trigger_config, action_config, is_enabled, last_run_at
      from mn_automation_rule where code = ${RULE_CODE}`;
  ruleId = rule?.id ?? null;
  ok("规则 4 在库里", Boolean(rule), rule ? `id=${ruleId}` : "缺失");
  ok("**只算案件**：`host_type` = matter（IQ-9/Q37）", rule?.host_type === "matter", `host=${rule?.host_type}`);
  ok("触发类型是 `time_no_progress`", rule?.trigger_type === "time_no_progress", `${rule?.trigger_type}`);

  const tc = rule?.trigger_config ?? {};
  const ac = rule?.action_config ?? {};
  const days = Number(tc["days"]);
  const receivers = ac["receivers"] ?? [];
  const cooldownDays = Number(ac["cooldown_days"]);
  const oncePerTarget = ac["once_per_target"] === true;
  console.log(
    `\n[报告] 规则 4 的实际参数（读自规则行，不是读自常量）：` +
      `\n  trigger_config.days = ${days}` +
      `\n  action_config.receivers = ${JSON.stringify(receivers)}` +
      `\n  action_config.once_per_target = ${oncePerTarget}` +
      `\n  action_config.cooldown_days = ${cooldownDays}\n`,
  );
  ok("**阈值取自规则目录**（`trigger_config.days` = 30，不写死字面量）", days === 30, `days=${days}`);
  ok(
    "**收件人取自规则行**：库里是 `[\"owner\"]` —— 票面括注写的「owner + follower」与目录不符，以目录为准",
    JSON.stringify(receivers) === JSON.stringify(["owner"]),
    `receivers=${JSON.stringify(receivers)}（关注人因此收不到这条）`,
  );
  ok("`once_per_target` 与 `cooldown_days` 都有值（§2.3 末段：否则 cron 重扫会成提醒风暴）", oncePerTarget && cooldownDays >= 1, `once=${oncePerTarget} cooldown=${cooldownDays}`);

  // ── 1. 夹具：一条案件 + 一个关注人 ──
  const adminC = (await login(admin.username, admin.password)).cookie;
  const ownerC = (await login(owner.username, owner.password)).cookie;
  const followerC = (await login(follower.username, follower.password)).cookie;

  // ⚠ 建案由 **admin** 发起并显式指定 `ownerId`：于是「创建人」与「经办人」不是同一个人，
  //   「只推经办人」这条才验得出来（与 `smoke-rule9.mjs` 同一手法）。
  //   顺带一个真实约束：`self_operator`（经办人自己）**没有**把 joined 账号加进关注人的
  //   可选范围 ⇒ 下面加关注人也得由 admin 来做（我第一次用 ownerC 拿到 422 not_selectable）。
  const m = await call("POST", "/api/matters", adminC, {
    name: `停滞冒烟 ${stamp}`,
    cause: "建设工程施工合同纠纷",
    caseType: "civil_commercial",
    procedure: "first_instance",
    litigationRole: "defendant",
    level: "high",
    ownerId: String(owner.id),
  });
  ok("建案 → 201", m.status === 201, `status=${m.status}`);
  const mid = m.body?.id;
  matterIds.push(mid);
  const [mRow] = await sql`select created_by, owner_id from mn_matter where id = ${mid}`;
  ok(
    "创建人 = admin、经办人 = owner（两者不是同一个人，「只推经办人」才验得出来）",
    String(mRow?.created_by) === String(admin.id) && String(mRow?.owner_id) === String(owner.id),
    `created_by=${mRow?.created_by} owner=${mRow?.owner_id}`,
  );

  // ⚠ 案件侧的加人形状是 `POST /api/matters/{id}/staff` + `{userIds, staffRole}`
  //   （事项侧才是 `staff/followers` 那条路）。写错会 405，而下面"关注人收不到"
  //   那条**负向断言会照样绿**（没人关注 ⇒ 当然收不到）——所以这里必须钉住 `added`。
  const addF = await call("POST", `/api/matters/${mid}/staff`, adminC, {
    userIds: [String(follower.id)],
    staffRole: "follower",
  });
  ok(
    "**关注人真的加进去了**（否则下面那条负向断言会空过）",
    addF.status === 200 && addF.body?.added === 1,
    `status=${addF.status} ${JSON.stringify(addF.body)?.slice(0, 60)}`,
  );

  // ── 2. 规则可停用：关掉之后即使基准早就过期，也一条都不许发 ──
  await freeze(false);
  await sql`update mn_matter set last_progress_at = ${shanghaiDay(-31)} where id = ${mid}`;
  const offPump = await pump(adminC);
  ok("停用后泵仍 200", offPump.status === 200, `status=${offPump.status}`);
  ok(
    "**规则停用 ⇒ 一条都不发**（基准已过期 31 天也不发）",
    (await eventsOf(mid)).length === 0,
    `events=${(await eventsOf(mid)).length}`,
  );

  // ── 3. 反向的那一半：刚更新过的案件不得收到（假阳性护栏，比正向更重要）──
  await sql`update mn_matter set last_progress_at = ${isoNow()} where id = ${mid}`;
  await freeze(true);
  const freshPump = await pump(adminC);
  ok("刚更新过：泵 200", freshPump.status === 200, `status=${freshPump.status}`);
  ok("**`last_progress_at` 刚刷新的案件一条都不发**", (await eventsOf(mid)).length === 0);

  // ── 4. 核心 AC：31 天 ⇒ 经办人收到一条 `stale_30d` ──
  await freeze(false);
  await sql`update mn_matter set last_progress_at = ${shanghaiDay(-31)} where id = ${mid}`;
  const runBefore = (await sql`select last_run_at from mn_automation_rule where id = ${ruleId}`)[0]
    ?.last_run_at;
  await freeze(true);
  const duePump = await pump(adminC);
  ok("满 31 天那次轮询 200（扫描命中时不许 500）", duePump.status === 200, `status=${duePump.status}`);
  const ev1 = await eventsOf(mid);
  ok("**满 30 天 → 落了一条 `stale_30d` 事件**", ev1.length === 1, `events=${ev1.length}`);
  ok(
    "事件指着这条规则（`source_rule_id`）——排障时能回溯到是谁发的",
    String(ev1[0]?.source_rule_id) === String(ruleId),
    `source_rule_id=${ev1[0]?.source_rule_id}`,
  );
  ok(
    "**payload 带 `last_progress_at`**（模板的 `{last}` 只认这个键）",
    typeof ev1[0]?.payload?.["last_progress_at"] === "string",
    `payload=${JSON.stringify(ev1[0]?.payload)}`,
  );
  ok("payload 带 `days_stale`（排障口径）", ev1[0]?.payload?.["days_stale"] === 31, `days_stale=${ev1[0]?.payload?.["days_stale"]}`);

  // ── 5. `last_run_at` —— "扫描器真的跑过"的唯一可观测证据 ──
  const runAfter = (await sql`select last_run_at from mn_automation_rule where id = ${ruleId}`)[0]
    ?.last_run_at;
  ok(
    "**`last_run_at` 前进了**（没有它，零事件分不清是没人该收还是扫描器没被调用）",
    runAfter && (!runBefore || new Date(runAfter).getTime() > new Date(runBefore).getTime()),
    `before=${runBefore ? new Date(runBefore).toISOString() : "null"} after=${runAfter ? new Date(runAfter).toISOString() : "null"}`,
  );

  // ── 6. 谁收到：经办人收到，关注人收不到（收件人取自规则行）──
  const ownerList = await call("GET", "/api/notifications", ownerC);
  const ownerItem = (ownerList.body?.items ?? []).find((i) => i.eventType === "stale_30d");
  ok("**经办人收到这条提醒**", Boolean(ownerItem), `items=${ownerList.body?.items?.length}`);
  ok(
    "这条通知的正文里不留未替换的占位符（渲染走的是生产那条路径）",
    !!ownerItem?.body && !String(ownerItem.body).includes("{"),
    `body=${String(ownerItem?.body ?? "").slice(0, 70)}`,
  );
  const followerList = await call("GET", "/api/notifications", followerC);
  const followerItem = (followerList.body?.items ?? []).find((i) => i.eventType === "stale_30d");
  ok(
    "**关注人收不到**（收件人是 `owner`，与规则 2/8 的 `creator` 改道不同）",
    !followerItem,
    `followerItems=${followerList.body?.items?.length}`,
  );

  // ── 7. 幂等：同一天连续轮询 3 次仍只有 1 条（dedupe_key 吸收）──
  await pump(adminC);
  await pump(adminC);
  await pump(adminC);
  ok("**同一天连泵 3 次仍只有 1 条事件**（dedupe_key 吸收）", (await eventsOf(mid)).length === 1, `events=${(await eventsOf(mid)).length}`);

  // ── 8. 冷却期：10 天前发过 ⇒ 静默；31 天前发过 ⇒ 可以再发 ──
  const [last] = await eventsOf(mid);
  await sql`
    update mn_notification_event
       set created_at = now() - make_interval(days => 10),
           dedupe_key = ${`${last.dedupe_key}#fixture-10d`}
     where id = ${last.id}`;
  await pump(adminC);
  ok("**冷却期内（距上一条 10 天 < 30）不再发**", (await eventsOf(mid)).length === 1, `events=${(await eventsOf(mid)).length}`);
  const [last2] = await eventsOf(mid);
  await sql`
    update mn_notification_event
       set created_at = now() - make_interval(days => 31),
           dedupe_key = ${`${last2.dedupe_key}#fixture-31d`}
     where id = ${last2.id}`;
  await pump(adminC);
  ok(
    "**冷却期过后再来一条**（不是「只发一次、永远沉默」）",
    (await eventsOf(mid)).length === 2,
    `events=${(await eventsOf(mid)).length}`,
  );

  // ── 9. 归档记录不触发（归档是终态）──
  await freeze(false);
  const m2 = await call("POST", "/api/matters", ownerC, {
    name: `停滞冒烟 归档 ${stamp}`,
    cause: "建设工程施工合同纠纷",
    caseType: "civil_commercial",
    procedure: "first_instance",
    litigationRole: "defendant",
    level: "high",
  });
  matterIds.push(m2.body?.id);
  await sql`
    update mn_matter
       set last_progress_at = ${shanghaiDay(-31)}, is_archived = true
     where id = ${m2.body.id}`;
  await freeze(true);
  await pump(adminC);
  ok(
    "**已归档的案件不触发**（AC：归档记录不触发）",
    (await eventsOf(m2.body.id)).length === 0,
    `events=${(await eventsOf(m2.body.id)).length}`,
  );

  // ── 10. 只算案件：事项再旧也不参与 ──
  const r = await call("POST", "/api/risk-matters", ownerC, {
    name: `停滞冒烟 事项 ${stamp}`,
    type: "contract",
    level: "high",
    description: "规则 4 的宿主收窄为仅案件，事项不参与",
  });
  ok("建事项 → 201", r.status === 201, `status=${r.status}`);
  riskIds.push(r.body?.id);
  await sql`
    update mn_risk_matter
       set updated_at = now() - make_interval(days => 31)
     where id = ${r.body.id}`;
  await pump(adminC);
  const alien = await sql`
    select count(*)::int as n
      from mn_notification_event
     where event_type = 'stale_30d' and target_type <> 'matter'`;
  ok("**事项不参与**：`stale_30d` 事件里没有非案件宿主", alien[0]?.n === 0, `n=${alien[0]?.n}`);
  ok("那条 31 天没动的事项确实没落事件", (await eventsOf(r.body.id)).length === 0, `events=${(await eventsOf(r.body.id)).length}`);
} catch (e) {
  fail++;
  console.log(`[FAIL] 脚本中断 —— ${e?.stack ?? e}`);
} finally {
  try {
    await cleanup();
    console.log("[clean] 清场完成");
  } catch (e) {
    noteCleanupFailure("夹具清场", e);
  }
  await sql.end();
}

console.log(`\n${fail ? "FAIL" : "PASS"}：${pass} 通过 / ${fail} 失败`);
finishSmoke(fail);
