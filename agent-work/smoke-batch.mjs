import {
  createSmokeAccount,
  dropSmokeAccount,
  finishSmoke,
  noteCleanupFailure,
  ROLE_CODES,
} from "./_testacct.mjs";
/**
 * 批量低风险动作的真 HTTP 冒烟（MATT-45：改状态 / 归档 / 加标签）。
 *
 * ## 六条断言，每条都对着票面的一个"最容易做错的地方"
 *
 *  ① **不可见的行静默排除**：L3 提交 `[自己的案件, L1 的案件]`，响应里**不能出现** L1 那条的 id
 *     ——既不在 `applied`、也不在 `skipped`。把"看不见"混进跳过数，等于用
 *     `skipped.length` 回答了"你提交的 id 里有几个存在但你看不见"（元规则 3 的探测面）。
 *     同时验"那条真的没被动"（否则"没报"可能只是"报了但没生效"）。
 *  ② **跳过只算"看得见但没做成"**：护栏 1 拒绝（协办改状态）、这一步要原因、
 *     目标与现状相同、撤销归档缺特权、归档终态不可写——五种各一条断言。
 *  ③ **撤销归档要 `can_unarchive`**：L3（self_operator，无该特权）把已归档的行改到非归档态
 *     → 跳过 `privilege_required` 且库里仍是归档；L1（full_admin，有该特权）同一条请求 → 成功。
 *     另有一条**反向**的：把一条已归档的行再归档是空操作，报 `unchanged` 而**不是**缺特权
 *     ——为空操作报"你没有撤销归档权限"会把人引到错误的结论上。
 *  ④ **加标签是追加不是替换**、重复提交幂等、归档行一律拒、跨宿主标签 422。
 *  ⑤ **审计逐条写既有动作值**：一次归档 2 条 = 2 条 `ARCHIVED`；标签写 `MATTER_UPDATED`
 *     且 `field_diffs.tag_ids` 里是**字符串**（BigInt 进不了 `JSON.stringify`，那样整批会 500）。
 *  ⑥ **明确排除项**：`action:"delete"` / `"convert"` → 400，且跑完之后夹具行**一条都没少**
 *     （批量删除不存在）、`mn_risk_matter_case` 里 0 行（批量转案件不存在）。
 *
 * ## 为什么夹具是这三个账号
 *
 *   · L1 = `full_admin` + `is_admin`：数据范围 all（看得见全部）+ `can_unarchive`。
 *   · L3 = `self_operator`：范围 owned（**只看得见自己经办或自己创建的**），**没有** `can_unarchive`。
 *   · L2 = `joined_operator`：范围 participating（靠 `*_staff` 行看得见），**不是**负责人
 *     ——护栏 1 需要"看得见但改不动"的账号，L3 自己当不了（它是自己案件的负责人）。
 *
 * ⚠ L2 与 L3 **不能混用**（`visibility.ts` 的注释与 smoke-staff 都记过这条）：
 * L3 的范围刻意不含 `*_staff`，所以"把 L3 加成协办"之后 L3 依然看不见那条案件。
 *
 * 用法：`node agent-work/smoke-batch.mjs`（需 `next dev`/standalone 在 3777 上跑，且库可用）
 */
const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";

/**
 * 看门狗：整脚本 150 秒还没跑完就自杀。
 *
 * 加它的原因是一次真实事故（本票验证时）：库的隧道**中途**断了，而当时连接已经建好，
 * 于是某条查询永远不返回——脚本不报错、不退出、CPU 恒为 0，看起来像"还在跑"。
 * 反向红那几步是"注入缺陷 → 跑冒烟 → 还原"，脚本挂住会让**缺陷一直留在工作区里**，
 * 而下一个不知道的人会把它当成正常代码继续往上写。宁可红，不可挂。
 */
const WATCHDOG_MS = 150_000;
const watchdog = setTimeout(() => {
  console.log(`\n[FAIL] 看门狗：${WATCHDOG_MS / 1000} 秒未跑完（库/服务端卡住了？），强制退出`);
  process.exit(1);
}, WATCHDOG_MS);

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
function section(title) {
  console.log(`\n── ${title} ──`);
}

/**
 * 跳过原因的全集。与 `src/shared/schema/batch.ts` 的 `BATCH_SKIP_REASON_LABELS` **逐字对应**：
 * 服务层多产出一个这里没有的值，说明界面会渲染出一句空白（那是"跳过 3 条但只解释 2 条"）。
 * 脚本是纯 .mjs，导不进 TS 模块——与 `_testacct.mjs` 复制口令派生规则同一条理由：
 * 两边不一致时，本脚本的断言会红，那正是我们想要的。
 */
const SKIP_REASONS = ["forbidden", "reason_required", "unchanged", "privilege_required", "archived"];

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

const stamp = Date.now();
const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  // 连不上就 10 秒内失败：隧道断着的时候（TCP 端口在听、握手不完成），
  // 默认超时会让这个脚本挂到人以为它卡死了——而它其实什么都还没做。
  connect_timeout: 10,
});

/**
 * 先探一次连接，失败就给**一句人话**再退出。
 *
 * 不探的代价是实测过的：夹具账号是在 `try` 之前建的，隧道断着时那里会抛一个
 * 未捕获的 `CONNECT_TIMEOUT` 栈——没有 `[FAIL]` 行、没有汇总行，读日志的人得自己
 * 认出这是"库不可用"而不是"脚本有 bug"。而库不可用正是本仓最常见的运行环境。
 */
try {
  await sql`select 1`;
} catch (e) {
  console.log(
    `[FAIL] 连不上库（${process.env.PGHOST}:${process.env.PGPORT}）—— ${String(e.message).split("\n")[0]}`,
  );
  console.log("       库不可用时这个冒烟无法运行；这不是断言失败。");
  await sql.end({ timeout: 2 }).catch(() => {});
  process.exit(1);
}

/**
 * `--probe`：只探"库现在能不能用"就退出（成功打印 `[probe] 库可用`）。
 *
 * 为什么要有它：本机到库的隧道会**分钟级地断断续续**（本票验证时就撞上过三轮），
 * 而反向红那几步是"注入缺陷 → 跑冒烟 → 还原"。拿整脚本当探针的话，
 * 一次探测要跑 25 秒，而且探到"可用"之后留给真正那轮冒烟的窗口可能已经过去了
 * ——结果是**缺陷注入着、冒烟却什么都没验成**。`--probe` 是 10 秒内出结果的一条命令，
 * 让重试循环既便宜又安全（探测阶段不注入任何东西）。
 */
if (process.argv.includes("--probe")) {
  console.log(`[probe] 库可用（${process.env.PGHOST}:${process.env.PGPORT}）`);
  await sql.end({ timeout: 2 }).catch(() => {});
  process.exit(0);
}

/**
 * 摘要校验：`{applied: number, skipped: [{id, reason}]}` 且每个 reason 都在字典里。
 * 形状本身也要验：`BatchSummary` 是前后端共用的一份 DTO，多一个字段就说明
 * "未处理条数"之类的口径被偷偷加回来了（那正是本票第 1 条要防的）。
 */
function summaryOk(r) {
  if (r.status !== 200) return false;
  const b = r.body ?? {};
  if (typeof b.applied !== "number" || !Array.isArray(b.skipped)) return false;
  if (Object.keys(b).length !== 2) return false;
  return b.skipped.every(
    (s) => typeof s.id === "string" && SKIP_REASONS.includes(s.reason) && Object.keys(s).length === 2,
  );
}

/** 一条断言里的常用组合：状态 200、摘要形状合法、成功/跳过条数 */
function summaryIs(r, applied, skippedN) {
  return summaryOk(r) && r.body.applied === applied && r.body.skipped.length === skippedN;
}

/** 纯数字 id 列表（来自 API 响应，`BigInt()` 归一化后再拼——不是注入面） */
async function countByIds(table, ids) {
  const list = ids.map((i) => String(BigInt(i))).join(",");
  const [row] = await sql.unsafe(`select count(*)::int n from ${table} where id in (${list})`);
  return row.n;
}

const l1 = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
const l3 = await createSmokeAccount(sql, { roles: [ROLE_CODES.self] });
const l2 = await createSmokeAccount(sql, { roles: [ROLE_CODES.joined] });

/**
 * 夹具标签：**当场建**而不是挑 seed 里已有的。
 * 挑现成的会让断言依赖 seed 的标签清单（运营改一次标签，冒烟就红在与本票无关的地方）；
 * 两个宿主各建一条，还能顺带验"跨宿主标签 → 422"。
 *
 * id 用「时刻 × 1000 + 序号」：随机数在 5 次调用里理论上会撞主键，而撞了的现场表现是
 * "夹具建到一半就中断"，与标签逻辑毫无关系。序号是确定的。
 */
let tagSeq = 0;
const tagBase = BigInt(Date.now()) * 1000n;
const mkTag = async (hostType, suffix) => {
  const [row] = await sql`
    insert into mn_tag (id, name, host_type, color, sort_order, is_system, is_enabled, created_at)
    values (${tagBase + BigInt(++tagSeq)},
            ${`冒烟标签${suffix}-${stamp}`}, ${hostType}, 'slate', 999, false, true, now())
    returning id`;
  return String(row.id);
};
const t1 = await mkTag("matter", "A");
const t2 = await mkTag("matter", "B");
const t3 = await mkTag("matter", "C");
const t4 = await mkTag("matter", "D");
const riskTag = await mkTag("risk_matter", "R");
const riskTag2 = await mkTag("risk_matter", "R2");

const matterIds = [];
const riskIds = [];
const accountIds = [l1.id, l2.id, l3.id];
const tagIds = [t1, t2, t3, t4, riskTag, riskTag2];

async function cleanup() {
  // 顺序按外键：活动日志与从属明细先走，宿主最后（全是 RESTRICT，顺序错会直接报约束名）。
  // ⚠ 每条都记进清场账本，**不许 `.catch(() => {})`**：删不掉的夹具行就是残留在共享库里的
  //   业务行，而它的症状出现在**下一轮**（撞案件号 / 撞证件号 / db:check 红），归因却指不到
  //   本脚本。记账之后 `finishSmoke` 才会把它变成退出码 2。
  for (const id of matterIds) {
    for (const q of [
      `delete from mn_activity_log where matter_id=${id}`,
      `delete from mn_matter_staff where matter_id=${id}`,
      `delete from mn_matter_node where matter_id=${id}`,
      `delete from mn_matter_party where matter_id=${id}`,
      `delete from mn_matter_progress where matter_id=${id}`,
      `delete from mn_comment where target_type='matter' and target_id=${id}`,
      `delete from mn_matter where id=${id}`,
    ]) {
      await sql.unsafe(q).catch((e) => noteCleanupFailure(`夹具行 ${q}`, e));
    }
  }
  for (const id of riskIds) {
    for (const q of [
      `delete from mn_activity_log where risk_matter_id=${id}`,
      `delete from mn_risk_matter_staff where risk_matter_id=${id}`,
      `delete from mn_risk_matter_node where risk_matter_id=${id}`,
      `delete from mn_risk_matter_party where risk_matter_id=${id}`,
      `delete from mn_risk_matter_case where risk_matter_id=${id}`,
      `delete from mn_risk_matter where id=${id}`,
    ]) {
      await sql.unsafe(q).catch((e) => noteCleanupFailure(`夹具行 ${q}`, e));
    }
  }
  await sql`delete from mn_activity_log where operator_id = any(${sql.array(accountIds)}::bigint[])`;
  // `.map(BigInt)`：`sql.array` 的元素类型是从 JS 值推的，字符串会推成 text[]，
  // 再 `::bigint[]` 就多一次靠 PG 隐式转换的运气；给 BigInt 直接对上 int8。
  await sql`delete from mn_tag where id = any(${sql.array(tagIds.map(BigInt))}::bigint[])`;
  await sql`delete from mn_auth_session where user_id = any(${sql.array(accountIds)}::bigint[])`;
  await sql`delete from mn_app_user_role where user_id = any(${sql.array(accountIds)}::bigint[])`;
  for (const u of [l1, l2, l3]) {
    try {
      await dropSmokeAccount(sql, u.id);
    } catch (e) {
      // 不许吞：删不掉通常意味着脚本自己的清场漏了夹具（见 _testacct.mjs 的三类处置）
      noteCleanupFailure(`临时账号 ${u.username}（${u.id}）`, e);
    }
  }
}

try {
  const l1s = await login(l1.username, l1.password);
  const l2s = await login(l2.username, l2.password);
  const l3s = await login(l3.username, l3.password);
  ok(
    "三个夹具账号都能登录",
    l1s.status === 200 && l2s.status === 200 && l3s.status === 200,
    `L1=${l1s.status} L2=${l2s.status} L3=${l3s.status}`,
  );
  /**
   * 登录不成就**立刻停**，别让后面的夹具带着空 cookie 去撞一屏 401。
   *
   * 实测过的形态：隧道在"建号成功"与"登录请求"之间断了，登录回 500，
   * 于是后面每一条断言都以 401 红，最后还因为 `String(undefined)` 拼出的
   * `where id = 'undefined'` 抛一个 PostgresError——满屏红里**没有一条**指向真正的原因
   * （库不可用），读日志的人会以为是实现坏了。一条明确的早停比十条误导的红有用。
   */
  if (l1s.status !== 200 || l2s.status !== 200 || l3s.status !== 200) {
    console.log(
      "[FAIL] 夹具账号登不进去 —— 先看库与服务端是否可用（`--probe` 可单独探库），" +
        "不要把这当成断言失败。",
    );
    throw new Error("login_failed");
  }

  // ---- 夹具：三条案件 + 两条事项 ----
  const mkMatter = (cookie, name) =>
    call("POST", "/api/matters", cookie, {
      name,
      cause: "建设工程施工合同纠纷",
      caseType: "civil_commercial",
      procedure: "first_instance",
      litigationRole: "defendant",
      level: "high",
    });
  const mA = await mkMatter(l3s.cookie, `批量冒烟 mA ${stamp}`); // owner=L3（L3 可见）
  const mB = await mkMatter(l1s.cookie, `批量冒烟 mB ${stamp}`); // owner=L1（L3 **不可见**）
  const mC = await mkMatter(l3s.cookie, `批量冒烟 mC ${stamp}`); // L2 当协办（L2 可见、改不动）
  /**
   * mD 归 L1 且**不进归档态**：标签动作那条"看不见就不动"的断言需要一条对 L3 完全不可见、
   * 又不在归档终态的夹具。
   *
   * ⚠ 不能用 mC 当这条夹具（本轮实测踩过）：mC 是 **L3 建的**，而 `owned` 范围是
   * "我承办 **∪ 我创建**"——L3 看得见自己建的每一条，哪怕经办人是别人。
   * 用它当"看不见的诱饵"时，断言会以 `applied: 2` 红掉，而实现其实是对的
   * ——**夹具选错会把正确的实现判成缺陷**，比漏测更危险。
   * 也不能用 mB：那时它已经归档，归档行会被**报成 skipped: archived**（它是可见的），
   * 而这条断言要验的恰恰是"什么都不报"。
   */
  const mD = await mkMatter(l1s.cookie, `批量冒烟 mD ${stamp}`); // owner=L1，且不归档
  ok(
    "四条夹具案件都建出来了",
    mA.status === 201 && mB.status === 201 && mC.status === 201 && mD.status === 201,
    `mA=${mA.status} mB=${mB.status} mC=${mC.status} mD=${mD.status}`,
  );
  matterIds.push(mA.body?.id, mB.body?.id, mC.body?.id, mD.body?.id);
  // 夹具建不出来就停：下面每一条断言都要用这四个 id，而失败时它们是 `undefined`
  // ——拼进 `where id = 'undefined'` 会抛 PostgresError，把"服务端不可用"伪装成脚本 bug
  if (mA.status !== 201 || mB.status !== 201 || mC.status !== 201 || mD.status !== 201) {
    throw new Error("fixture_failed");
  }
  const idA = String(mA.body.id);
  const idB = String(mB.body.id);
  const idC = String(mC.body.id);
  const idD = String(mD.body.id);

  const addL2 = await call("POST", `/api/matters/${idC}/staff`, l1s.cookie, {
    userIds: [String(l2.id)],
    staffRole: "co_owner",
  });
  ok("L1 把 L2 加成 mC 的协办 → 200", addL2.status === 200, `status=${addL2.status}`);

  const mkRisk = (cookie, name) =>
    call("POST", "/api/risk-matters", cookie, {
      name,
      type: "contract",
      level: "high",
      description: "批量冒烟夹具",
      ownerId: String(l3.id),
    });
  const r1 = await mkRisk(l3s.cookie, `批量冒烟 r1 ${stamp}`);
  const r2 = await mkRisk(l3s.cookie, `批量冒烟 r2 ${stamp}`);
  // r3 归 L1：L3 看不见它（owned 范围 = 我经办 ∪ 我创建），用来验事项侧标签动作的可见性边界
  const r3 = await call("POST", "/api/risk-matters", l1s.cookie, {
    name: `批量冒烟 r3 ${stamp}`,
    type: "contract",
    level: "high",
    description: "批量冒烟夹具（L1 的，L3 不可见）",
    ownerId: String(l1.id),
  });
  ok("三条夹具事项都建出来了", r1.status === 201 && r2.status === 201 && r3.status === 201);
  riskIds.push(r1.body?.id, r2.body?.id, r3.body?.id);
  if (r1.status !== 201 || r2.status !== 201 || r3.status !== 201) {
    throw new Error("fixture_failed");
  }
  const idR1 = String(r1.body.id);
  const idR2 = String(r2.body.id);
  const idR3 = String(r3.body.id);

  const batch = (cookie, payload) => call("POST", "/api/matters/batch", cookie, payload);
  const batchRisk = (cookie, payload) => call("POST", "/api/risk-matters/batch", cookie, payload);
  const statusOf = async (id) => {
    const [row] = await sql`select status, is_archived, archived_at from mn_matter where id = ${id}`;
    return row;
  };
  const tagsOf = async (id) => {
    const [row] = await sql`select tag_ids from mn_matter where id = ${id}`;
    return (row?.tag_ids ?? []).map(String).sort();
  };

  // ---- ① 批量改状态：基本路径 + 审计 ----
  section("① 批量改状态");
  const s1 = await batch(l3s.cookie, { action: "status", ids: [idA], to: "in_progress" });
  ok("L3 把自己那条推到 in_progress → 成功 1 / 跳过 0", summaryIs(s1, 1, 0), JSON.stringify(s1.body));
  ok("库里真的动了", (await statusOf(idA)).status === "in_progress");
  const [audit1] = await sql`
    select action, field_diffs from mn_activity_log
    where matter_id = ${idA} and action = 'STATUS_CHANGED'
    order by created_at desc, id desc limit 1`;
  ok(
    "写了 STATUS_CHANGED 审计（走的是 changeStatus 那一个状态机）",
    audit1?.field_diffs?.status?.from === "pending" && audit1?.field_diffs?.status?.to === "in_progress",
    JSON.stringify(audit1?.field_diffs),
  );

  // ---- ② 不可见静默排除（本票最容易做错的一处）----
  section("② 不可见静默排除");
  const s2 = await batch(l3s.cookie, { action: "status", ids: [idA, idB], to: "closed" });
  ok(
    "**L3 提交 [自己的, L1 的]：成功 1、跳过 0**（看不见的不计入跳过）",
    summaryIs(s2, 1, 0),
    JSON.stringify(s2.body),
  );
  ok(
    "**不可见那条的 id 不出现在响应里的任何位置**（报出来就等于确认了它存在）",
    !JSON.stringify(s2.body ?? {}).includes(idB),
    JSON.stringify(s2.body),
  );
  ok("可见那条确实改了", (await statusOf(idA)).status === "closed");
  ok("**不可见那条一点没动**", (await statusOf(idB)).status === "pending");

  // ---- ② 护栏 1：看得见但改不动 ----
  section("② 护栏 1（协办改状态）");
  const s3 = await batch(l2s.cookie, { action: "status", ids: [idC], to: "in_progress" });
  ok(
    "**协办（可见、非负责人）→ 跳过 forbidden**（403 的语义落进摘要里）",
    summaryIs(s3, 0, 1) && s3.body.skipped[0].reason === "forbidden",
    JSON.stringify(s3.body),
  );
  ok("mC 的状态没动", (await statusOf(idC)).status === "pending");

  // ---- ② 要原因：逐行判（closed → in_progress 不在推荐路径上）----
  section("② 这一步要原因");
  const s4 = await batch(l1s.cookie, { action: "status", ids: [idA], to: "in_progress" });
  ok(
    "L1 不带原因把 closed 推回 in_progress → 跳过 reason_required",
    summaryIs(s4, 0, 1) && s4.body.skipped[0].reason === "reason_required",
    JSON.stringify(s4.body),
  );
  ok("被跳过时库里不动", (await statusOf(idA)).status === "closed");
  const s5 = await batch(l1s.cookie, {
    action: "status",
    ids: [idA],
    to: "in_progress",
    reason: "冒烟：偏离推荐路径",
  });
  ok("带上原因 → 成功 1", summaryIs(s5, 1, 0), JSON.stringify(s5.body));
  ok("状态真的回到 in_progress", (await statusOf(idA)).status === "in_progress");

  // ---- 参数错与排除项：一律 4xx，不退化成"看起来成功的空摘要" ----
  section("③ 参数错 / 明确排除项");
  const badStatus = await batch(l1s.cookie, { action: "status", ids: [idA], to: "nope" });
  ok(
    "目标状态不存在 → 422 bad_status（不是 applied: 0 的空摘要）",
    badStatus.status === 422 && badStatus.body?.error === "bad_status",
    `status=${badStatus.status} err=${badStatus.body?.error}`,
  );
  const emptyIds = await batch(l1s.cookie, { action: "status", ids: [], to: "in_progress" });
  ok("空 ids → 400", emptyIds.status === 400, `status=${emptyIds.status}`);
  const badId = await batch(l1s.cookie, { action: "status", ids: ["abc"], to: "in_progress" });
  ok("非数字 id → 400", badId.status === 400, `status=${badId.status}`);
  const tooMany = await batch(l1s.cookie, {
    action: "status",
    ids: Array.from({ length: 51 }, () => idA),
    to: "in_progress",
  });
  ok(
    "**51 行 → 400**（上限在 schema 层拦，绕开界面也一样）",
    tooMany.status === 400,
    `status=${tooMany.status}`,
  );
  const del = await batch(l1s.cookie, { action: "delete", ids: [idA] });
  ok(
    "**action:delete → 400（不做批量删除）**",
    del.status === 400,
    `status=${del.status}`,
  );
  const conv = await batchRisk(l1s.cookie, { action: "convert", ids: [idR1] });
  ok(
    "**action:convert → 400（不做批量转案件）**",
    conv.status === 400,
    `status=${conv.status}`,
  );
  const typo = await batch(l1s.cookie, { action: "tag", ids: [idA], tags: [t1] });
  ok(
    "tagIds 拼成 tags → 400（`.strict()`：静默剥离会让用户以为标签加上了）",
    typo.status === 400,
    `status=${typo.status}`,
  );

  // ---- ④ 批量归档：原因必填 + 逐条审计 ----
  section("④ 批量归档");
  const noReason = await batch(l1s.cookie, { action: "archive", ids: [idA, idB] });
  ok(
    "归档不带原因 → 400（schema 层就拦，枚举表 §3.2 把 ARCHIVED 列为原因必填）",
    noReason.status === 400,
    `status=${noReason.status}`,
  );
  const arch = await batch(l1s.cookie, {
    action: "archive",
    ids: [idA, idB],
    reason: "冒烟：批量归档",
  });
  ok("L1 批量归档两条 → 成功 2", summaryIs(arch, 2, 0), JSON.stringify(arch.body));
  const aA = await statusOf(idA);
  const aB = await statusOf(idB);
  ok(
    "两条都翻了 is_archived / status / archived_at",
    aA.is_archived === true &&
      aA.status === "archived" &&
      aA.archived_at !== null &&
      aB.is_archived === true &&
      aB.archived_at !== null,
    `A=${JSON.stringify(aA)} B=${JSON.stringify(aB)}`,
  );
  const [archCount] = await sql`
    select count(*)::int n from mn_activity_log
    where action = 'ARCHIVED' and matter_id in (${idA}, ${idB}) and reason = '冒烟：批量归档'`;
  ok(
    "**审计逐条写：2 行 = 2 条 ARCHIVED**（不新造批量动作值，理由见服务层注释）",
    archCount.n === 2,
    `n=${archCount.n}`,
  );

  // ---- ③ 归档的两个特权语义 ----
  section("③ 归档与 can_unarchive");
  const reArchive = await batch(l3s.cookie, {
    action: "archive",
    ids: [idA],
    reason: "冒烟：再归档一次",
  });
  ok(
    "**把已归档的行再归档 → 跳过 unchanged（空操作，不是缺特权）**",
    summaryIs(reArchive, 0, 1) && reArchive.body.skipped[0].reason === "unchanged",
    JSON.stringify(reArchive.body),
  );
  const unarchiveNoPriv = await batch(l3s.cookie, {
    action: "status",
    ids: [idA],
    to: "in_progress",
  });
  ok(
    "**L3（无 can_unarchive）撤销归档 → 跳过 privilege_required**",
    summaryIs(unarchiveNoPriv, 0, 1) &&
      unarchiveNoPriv.body.skipped[0].reason === "privilege_required",
    JSON.stringify(unarchiveNoPriv.body),
  );
  ok("被跳过时它还是归档态", (await statusOf(idA)).is_archived === true);
  const unarchivePriv = await batch(l1s.cookie, { action: "status", ids: [idA], to: "in_progress" });
  ok(
    "L1（持 can_unarchive）同一条请求 → 成功 1",
    summaryIs(unarchivePriv, 1, 0),
    JSON.stringify(unarchivePriv.body),
  );
  const backA = await statusOf(idA);
  ok(
    "撤销归档真的落地（is_archived=false 且 archived_at 清空）",
    backA.is_archived === false && backA.archived_at === null,
    JSON.stringify(backA),
  );

  // ---- ⑤ 批量加标签 ----
  section("⑤ 批量加标签");
  const tag1 = await batch(l1s.cookie, { action: "tag", ids: [idC], tagIds: [t1, t2] });
  ok("给 mC 加两个标签 → 成功 1", summaryIs(tag1, 1, 0), JSON.stringify(tag1.body));
  ok("库里两个都在", (await tagsOf(idC)).join(",") === [t1, t2].sort().join(","));
  const [tagAudit] = await sql`
    select action, field_diffs from mn_activity_log
    where matter_id = ${idC} and action = 'MATTER_UPDATED'
    order by created_at desc, id desc limit 1`;
  ok(
    "审计写 MATTER_UPDATED + field_diffs.tag_ids",
    tagAudit?.field_diffs?.tag_ids?.to?.length === 2,
    JSON.stringify(tagAudit?.field_diffs),
  );
  ok(
    "**审计里的 id 是字符串**（BigInt 进不了 JSON.stringify，那样整批会在写审计时 500）",
    tagAudit?.field_diffs?.tag_ids?.to?.every((v) => typeof v === "string") === true,
    JSON.stringify(tagAudit?.field_diffs?.tag_ids?.to),
  );
  const tagAgain = await batch(l1s.cookie, { action: "tag", ids: [idC], tagIds: [t1, t2] });
  ok(
    "重复加同一批标签 → 跳过 unchanged（幂等）",
    summaryIs(tagAgain, 0, 1) && tagAgain.body.skipped[0].reason === "unchanged",
    JSON.stringify(tagAgain.body),
  );
  const tagMore = await batch(l1s.cookie, { action: "tag", ids: [idC], tagIds: [t3] });
  ok("再加第三个 → 成功 1", summaryIs(tagMore, 1, 0), JSON.stringify(tagMore.body));
  ok(
    "**追加不替换：原来那两个还在**",
    (await tagsOf(idC)).join(",") === [t1, t2, t3].sort().join(","),
    (await tagsOf(idC)).join(","),
  );
  const badTag = await batch(l1s.cookie, { action: "tag", ids: [idC], tagIds: [riskTag] });
  ok(
    "**跨宿主标签（事项的标签加到案件上）→ 422 bad_tag**",
    badTag.status === 422 && badTag.body?.error === "bad_tag",
    `status=${badTag.status} err=${badTag.body?.error}`,
  );
  const ghostTag = await batch(l1s.cookie, { action: "tag", ids: [idC], tagIds: ["999999999"] });
  ok(
    "不存在的标签 → 422 bad_tag",
    ghostTag.status === 422 && ghostTag.body?.error === "bad_tag",
    `status=${ghostTag.status}`,
  );
  const tagArchived = await batch(l1s.cookie, { action: "tag", ids: [idB], tagIds: [t1] });
  ok(
    "**已归档的行加标签 → 跳过 archived**（§5.2 归档是只读终态）",
    summaryIs(tagArchived, 0, 1) && tagArchived.body.skipped[0].reason === "archived",
    JSON.stringify(tagArchived.body),
  );
  ok("归档行的标签没被写", (await tagsOf(idB)).length === 0);
  // 标签动作**没有第二道边界**：这次读就是安全边界，所以专门验一次"看不见就不动"
  const tagInvisible = await batch(l3s.cookie, { action: "tag", ids: [idD, idA], tagIds: [t4] });
  ok(
    "**L3 提交 [看不见的 mD, 自己的 mA]：成功 1、跳过 0**",
    summaryIs(tagInvisible, 1, 0),
    JSON.stringify(tagInvisible.body),
  );
  ok(
    "**看不见的那条标签没被写**（标签动作只有这一道 `scopedWhere`）",
    !(await tagsOf(idD)).includes(t4),
    (await tagsOf(idD)).join(","),
  );
  ok("自己的那条写上了", (await tagsOf(idA)).includes(t4));

  // ---- 事项侧同构 ----
  section("⑥ 事项侧同构（三条动作各一次）");
  const rs = await batchRisk(l3s.cookie, { action: "status", ids: [idR1, idB], to: "in_progress" });
  ok(
    "L3 批量改事项状态（含一条不可见的案件 id）→ 成功 1、跳过 0",
    summaryIs(rs, 1, 0) && !JSON.stringify(rs.body).includes(idB),
    JSON.stringify(rs.body),
  );
  const rArch = await batchRisk(l1s.cookie, {
    action: "archive",
    ids: [idR2],
    reason: "冒烟：批量归档事项",
  });
  ok("L1 批量归档事项 → 成功 1", summaryIs(rArch, 1, 0), JSON.stringify(rArch.body));
  const [r2row] = await sql`select is_archived, status from mn_risk_matter where id = ${idR2}`;
  ok("事项归档落地", r2row.is_archived === true && r2row.status === "archived");
  const rTag = await batchRisk(l1s.cookie, { action: "tag", ids: [idR1], tagIds: [riskTag] });
  ok("给事项加事项标签 → 成功 1", summaryIs(rTag, 1, 0), JSON.stringify(rTag.body));
  const [r1row] = await sql`select tag_ids from mn_risk_matter where id = ${idR1}`;
  ok("事项标签落库", (r1row.tag_ids ?? []).map(String).includes(riskTag));
  // 标签动作**没有第二道边界**（这次读就是边界），事项侧也要验一次——与案件侧那条同构
  const rTagInvisible = await batchRisk(l3s.cookie, {
    action: "tag",
    ids: [idR3, idR1],
    tagIds: [riskTag2],
  });
  ok(
    "**L3 提交 [看不见的 r3, 自己的 r1]：成功 1、跳过 0**",
    summaryIs(rTagInvisible, 1, 0),
    JSON.stringify(rTagInvisible.body),
  );
  const [r3row] = await sql`select tag_ids from mn_risk_matter where id = ${idR3}`;
  ok(
    "**看不见的那条事项标签没被写**",
    !(r3row.tag_ids ?? []).map(String).includes(riskTag2),
    (r3row.tag_ids ?? []).map(String).join(","),
  );
  const [r1row2] = await sql`select tag_ids from mn_risk_matter where id = ${idR1}`;
  ok("自己的那条事项写上了", (r1row2.tag_ids ?? []).map(String).includes(riskTag2));
  const rTagArchived = await batchRisk(l1s.cookie, {
    action: "tag",
    ids: [idR2],
    tagIds: [riskTag],
  });
  ok(
    "已归档的事项加标签 → 跳过 archived",
    summaryIs(rTagArchived, 0, 1) && rTagArchived.body.skipped[0].reason === "archived",
    JSON.stringify(rTagArchived.body),
  );
  const rTagCross = await batchRisk(l1s.cookie, { action: "tag", ids: [idR1], tagIds: [t1] });
  ok(
    "案件的标签加到事项上 → 422 bad_tag（两张宿主的标签表靠 host_type 分列）",
    rTagCross.status === 422,
    `status=${rTagCross.status}`,
  );
  const rUnarchive = await batchRisk(l3s.cookie, {
    action: "status",
    ids: [idR2],
    to: "in_progress",
  });
  ok(
    "**L3 撤销归档事项 → 跳过 privilege_required**（两侧同构）",
    summaryIs(rUnarchive, 0, 1) && rUnarchive.body.skipped[0].reason === "privilege_required",
    JSON.stringify(rUnarchive.body),
  );

  // ---- ⑦ 排除项：跑完全程，一条都没少 ----
  section("⑦ 明确排除项");
  ok(
    "**四条案件都还在**（批量删除不存在：没有任何一条路径会删宿主）",
    (await countByIds("mn_matter", [idA, idB, idC, idD])) === 4,
    `n=${await countByIds("mn_matter", [idA, idB, idC, idD])}`,
  );
  ok(
    "**三条事项都还在**",
    (await countByIds("mn_risk_matter", [idR1, idR2, idR3])) === 3,
    `n=${await countByIds("mn_risk_matter", [idR1, idR2, idR3])}`,
  );
  const [convCount] = await sql`
    select count(*)::int n from mn_risk_matter_case where risk_matter_id in (${idR1}, ${idR2}, ${idR3})`;
  ok(
    "**没有批量转案件的产物**（`mn_risk_matter_case` 0 行）",
    convCount.n === 0,
    `n=${convCount.n}`,
  );
} catch (e) {
  fail++;
  console.log(`[FAIL] 脚本中断 —— ${e?.stack ?? e}`);
} finally {
  clearTimeout(watchdog);
  try {
    await cleanup();
    console.log("[clean] 清场完成");
  } catch (e) {
    noteCleanupFailure("夹具清场", e);
  }
  await sql.end({ timeout: 5 }).catch(() => {});
}

console.log(`\n${fail ? "FAIL" : "PASS"}：${pass} 通过 / ${fail} 失败`);
finishSmoke(fail);
