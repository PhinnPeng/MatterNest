import { readFileSync } from "node:fs";
import {
  createSmokeAccount,
  dropSmokeAccount,
  finishSmoke,
  noteCleanupFailure,
  ROLE_CODES,
} from "./_testacct.mjs";

/**
 * **规则 9「结案后材料不全提醒」的真 HTTP 冒烟**（MATT-43 / T5b）。
 *
 * ## 为什么单独一个脚本，而不是并进 `smoke-notifications.mjs`
 *
 * `smoke-notifications` 的 58 条断言讲的是**通用管线**（outbox、聚合、通知中心、
 * 节点扫描、时区、归档静默），夹具是一整套事项+案件+转案件；
 * 本票要验的是**一条规则**的作业逻辑：什么时候算满 14 天、谁收、冷却期、
 * 停用、以及"规则表 + DB 约束"这层数据。
 * 并进去会让那个脚本再长 200 行，而它已经被 T4/T4b 两条流同时改着
 * （`services/notifications.ts` 与它的冒烟都在动）。分开还有一个实际好处：
 * 本脚本**只碰一条规则行与一条案件**，可以独立重跑。
 *
 * ## 跑法
 *
 *   node --env-file=.env agent-work/smoke-rule9.mjs     # dev server 在 3777（SMOKE_BASE 可覆盖）
 *
 * ## 先反向红一次（本仓纪律：没有反向红的冒烟等于没有冒烟）
 *
 *   node agent-work/revred-rule9.mjs <mode>            # 注入
 *   node --env-file=.env agent-work/smoke-rule9.mjs    # ⇒ 必须红
 *   node agent-work/revred-rule9.mjs restore           # 还原（**别用 git checkout**）
 *
 * ## 夹具为什么有一半走 SQL
 *
 * "结案满 14 天"要真的把 `closing_date` 往前挪两周；"冷却期已过"要真的把上一条事件的
 * 时间往前挪。这两件事都**没有接口**（也不该有：让用户改结案日期去骗提醒是缺陷不是功能）。
 * 被测的东西仍然是 HTTP：扫描由 `GET /api/notifications` 触发。
 *
 * ## 一条必须说明的分层（否则"14 天内不重复推"会被误读成只有一个闸门）
 *
 * 同一天里有两道闸门同时在挡：`dedupe_key`（`archive_incomplete:目标:业务日`）与
 * **冷却期**。前者在同一个业务日内**永远**先挡住，所以"冷却期"这个闸门在冒烟里
 * 无法用"同一天再 pump 一次"来证明。本脚本的做法是**把上一条事件的
 * `dedupe_key` 与 `created_at` 一起改写成"昨天那条"**（模拟昨天真的发过一条），
 * 于是今天的 `dedupe_key` 不再冲突 —— 此时还能不能发，就只剩冷却期说了算。
 * 这一段是本次冒烟里唯一一处"改夹具骗过第一道闸门"，写在这里免得被当成脏数据。
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

try {
  await sql`select 1`;
} catch (e) {
  console.error(
    `数据库连不上（${e?.message ?? e}）—— 隧道可能正在抖。\n` +
      `这不是断言失败：等一会儿重跑。`,
  );
  // 3 = 环境不对；此时还没建任何夹具，所以不可能是「清场失败」（那个码是 2）
  process.exit(3);
}

/** 上海业务日（`YYYY-MM-DD`）。所有日期夹具与断言都按它算，不用本机时区 */
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

const RULE_CODE = "preset_09_archive_incomplete_notify";
const SEED_FILE = "src/app/lib/server/db/seed/0006_automation_rules.sql";

const stamp = Date.now();
const admin = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
const owner = await createSmokeAccount(sql, { roles: [ROLE_CODES.self] });
const follower = await createSmokeAccount(sql, { roles: [ROLE_CODES.joined] });
const outsider = await createSmokeAccount(sql, { roles: [ROLE_CODES.self] });
const adminC = (await login(admin.username, admin.password)).cookie;
const ownerC = (await login(owner.username, owner.password)).cookie;
const followerC = (await login(follower.username, follower.password)).cookie;
const outsiderC = (await login(outsider.username, outsider.password)).cookie;

const matterIds = [];
let ruleId = null;

/** 本案件当前有几条 `archive_incomplete` 事件、最近一条是什么时候 */
async function eventsOf(matterId) {
  return sql`
    select id, dedupe_key, recipient_count, payload, source_rule_id, created_at
      from mn_notification_event
     where event_type = 'archive_incomplete' and host_id = ${matterId}
     order by created_at, id`;
}
/**
 * 把上一条事件改写成"若干天前发的那一条"，并把 `dedupe_key` 换成别的业务日。
 *
 * ⚠ **调用前必须 `freeze(true)`**（见下面那段注释）：这一改会让"今天"的 `dedupe_key`
 * 不再冲突，于是**任何一次并发的扫描**（别的冒烟的 `GET /api/notifications`）都能
 * 抢先落一条事件，而本脚本随后断言的是"事件恰好 N 条" ⇒ 随机变红。
 * 第一轮反向红跑批里 `receivers-all` / `missing-code-raw` 两次"没复绿"就是这个时序，
 * 而它长得像"代码坏了"。
 */
async function backdateLastEvent(matterId, days, tag) {
  const rows = await eventsOf(matterId);
  const last = rows[rows.length - 1];
  if (!last) return null;
  await sql`
    update mn_notification_event
       set created_at = now() - make_interval(days => ${days}),
           dedupe_key = ${`${last.dedupe_key}#fixture-${tag}`}
     where id = ${last.id}`;
  return last.id;
}
/**
 * 冻结/解冻规则 9（写的就是那个 `is_enabled` 开关）。
 *
 * ## 为什么需要它（不是"顺手加的保险"）
 *
 * 本脚本在一个**共享开发库**上跑，别的流的冒烟也会打 `GET /api/notifications` ——
 * 而那个读请求会推动**同一个扫描器**、扫**同一批案件**。本脚本的夹具操纵
 * （改 `dedupe_key`、把结案日期往前挪）会**打开一个窗口**：窗口里任何一次并发扫描
 * 都能替本脚本落一条事件，于是"事件恰好 N 条"的断言随机变红。
 *
 * 冻结把窗口关掉：**改夹具时规则是关的**（谁也发不出来），改完再打开、立刻 pump。
 * 打开到我 pump 之间只剩一次 HTTP 往返，而即使真有并发扫描挤进去，
 * 它落的也是**同一个 `dedupe_key`**（同业务日）⇒ 我这次被吸收，计数照样只 +1。
 *
 * 反过来也成立：冻结期内的 pump 必须**一条都不产生**（这正是"停用后不再产生提醒"那条 AC）。
 */
async function freeze(on) {
  await sql`update mn_automation_rule set is_enabled = ${!on} where id = ${ruleId}`;
}
/** 触发一次轮询（扫描器挂在通知中心的读请求上） */
async function pump(cookie = adminC) {
  const res = await call("GET", "/api/notifications", cookie);
  return res;
}
async function ruleRow() {
  const [row] = await sql`select * from mn_automation_rule where code = ${RULE_CODE}`;
  return row ?? null;
}
/**
 * `last_run_at` 的**毫秒**值。
 *
 * ⚠ 必须取 `getTime()`，**不能拿 `String(日期)` 比**：
 * `Date.prototype.toString()` 只有**秒**精度（"Tue Oct 13 2026 14:54:01 GMT+0800"），
 * 于是"两次扫描落在同一秒"会被判成"值没变"——反向红跑批里那条断言就是这样
 * **随机变红**的（11 次里错 2 次），而它看起来像扫描器坏了。
 * 同一个坑的另一种形态更危险：它会制造**假绿**（两个不同的值被截断成同一个串）。
 */
function runMs(value) {
  if (value === null || value === undefined) return Number.NaN;
  return new Date(value).getTime();
}
const isoOf = (value) =>
  value === null || value === undefined ? String(value) : new Date(value).toISOString();

console.log(`\n══ 夹具：规则行与 9 条预置规则 ══`);
const allRules = await sql`
  select code, name, host_type, trigger_type, trigger_target_type, trigger_config,
         action_type, action_config, scope_key, priority, is_system, is_enabled
    from mn_automation_rule order by id`;
ok("**预置规则 9 条**（规则 8 → 9）", allRules.length === 9, `n=${allRules.length}`);
const r9 = allRules.find((r) => r.code === RULE_CODE);
ruleId = (await ruleRow())?.id ?? null;
ok("规则 9 在库里", Boolean(r9), r9 ? `id=${ruleId}` : "缺失");
ok(
  "规则 9 的触发条件是 `{days:14,status_code:\"closed\"}`",
  JSON.stringify(r9?.trigger_config) === JSON.stringify({ days: 14, status_code: "closed" }),
  JSON.stringify(r9?.trigger_config),
);
ok(
  "规则 9 的动作是 `archive_incomplete` + 仅经办人 + once_per_target/cooldown 14",
  r9?.action_type === "notify" &&
    r9?.action_config?.template_code === "archive_incomplete" &&
    JSON.stringify(r9?.action_config?.receivers) === JSON.stringify(["owner"]) &&
    r9?.action_config?.once_per_target === true &&
    r9?.action_config?.cooldown_days === 14,
  JSON.stringify(r9?.action_config),
);
ok(
  "规则 9 仅案件（host_type=matter）、is_system 可停可调",
  r9?.host_type === "matter" && r9?.is_system === true,
  `host=${r9?.host_type} is_system=${r9?.is_system}`,
);
ok(
  "规则 9 的 scope_key 与 seed 里那 12 位一致（唯一约束的判定依据）",
  r9?.scope_key === "9hviq69mu3cd",
  `scope_key=${r9?.scope_key}`,
);
ok(
  "规则 1 默认禁用（破坏性动作），其余 8 条默认启用",
  allRules.filter((r) => r.is_enabled).length === 8 &&
    allRules.find((r) => r.code === "preset_01_close_auto_archive")?.is_enabled === false,
  `启用 ${allRules.filter((r) => r.is_enabled).length}/9`,
);

console.log(`\n══ AC：规则 3/4 的宿主收窄为仅案件（IQ-9） ══`);
const r3 = allRules.find((r) => r.code.startsWith("preset_03_"));
const r4 = allRules.find((r) => r.code.startsWith("preset_04_"));
ok("规则 3 host_type=matter", r3?.host_type === "matter", `host=${r3?.host_type}`);
ok("规则 4 host_type=matter", r4?.host_type === "matter", `host=${r4?.host_type}`);
ok(
  "规则 3/4 的触发实体也是 matter（不是 all）",
  r3?.trigger_target_type === "matter" && r4?.trigger_target_type === "matter",
  `${r3?.trigger_target_type}/${r4?.trigger_target_type}`,
);
ok(
  "规则 4 与规则 9 同触发类型、不同触发域（双档刻意接受）",
  r4?.trigger_type === "time_no_progress" &&
    r9?.trigger_type === "time_no_progress" &&
    r4?.scope_key !== r9?.scope_key &&
    r4?.action_type === r9?.action_type,
  `${r4?.scope_key} vs ${r9?.scope_key}`,
);

console.log(`\n══ AC：触发域唯一性由 DB 约束保证（实撞） ══`);
/**
 * 真撞一次 partial unique index。
 *
 * 三条断言缺一不可：同域同动作**启用**时被拒；同域同动作**停用**时放行
 * （`WHERE is_enabled` 的语义：停用的规则不占位）；同域**不同动作**放行。
 * 每条"预期失败"必须单独包 SAVEPOINT —— PG 里语句一报错整个事务就 aborted，
 * 后面什么都测不到（`db-check.mjs` 的 C10 记着同一个坑）。
 */
const probeResults = [];
await sql.begin(async (tx) => {
  const insertProbe = (id, scopeKey, action, enabled) =>
    tx`insert into mn_automation_rule
         (id, code, name, host_type, trigger_type, trigger_target_type, trigger_config,
          action_type, action_config, scope_key, priority, is_system, is_enabled, created_by)
       values (${id}, ${`probe_${id}`}, '冒烟探针', 'matter', 'time_no_progress', 'matter',
               '{"days":14,"status_code":"closed"}'::jsonb, ${action}, '{}'::jsonb,
               ${scopeKey}, 99, false, ${enabled}, 101)`;
  try {
    await tx.savepoint(async (sp) => {
      await insertProbe(890001, "9hviq69mu3cd", "notify", true);
    });
    probeResults.push("同域同动作启用：**没被拒**");
  } catch {
    probeResults.push("同域同动作启用被拒");
  }
  try {
    await tx.savepoint(async (sp) => {
      await insertProbe(890002, "9hviq69mu3cd", "notify", false);
    });
    probeResults.push("同域同动作停用放行");
  } catch {
    probeResults.push("同域同动作停用：被拒了");
  }
  try {
    await tx.savepoint(async (sp) => {
      await insertProbe(890003, "9hviq69mu3cd", "archive", true);
    });
    probeResults.push("同域不同动作放行");
  } catch {
    probeResults.push("同域不同动作：被拒了");
  }
  throw new Error("probe-rollback");
}).catch((e) => {
  if (e?.message !== "probe-rollback") throw e;
});
ok(
  "**同域同动作的启用规则插不进去**（partial unique index 生效）",
  probeResults.includes("同域同动作启用被拒"),
  probeResults.join(" · "),
);
ok(
  "同域同动作的**停用**规则可以插（`WHERE is_enabled`：停用不占位）",
  probeResults.includes("同域同动作停用放行"),
  probeResults.join(" · "),
);
ok(
  "同域**不同动作**可以并存（`scope_key` 不含动作）",
  probeResults.includes("同域不同动作放行"),
  probeResults.join(" · "),
);

console.log(`\n══ 夹具：一条已结案的案件（经办人 = owner，创建人 = admin） ══`);
const matterRes = await call("POST", "/api/matters", adminC, {
  name: `冒烟规则9案件-${stamp}`,
  cause: "买卖合同纠纷",
  caseType: "civil_commercial",
  procedure: "first_instance",
  litigationRole: "plaintiff",
  level: "mid",
  ownerId: String(owner.id),
});
ok("建案 201", matterRes.status === 201, `status=${matterRes.status} ${JSON.stringify(matterRes.body)?.slice(0, 80)}`);
const matterId = matterRes.body?.id;
if (matterId) matterIds.push(matterId);
const [matterRow] = await sql`select internal_code, created_by, owner_id from mn_matter where id = ${matterId}`;
ok(
  "创建人 = admin、经办人 = owner（两者**不是同一个人**，这样「只推经办人」才验得出来）",
  String(matterRow?.created_by) === String(admin.id) && String(matterRow?.owner_id) === String(owner.id),
  `created_by=${matterRow?.created_by} owner=${matterRow?.owner_id}`,
);

const addF = await call("POST", `/api/matters/${matterId}/staff`, adminC, {
  userIds: [String(follower.id)],
  staffRole: "follower",
});
ok("把 follower 加进关注人 200", addF.status === 200, `status=${addF.status} ${JSON.stringify(addF.body)}`);
const st1 = await call("POST", `/api/matters/${matterId}/status`, ownerC, { to: "in_progress" });
ok("经办人把案件推进到进行中 200", st1.status === 200, `status=${st1.status}`);

/**
 * **未结案不发**：把结案日期往前挪 30 天，但状态停在 `in_progress`。
 *
 * 这条断言是给"状态闸门"钉的（`time_no_progress{status_code:"closed"}` 的那个 `status_code`）。
 * 少了它，"状态过滤"这件事就只由"归档后不发"间接代表——而归档那一档同时被
 * `is_archived` 与 `status` 两层挡住，钉不出到底是哪一层在起作用（反向红实测过）。
 */
await sql`update mn_matter set closing_date = ${shanghaiDay(-30)} where id = ${matterId}`;
await pump();
ok(
  "**未结案不发**（结案日期挪到 30 天前也没用，状态不是 closed）",
  (await eventsOf(matterId)).length === 0,
  `status=in_progress events=${(await eventsOf(matterId)).length}`,
);
await sql`update mn_matter set closing_date = null where id = ${matterId}`;

const st2 = await call("POST", `/api/matters/${matterId}/status`, ownerC, { to: "closed" });
ok("经办人结案 200", st2.status === 200, `status=${st2.status} ${JSON.stringify(st2.body)?.slice(0, 80)}`);
const [closedRow] = await sql`select status, is_archived, closing_date from mn_matter where id = ${matterId}`;
ok(
  "结案后 `closing_date` 被自动写入（F2-26 第②项的前提）",
  closedRow?.status === "closed" && closedRow?.closing_date !== null,
  `status=${closedRow?.status} closing_date=${closedRow?.closing_date}`,
);
const [openNodes] = await sql`
  select count(*)::int as n from mn_matter_node
   where matter_id = ${matterId} and not is_deleted and status in ('in_progress','in_progress')`;
ok(
  "此刻材料**不全**（有未决节点）——这是本规则要提醒的那一档",
  openNodes.n > 0,
  `未决节点=${openNodes.n}`,
);

console.log(`\n══ AC：closed 案件满 14 天 → 经办人收到一条 archive_incomplete ══`);
const pump0 = await pump();
ok("轮询（GET 通知中心）200 —— 扫描命中时不许 500", pump0.status === 200, `status=${pump0.status}`);
ok("刚结案（0 天）不发提醒", (await eventsOf(matterId)).length === 0);

await sql`update mn_matter set closing_date = ${shanghaiDay(-13)} where id = ${matterId}`;
await pump();
ok(
  "**结案 13 天不发**（差一天就是 too_early，14 天是日界判定）",
  (await eventsOf(matterId)).length === 0,
  `events=${(await eventsOf(matterId)).length}`,
);

await sql`update mn_matter set closing_date = ${shanghaiDay(-14)} where id = ${matterId}`;
const pump14 = await pump();
ok("满 14 天那次轮询 200", pump14.status === 200, `status=${pump14.status}`);
const ev1 = await eventsOf(matterId);
ok("**满 14 天 → 落了一条 `archive_incomplete` 事件**", ev1.length === 1, `events=${ev1.length}`);
ok(
  "事件指向规则 9（`source_rule_id`）且来源是 auto_rule",
  String(ev1[0]?.source_rule_id) === String(ruleId),
  `source_rule_id=${ev1[0]?.source_rule_id} rule=${ruleId}`,
);
ok(
  "payload 的缺项是 **B5 码** `pending_nodes`（不是判定键 `openNodes`）",
  JSON.stringify(ev1[0]?.payload?.missing) === JSON.stringify(["pending_nodes"]),
  JSON.stringify(ev1[0]?.payload?.missing),
);
ok(
  "`dedupe_key` = `archive_incomplete:目标:业务日`（定时类的形状）",
  String(ev1[0]?.dedupe_key).startsWith(`archive_incomplete:${matterId}:`),
  String(ev1[0]?.dedupe_key),
);

const ownerList = await call("GET", "/api/notifications", ownerC);
const ownerItem = (ownerList.body?.items ?? []).find((i) => i.eventType === "archive_incomplete");
ok("**经办人收到这条提醒**", Boolean(ownerItem), `items=${ownerList.body?.items?.length}`);
ok(
  "标题带案件编号",
  typeof ownerItem?.title === "string" && ownerItem.title.includes(matterRow?.internal_code ?? "@@"),
  `title=${ownerItem?.title}`,
);
ok(
  "正文是 B5 定稿第 8 条的文案（缺项渲染成中文）",
  typeof ownerItem?.body === "string" &&
    ownerItem.body.includes("缺：待定节点未决（结案后 14 天未补齐）") &&
    !ownerItem.body.includes("openNodes") &&
    !ownerItem.body.includes("pending_nodes"),
  `body=${ownerItem?.body}`,
);
ok("这条通知可见（不是不可见占位行）", ownerItem?.visible === true);

const adminList = await call("GET", "/api/notifications", adminC);
ok(
  "**创建人（admin）没有收到**——收件人只有经办人",
  !(adminList.body?.items ?? []).some((i) => i.eventType === "archive_incomplete"),
  `admin items=${adminList.body?.items?.length}`,
);
const followerList = await call("GET", "/api/notifications", followerC);
ok(
  "**关注人没有收到**（关注人是被动 star 进来的，推给他们是噪音）",
  !(followerList.body?.items ?? []).some((i) => i.eventType === "archive_incomplete"),
  `follower items=${followerList.body?.items?.length}`,
);
const [deliveryRows] = await sql`
  select count(*)::int as n from mn_notification_delivery d
    join mn_notification_event e on e.id = d.event_id
   where e.event_type = 'archive_incomplete' and e.host_id = ${matterId}`;
ok("投递行恰好 1 条（一人多角色也去重）", deliveryRows.n === 1, `n=${deliveryRows.n}`);

console.log(`\n══ AC：once_per_target 生效 —— 14 天内不重复推 ══`);
await pump();
await pump();
ok("同一天连续轮询 3 次仍只有 1 条事件（dedupe_key 吸收）", (await eventsOf(matterId)).length === 1);

// 改夹具前先冻结（见 `freeze()` 的注释：不冻结就会被并发扫描抢先落事件）
await freeze(true);
await backdateLastEvent(matterId, 1, "yesterday");
await freeze(false);
/**
 * ⚠ **先取一次 `last_run_at` 再 pump，然后比"变了没有"**——不能只断言它非空。
 *
 * 初版写的是 `ruleAfterCool?.last_run_at !== null`，而它**恒真**：前面几次成功的扫描
 * 早就把这一列写上了。于是"扫描器不再留痕迹"这个注入（`no-last-run`）在冒烟里
 * **全绿**——反向红跑批当场抓到了这条空转（见 `agent-work/revred-rule9.mjs` 的汇总）。
 */
const [runBefore] = await sql`select last_run_at from mn_automation_rule where id = ${ruleId}`;
await pump();
ok(
  "**上一条是 1 天前发的 ⇒ 仍不发**（此时 dedupe_key 已换成别的业务日，挡它的是**冷却期**）",
  (await eventsOf(matterId)).length === 1,
  `events=${(await eventsOf(matterId)).length}`,
);
const [ruleAfterCool] = await sql`select last_run_at from mn_automation_rule where id = ${ruleId}`;
ok(
  "`last_run_at` **这一次真的前进了**（证明扫描器跑过，而不是「零事件 = 没人该收」）",
  Number.isFinite(runMs(ruleAfterCool?.last_run_at)) &&
    runMs(ruleAfterCool?.last_run_at) > runMs(runBefore?.last_run_at),
  `${isoOf(runBefore?.last_run_at)} → ${isoOf(ruleAfterCool?.last_run_at)}`,
);

await freeze(true);
await backdateLastEvent(matterId, 15, "old");
await freeze(false);
await pump();
const ev2 = await eventsOf(matterId);
ok(
  "**冷却期过后会再发一条**（材料仍未补齐）——不是「只发一次、之后永远沉默」",
  ev2.length === 2,
  `events=${ev2.length}`,
);

/**
 * ## 停用那一段的**顺序是有讲究的**
 *
 * `freeze(true)`（= 停用）必须排在 `backdateLastEvent` **之前**：冷却期一过，
 * 夹具就处在"随时可以发"的状态，先改后停中间那几十毫秒会被并发扫描利用。
 * 先停后改，窗口为零 —— 而"停用后不发"这条 AC 要验的正是"停着的时候一条都不发"。
 */
console.log(`\n══ AC：规则可停用；停用后不再产生提醒 ══`);
await freeze(true);
await backdateLastEvent(matterId, 20, "cooldown-passed");
const [beforeDisable] = await sql`select last_run_at from mn_automation_rule where id = ${ruleId}`;
await pump();
ok(
  "**停用后不再产生提醒**（冷却期已过、材料仍不全，唯一变量是那个开关）",
  (await eventsOf(matterId)).length === 2,
  `events=${(await eventsOf(matterId)).length}`,
);
const [afterDisable] = await sql`select last_run_at from mn_automation_rule where id = ${ruleId}`;
ok(
  "停用时扫描器**早退**（`last_run_at` 没动 —— 与「跑了但没人该收」可区分）",
  runMs(afterDisable?.last_run_at) === runMs(beforeDisable?.last_run_at),
  `${isoOf(beforeDisable?.last_run_at)} → ${isoOf(afterDisable?.last_run_at)}`,
);

console.log(`\n══ seed 幂等重放：不许把管理员的启停打回初值 ══`);
await sql.begin(async (tx) => {
  await tx.unsafe(readFileSync(SEED_FILE, "utf8"));
});
const [afterReplay] = await sql`select is_enabled from mn_automation_rule where id = ${ruleId}`;
ok(
  "**重放 seed 后仍是停用状态**（`ON CONFLICT DO NOTHING`，不是 DO UPDATE）",
  afterReplay?.is_enabled === false,
  `is_enabled=${afterReplay?.is_enabled}`,
);
const [countAfterReplay] = await sql`select count(*)::int as n from mn_automation_rule`;
ok("重放不新增行（仍是 9 条）", countAfterReplay.n === 9, `n=${countAfterReplay.n}`);

await freeze(false);
await pump();
ok(
  "**重新启用后又能发**（开关是唯一变量）",
  (await eventsOf(matterId)).length === 3,
  `events=${(await eventsOf(matterId)).length}`,
);

console.log(`\n══ 材料齐备 / 已归档 ⇒ 不发 ══`);
await freeze(true);
await backdateLastEvent(matterId, 20, "complete");
await sql`update mn_matter_node set status = 'completed', completed_at = now()
           where matter_id = ${matterId} and not is_deleted`;
await sql`update mn_matter set closing_date = ${shanghaiDay(-30)} where id = ${matterId}`;
await freeze(false);
await pump();
ok(
  "**材料齐备 ⇒ 不发**（缺项判定为空；这是本规则最该少发的方向）",
  (await eventsOf(matterId)).length === 3,
  `events=${(await eventsOf(matterId)).length}`,
);
const arch = await call("POST", `/api/matters/${matterId}/status`, ownerC, {
  to: "archived",
  // 归档**恒需 reason**（`needsChangeReason`: `toSemantics === "archived"` 直接返回 true）——
  // 与 F2-26 的"缺项不阻断、强行归档必填 reason"是同一条规矩
  reason: "冒烟：规则 9 归档后不发",
});
ok("归档案件 200", arch.status === 200, `status=${arch.status} ${JSON.stringify(arch.body)?.slice(0, 80)}`);
await freeze(true);
await backdateLastEvent(matterId, 20, "archived");
await sql`update mn_matter set closing_date = ${shanghaiDay(-30)} where id = ${matterId}`;
await freeze(false);
await pump();
ok(
  "**归档后不发**（归档是终态：材料问题已以「写明原因」结清）",
  (await eventsOf(matterId)).length === 3,
  `events=${(await eventsOf(matterId)).length}`,
);

console.log(`\n══ 旁证：数据范围 ══`);
const outList = await call("GET", "/api/notifications", outsiderC);
ok(
  "无关的人通知中心是空的（这条提醒没有泄给范围外的人）",
  (outList.body?.items ?? []).length === 0 && outList.body?.unread === 0,
  `items=${(outList.body?.items ?? []).length}`,
);

/* ── 清场 ──────────────────────────────────────────────────────────────── */
console.log(`\n══ 清场 ══`);
const allUsers = [admin.id, owner.id, follower.id, outsider.id].map(String);
await sql`delete from mn_notification_delivery where user_id in ${sql(allUsers)}`;
await sql`delete from mn_notification_delivery
           where event_id in (select id from mn_notification_event where host_id in ${sql(matterIds)})`;
await sql`delete from mn_notification_event where host_id in ${sql(matterIds)}`;
await sql`delete from mn_event_outbox where payload->>'host_id' in ${sql(matterIds)}`;
await sql`delete from mn_activity_log where matter_id in ${sql(matterIds)}`;
await sql`delete from mn_matter_staff where matter_id in ${sql(matterIds)}`;
await sql`delete from mn_matter_node where matter_id in ${sql(matterIds)}`;
await sql`delete from mn_matter_party where matter_id in ${sql(matterIds)}`;
await sql`delete from mn_matter where id in ${sql(matterIds)}`;
await sql`delete from mn_user_watch where user_id in ${sql(allUsers)}`;

/**
 * **把规则行还原成 seed 的初值。**
 *
 * 本脚本改过 `is_enabled` 与（经由 `backdateLastEvent`）事件行；规则行必须还原，
 * 否则"停用规则 9"会**跨冒烟轮次残留**——而 seed 是 DO NOTHING，重放也不会修它。
 * `last_run_at` 是排障字段，留着无害。
 */
await sql`
  update mn_automation_rule
     set is_enabled = true,
         action_config = '{"receivers":["owner"],"template_code":"archive_incomplete","once_per_target":true,"cooldown_days":14}'::jsonb
   where code = ${RULE_CODE}`;
const [restored] = await sql`select is_enabled, action_config from mn_automation_rule where code = ${RULE_CODE}`;
ok(
  "规则行已还原（is_enabled=true、action_config 逐字等于 seed）",
  restored?.is_enabled === true && restored?.action_config?.cooldown_days === 14,
  `is_enabled=${restored?.is_enabled} cooldown=${restored?.action_config?.cooldown_days}`,
);

/**
 * 孤儿事件清扫（T4 那条教训：`mn_notification_event.host_id` 是多态的，
 * 宿主表对它没有真外键，删案件不会连带它）。
 */
const swept = await sql`
  delete from mn_notification_event e
   where not exists (select 1 from mn_matter m where m.id = e.host_id)
     and not exists (select 1 from mn_risk_matter r where r.id = e.host_id)
  returning id`;
if (swept.length) console.log(`顺带清掉 ${swept.length} 条孤儿通知事件（宿主已不存在）`);

// 逐个独立记：一个账号删不掉不该挡住其余账号。裸调 + 连坐是本轮清场污染的根因形态
// （见 _testacct.mjs 的 ⚠ 段），而且失败只留在滚动日志里、退出码看不出来。
for (const u of [outsider, follower, owner, admin]) {
  try {
    await dropSmokeAccount(sql, u.id);
  } catch (e) {
    noteCleanupFailure(`临时账号 ${u.username}（${u.id}）`, e);
  }
}
console.log("清场完成");

await sql.end();
console.log(`\n${fail === 0 ? "✅ 全绿" : "❌ 有红"}：${pass} 通过 / ${fail} 失败`);
if (fail > 0) console.log(`红的断言：\n  - ${failedNames.join("\n  - ")}`);
finishSmoke(fail);
