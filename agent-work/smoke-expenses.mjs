import { createSmokeAccount, dropSmokeAccount, ROLE_CODES } from "./_testacct.mjs";

/**
 * 费用（US-41）+ 整卷两档导出（US-42）的**真 HTTP 冒烟**（MATT-47 / T9）。
 *
 * ## 跑法
 *
 *   node --env-file=.env agent-work/smoke-expenses.mjs     # dev server 在 3777（SMOKE_BASE 可覆盖）
 *
 * 前置：迁移 0011 的三张表要在库里（`node --env-file=.env agent-work/_apply-0011.mjs`
 * 是本票的自用装置 —— 它不碰 drizzle 账本，理由见那个文件头注），
 * 以及费用项目 seed（`seed/0004_expense_item_config.sql`）。
 *
 * ## 先反向红一次（本仓纪律：没有反向红的冒烟等于没有冒烟）
 *
 *   node agent-work/revred-expenses.mjs inject unconvert   # 拆掉撤销前置里的费用那条
 *   node --env-file=.env agent-work/smoke-expenses.mjs     # ⇒ 必须红（只红那一条）
 *   node agent-work/revred-expenses.mjs restore
 *   node --env-file=.env agent-work/smoke-expenses.mjs     # ⇒ 必须全绿
 *
 * ## 断言清单（票面逐条）
 *
 *   ① **金额精度**：列是 `numeric(18,2)`（`information_schema` 直查），
 *      `SUM` 的出口是两位小数字符串 —— `0.10 + 0.20` 必须是 `"0.30"` 而不是 `"0.3"`
 *      （float 或 `Number()` 往返都会把它变成 `0.3`，且**不报错**）；
 *   ② **费用项目走配置**：`/api/meta` 给项目清单；未知项目 / 已停用项目 → 422；
 *   ③ CRUD + 合计 + 按项目分组（F2-13）；
 *   ④ 事项侧同构（建、列、读、导全走一遍）；
 *   ⑤ **导出两档**：默认脱敏（证件号只留尾四位）；明文要 `can_read_plain`；
 *   ⑥ 无 `can_read_plain` 者调明文导出 → **403 privilege_required**（失败用例留断言）；
 *   ⑦ **整卷写 `EXPORT` 审计**：载荷 `{target_type, scope, rows, count, plain}`，
 *      **不含行内容**（连载荷 JSON 里都不许出现证件号）；
 *   ⑧ **撤销转案件的前置**：目标案件有费用 → 422 blocked（映射矩阵 §5.1）；
 *      软删掉那笔费用之后撤销重新可用；
 *   ⑨ 数据范围：看不见这条案卷的人拿 404（列表/单条/导出三处一致）；
 *   ⑩ 归档态只读：读 200、写 403。
 *
 * 清场：本脚本自己造的案件/事项/费用/当事人/活动日志全删，再删两个临时账号。
 * **不断言全局计数**（同库上有别的流在跑冒烟）：所有期望值都由本脚本的夹具自己算出来。
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

const stamp = Date.now();
const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

/** L1：full_admin + is_admin + `can_read_plain` */
const smoke = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
/** L2：joined_operator，**没有** `can_read_plain` —— 用来撞明文导出的那道 403 */
const smoke2 = await createSmokeAccount(sql, { roles: [ROLE_CODES.joined] });

const matterIds = [];
const riskIds = [];
const partyIds = [];
/** 直连库造的夹具行（停用项目），清场要单独删 */
const extraItemIds = [];

/** 夹具：一笔小额 + 一笔大额，用来钉住"两位小数"与"18 位精度" */
const PARTY = {
  name: `费用冒烟当事人${stamp}`,
  idNumber: `91320100MA1X7${String(stamp).slice(-5)}Z`,
};
const AMOUNTS = { small: "0.10", small2: "0.20", big: "12345678901234.56", patched: "0.35" };
/** 三位小数：必须被 DTO 在入口拒掉（列是 numeric(18,2)） */
const TOO_PRECISE = "1.234";

function matterBody(tag, parties) {
  return {
    name: `费用冒烟案件-${tag}-${stamp}`,
    cause: "买卖合同纠纷",
    caseType: "civil_commercial",
    procedure: "first_instance",
    litigationRole: "plaintiff",
    level: "mid",
    parties,
  };
}
function riskBody(tag, parties) {
  return {
    name: `费用冒烟事项-${tag}-${stamp}`,
    type: "contract",
    level: "mid",
    description: "费用冒烟：只记支出",
    parties,
  };
}
const partyRow = () => ({
  name: PARTY.name,
  type: "legal_person",
  partyRole: "defendant",
  idType: "unified_social_credit",
  idNumber: PARTY.idNumber,
});

/**
 * 删临时账号（**不吞失败**）。
 *
 * 重试一次是因为这台库的隧道**分钟级会抖**：一次瞬断会让"业务行已清干净、
 * 账号却删不掉"留下一个孤儿账号（本轮实测撞到过一次）。重试仍失败就**计一条失败**
 * 并打印 —— 孤儿账号必须被人看见，静默吞掉正是上一轮留下 17 个的原因。
 */
async function dropWithRetry(acct, label) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await dropSmokeAccount(sql, acct.id);
      return;
    } catch (e) {
      if (attempt === 2) {
        console.log(`[clean] ${label} 删不掉（重试 1 次仍失败）—— ${e.message}`);
        fail++;
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function cleanup() {
  const mids = matterIds.map(BigInt);
  const rids = riskIds.map(BigInt);
  const pids = partyIds.map(BigInt);
  /**
   * 通知投递行（MATT-41 的表，迁移 0010）指着**收件人**，而且是 RESTRICT。
   *
   * 本脚本会造出真实的通知事件（转案件 → 规则 7；关注人 → 规则 2/8），
   * 于是两个临时账号名下会各有一行投递 —— 不删它，`dropSmokeAccount` 就撞外键、
   * 留下孤儿账号（本轮实测撞到过）。删的是**本夹具自己引发的那几行**，
   * 不是替别人擦地：先删投递（它指事件），再删与本夹具宿主相关的事件。
   *
   * ⚠ 这是 `_testacct.mjs` 的检查清单**还没覆盖**的新表（它列的是 9 条旧外键）。
   *    根修在那边（加一条 `mn_notification_delivery.user_id`），本脚本先自己清干净 ——
   *    已写进交付报告的范围外发现。
   */
  const uids = [smoke.id, smoke2.id];
  await sql`delete from mn_notification_delivery where user_id = any(${sql.array(uids)}::bigint[])`;
  if (mids.length) {
    await sql`delete from mn_notification_event where host_id = any(${sql.array(mids)}::bigint[])`;
  }
  if (rids.length) {
    await sql`delete from mn_notification_event where host_id = any(${sql.array(rids)}::bigint[])`;
  }
  if (extraItemIds.length) {
    await sql`delete from mn_expense_item_config where id = any(${sql.array(extraItemIds.map(BigInt))}::bigint[])`;
  }
  if (mids.length) {
    // 费用指着案件（RESTRICT）⇒ 必须先删费用
    await sql`delete from mn_matter_expense where matter_id = any(${sql.array(mids)}::bigint[])`;
    await sql`delete from mn_activity_log where matter_id = any(${sql.array(mids)}::bigint[])`;
    await sql`delete from mn_matter_progress where matter_id = any(${sql.array(mids)}::bigint[])`;
    await sql`delete from mn_matter_node where matter_id = any(${sql.array(mids)}::bigint[])`;
    await sql`delete from mn_matter_staff where matter_id = any(${sql.array(mids)}::bigint[])`;
    await sql`delete from mn_matter_party where matter_id = any(${sql.array(mids)}::bigint[])`;
    await sql`delete from mn_risk_matter_case where matter_id = any(${sql.array(mids)}::bigint[])`;
    await sql`delete from mn_matter where id = any(${sql.array(mids)}::bigint[])`;
  }
  if (rids.length) {
    await sql`delete from mn_risk_matter_expense where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
    await sql`delete from mn_activity_log where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
    await sql`delete from mn_risk_matter_node where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
    await sql`delete from mn_risk_matter_party where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
    await sql`delete from mn_risk_matter_staff where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
    await sql`delete from mn_risk_matter_case where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
    await sql`delete from mn_risk_matter where id = any(${sql.array(rids)}::bigint[])`;
    await sql`delete from mn_event_outbox where payload->>'risk_matter_id' = any(${sql.array(rids.map(String))}::text[])`;
  }
  if (pids.length) {
    await sql`delete from mn_activity_log where target_id = any(${sql.array(pids)}::bigint[])`;
    await sql`delete from mn_party where id = any(${sql.array(pids)}::bigint[])`;
  }
}

try {
  const l1 = await login(smoke.username, smoke.password);
  ok("L1 登录（full_admin + is_admin + can_read_plain）", l1.status === 200, `status=${l1.status}`);
  const cookie = l1.cookie;
  const l2 = await login(smoke2.username, smoke2.password);
  ok("L2 登录（joined_operator，无 can_read_plain）", l2.status === 200, `status=${l2.status}`);

  /* ── ① 列定义：金额必须是 numeric(18,2)（禁 float 的地基） ── */
  const cols = await sql`
    select table_name, column_name, data_type, numeric_precision, numeric_scale
    from information_schema.columns
    where table_schema = 'public'
      and table_name in ('mn_matter_expense', 'mn_risk_matter_expense')
      and column_name = 'amount'
    order by table_name`;
  ok(
    "**两张费用表的 amount 都是 numeric(18,2)**（禁 float 的地基）",
    cols.length === 2 &&
      cols.every(
        (c) => c.data_type === "numeric" && c.numeric_precision === 18 && c.numeric_scale === 2,
      ),
    cols.map((c) => `${c.table_name}:${c.data_type}(${c.numeric_precision},${c.numeric_scale})`).join(" "),
  );

  const isoCols = await sql`
    select table_name, array_agg(column_name order by column_name) as cols
    from information_schema.columns
    where table_schema = 'public' and table_name in ('mn_matter_expense', 'mn_risk_matter_expense')
    group by table_name`;
  const norm = (t) => t.replace(/^(risk_matter|matter)_id$/, "host_id");
  // 归一化之后还要**再排一次**：`array_agg(... order by column_name)` 是按**原始**列名排的，
  // 而两张表的宿主列名不同（matter_id / risk_matter_id）⇒ 归一化后顺序仍会不一样。
  // 不排就是"同一个集合、两种顺序"，断言会红在一个与同构无关的地方。
  const a = (isoCols.find((r) => r.table_name === "mn_matter_expense")?.cols ?? [])
    .map(norm)
    .sort();
  const b = (isoCols.find((r) => r.table_name === "mn_risk_matter_expense")?.cols ?? [])
    .map(norm)
    .sort();
  ok(
    "**两张费用表同构**（库里实测：归一化宿主列后列集合相等）",
    a.length > 3 && JSON.stringify(a) === JSON.stringify(b),
    `${a.length} 列 vs ${b.length} 列`,
  );

  /* ── ② 费用项目走配置（读配置 + 只列启用的） ── */
  const metaRes = await call("GET", "/api/meta?host=matter", cookie);
  const items = metaRes.body?.expenseItems ?? [];
  const enabled = items.filter((i) => i.isEnabled);
  ok(
    "费用项目来自配置表（`/api/meta` 的 expenseItems）",
    metaRes.status === 200 && items.length >= 2 && enabled.length >= 2,
    `共 ${items.length} 项，启用 ${enabled.length} 项`,
  );
  ok(
    "E20 三个状态的中文名都在，且**没有 approved**（第一期无审批流）",
    Object.keys(metaRes.body?.enums?.expenseStatuses ?? {}).length === 3 &&
      !("approved" in (metaRes.body?.enums?.expenseStatuses ?? {})),
    Object.keys(metaRes.body?.enums?.expenseStatuses ?? {}).join(","),
  );
  const itemA = enabled[0];
  const itemB = enabled[1];

  /* ── 建夹具：案件 + 当事人（导出两档要有一列加密字段才验得出来） ── */
  const m1 = await call("POST", "/api/matters", cookie, matterBody("主", [partyRow()]));
  ok("建案件（带当事人）→ 201", m1.status === 201, `status=${m1.status}`);
  matterIds.push(m1.body?.id);
  const matterId = m1.body.id;
  const [rowParty] = await sql`select id from mn_party where name = ${PARTY.name}`;
  if (rowParty) partyIds.push(String(rowParty.id));

  /* ── ③ 空列表：合计给 "0.00" 而不是 null（"没有费用"与"合计 0"是同一句话） ── */
  const empty = await call("GET", `/api/matters/${matterId}/expenses`, cookie);
  ok(
    "空费用列表 → 200，合计是 `0.00`（不是 null / 空串）",
    empty.status === 200 && empty.body?.totals?.sum === "0.00" && empty.body?.totals?.count === 0,
    `status=${empty.status} sum=${JSON.stringify(empty.body?.totals?.sum)}`,
  );

  /* ── ④ CRUD：两笔小额（小数刻度就是在这里被钉住的） ── */
  const e1 = await call("POST", `/api/matters/${matterId}/expenses`, cookie, {
    itemId: itemA.id,
    amount: AMOUNTS.small,
    occurredDate: "2026-03-01",
    status: "pending_pay",
    remark: "受理费，第一笔",
  });
  ok("登记费用（0.10）→ 201", e1.status === 201, `status=${e1.status}`);
  const e2 = await call("POST", `/api/matters/${matterId}/expenses`, cookie, {
    itemId: itemB.id,
    amount: AMOUNTS.small2,
    occurredDate: "2026-03-02",
  });
  ok("登记费用（0.20，默认状态）→ 201", e2.status === 201, `status=${e2.status}`);
  const [rowE1] = await sql`select amount, status, item_id from mn_matter_expense where id = ${e1.body.id}`;
  ok(
    "落库金额是 `numeric` 原样的两位小数字符串（`0.10` 不是 `0.1`）",
    rowE1?.amount === "0.10",
    `amount=${JSON.stringify(rowE1?.amount)} typeof=${typeof rowE1?.amount}`,
  );
  ok(
    "省略 status 时落到列默认 `pending_pay`",
    rowE1?.status === "pending_pay",
    `status=${rowE1?.status}`,
  );

  /* ── ⑤ 合计：**这一条是"禁 float"的照妖镜** ── */
  const sum1 = await call("GET", `/api/matters/${matterId}/expenses`, cookie);
  ok(
    "**合计 0.10 + 0.20 = `0.30`**（float 或 Number() 往返会给出 `0.3`，且不报错）",
    sum1.body?.totals?.sum === "0.30",
    `sum=${JSON.stringify(sum1.body?.totals?.sum)}`,
  );
  ok(
    "按项目分组（F2-13）：两组，各 1 笔，金额逐字相等",
    sum1.body?.byItem?.length === 2 &&
      sum1.body.byItem.every((g) => /^\d+\.\d{2}$/.test(g.sum) && g.count === 1),
    JSON.stringify(sum1.body?.byItem?.map((g) => `${g.itemName}=${g.sum}`)),
  );

  /* ── ⑥ 大额：18 位精度不许被 float 吃掉分位 ── */
  const e3 = await call("POST", `/api/matters/${matterId}/expenses`, cookie, {
    itemId: itemA.id,
    amount: AMOUNTS.big,
    occurredDate: "2026-03-03",
    status: "paid",
  });
  ok("登记大额费用（12345678901234.56）→ 201", e3.status === 201, `status=${e3.status}`);
  const sum2 = await call("GET", `/api/matters/${matterId}/expenses`, cookie);
  ok(
    "大额合计逐字相等（`12345678901234.86`）",
    sum2.body?.totals?.sum === "12345678901234.86",
    `sum=${JSON.stringify(sum2.body?.totals?.sum)}`,
  );
  const groupA = sum2.body?.byItem?.find((g) => g.itemId === itemA.id);
  ok(
    "分组合计：同一项目两笔相加 = `12345678901234.66`",
    groupA?.sum === "12345678901234.66",
    `sum=${JSON.stringify(groupA?.sum)}`,
  );
  ok(
    "列表里每笔金额都是两位小数字符串（读数也不许走 float）",
    (sum2.body?.items ?? []).every((r) => /^\d+\.\d{2}$/.test(r.amount)),
    (sum2.body?.items ?? []).map((r) => r.amount).join(","),
  );

  /* ── ⑦ 入口校验：三位小数 / 负数 / 未知项目 ── */
  const tooPrecise = await call("POST", `/api/matters/${matterId}/expenses`, cookie, {
    itemId: itemA.id,
    amount: TOO_PRECISE,
    occurredDate: "2026-03-04",
  });
  ok(
    `金额 ${TOO_PRECISE}（三位小数）→ 400（列是 numeric(18,2)，不许静默四舍五入）`,
    tooPrecise.status === 400 && tooPrecise.body?.error === "validation_failed",
    `status=${tooPrecise.status} err=${tooPrecise.body?.error}`,
  );
  const negative = await call("POST", `/api/matters/${matterId}/expenses`, cookie, {
    itemId: itemA.id,
    amount: "-1",
    occurredDate: "2026-03-04",
  });
  ok(
    "负数金额 → 400（只记支出，没有负数冲销）",
    negative.status === 400,
    `status=${negative.status}`,
  );
  const unknownItem = await call("POST", `/api/matters/${matterId}/expenses`, cookie, {
    itemId: "999999999",
    amount: "1.00",
    occurredDate: "2026-03-04",
  });
  ok(
    "**未知费用项目 → 422 `item_unavailable`**（费用项目走配置，不是自由文本）",
    unknownItem.status === 422 && unknownItem.body?.error === "item_unavailable",
    `status=${unknownItem.status} err=${unknownItem.body?.error}`,
  );

  // 停用项目：直连库造一行 `is_enabled=false`（配置页归 M5，本票没有写接口）
  const disabledId = BigInt(Date.now()) * 1000n + 7n;
  await sql`insert into mn_expense_item_config (id, code, name, sort_order, is_system, is_enabled)
            values (${disabledId}, ${`smoke_disabled_${stamp}`}, ${`停用项目${stamp}`}, 99, false, false)`;
  extraItemIds.push(String(disabledId));
  const disabledItem = await call("POST", `/api/matters/${matterId}/expenses`, cookie, {
    itemId: String(disabledId),
    amount: "1.00",
    occurredDate: "2026-03-04",
  });
  ok(
    "**已停用的费用项目 → 422**（停用项不能被新费用选中，但历史行仍显示它）",
    disabledItem.status === 422 && disabledItem.body?.error === "item_unavailable",
    `status=${disabledItem.status} err=${disabledItem.body?.error}`,
  );
  const listHasDisabled = await call("GET", `/api/meta?host=matter`, cookie);
  ok(
    "停用项仍在配置清单里（带 isEnabled=false）——历史费用要能显示项目名",
    (listHasDisabled.body?.expenseItems ?? []).some(
      (i) => i.id === String(disabledId) && i.isEnabled === false,
    ),
    `items=${(listHasDisabled.body?.expenseItems ?? []).length}`,
  );

  /* ── ⑧ 单条读：两个 id 必须同时对上 ── */
  const one = await call("GET", `/api/matters/${matterId}/expenses/${e1.body.id}`, cookie);
  ok(
    "单条费用详情 → 200，且带项目名（费用详情页的数据源）",
    one.status === 200 && one.body?.itemName === itemA.name && one.body?.amount === "0.10",
    `status=${one.status} item=${one.body?.itemName}`,
  );
  const m2 = await call("POST", "/api/matters", cookie, matterBody("旁", []));
  matterIds.push(m2.body?.id);
  const crossRead = await call("GET", `/api/matters/${m2.body.id}/expenses/${e1.body.id}`, cookie);
  ok(
    "拿别的案件 id 读这条费用 → 404（父资源 id 不是装饰）",
    crossRead.status === 404,
    `status=${crossRead.status}`,
  );

  /* ── ⑨ 改 + 删（软删），合计跟着动 ── */
  const patched = await call("PATCH", `/api/matters/${matterId}/expenses/${e1.body.id}`, cookie, {
    amount: AMOUNTS.patched,
    status: "paid",
  });
  ok("改费用（金额 + 状态）→ 200", patched.status === 200, `status=${patched.status}`);
  const sum3 = await call("GET", `/api/matters/${matterId}/expenses`, cookie);
  ok(
    "改后合计 = 12345678901235.11（0.35 + 0.20 + 大额）",
    sum3.body?.totals?.sum === "12345678901235.11",
    `sum=${JSON.stringify(sum3.body?.totals?.sum)}`,
  );
  const removed = await call("DELETE", `/api/matters/${matterId}/expenses/${e2.body.id}`, cookie);
  ok("删费用 → 200", removed.status === 200, `status=${removed.status}`);
  const [rowE2] = await sql`select is_deleted, deleted_at from mn_matter_expense where id = ${e2.body.id}`;
  ok(
    "删除是**软删**（行还在、`is_deleted=true`）——费用是可被引用的事实",
    rowE2?.is_deleted === true && rowE2?.deleted_at !== null,
    `is_deleted=${rowE2?.is_deleted}`,
  );
  const sum4 = await call("GET", `/api/matters/${matterId}/expenses`, cookie);
  ok(
    "软删的那笔不再计入合计（12345678901234.91）与条数（2 笔）",
    sum4.body?.totals?.sum === "12345678901234.91" && sum4.body?.totals?.count === 2,
    `sum=${JSON.stringify(sum4.body?.totals?.sum)} count=${sum4.body?.totals?.count}`,
  );

  /* ── ⑩ 审计：EXPENSE_CREATED / UPDATED / DELETED（§3.1 的 field_diffs） ── */
  const audits = await sql`
    select action, field_diffs, target_type, target_id from mn_activity_log
    where matter_id = ${matterId} and action like 'EXPENSE%' order by created_at`;
  const actions = audits.map((x) => x.action);
  ok(
    "费用 CRUD 三条审计都在（EXPENSE_CREATED / UPDATED / DELETED）",
    actions.includes("EXPENSE_CREATED") &&
      actions.includes("EXPENSE_UPDATED") &&
      actions.includes("EXPENSE_DELETED"),
    actions.join(","),
  );
  ok(
    "案件侧费用审计挂在 `matter_expense` 落点上（E03 给费用留的位）",
    audits.every((x) => x.target_type === "matter_expense"),
    audits.map((x) => x.target_type).join(","),
  );
  const upd = audits.find((x) => x.action === "EXPENSE_UPDATED");
  ok(
    "改动的 field_diffs 记 from/to，金额是字符串（`0.10` → `0.35`）",
    upd?.field_diffs?.amount?.from === "0.10" && upd?.field_diffs?.amount?.to === "0.35",
    JSON.stringify(upd?.field_diffs?.amount),
  );

  /* ── ⑪ 导出两档（US-42） ── */
  const masked = await call("GET", `/api/matters/${matterId}/export`, cookie);
  const tail = PARTY.idNumber.slice(-4);
  ok(
    "**默认档是脱敏档**：证件号只留尾四位，完整证件号不在文本里",
    masked.status === 200 &&
      masked.body?.plain === false &&
      masked.body.csv.includes(`****${tail}`) &&
      !masked.body.csv.includes(PARTY.idNumber),
    `status=${masked.status} plain=${masked.body?.plain} rows=${masked.body?.rows}`,
  );
  ok(
    "整卷包含费用区段与金额（费用与导出这一票的两半在同一份卷宗里）",
    masked.body?.csv?.includes("[费用]") &&
      masked.body.csv.includes(AMOUNTS.big) &&
      masked.body.csv.includes(itemA.name),
    `含 [费用]=${masked.body?.csv?.includes("[费用]")}`,
  );
  ok(
    "整卷的 `count` = 1（件数），`rows` > 0（行数）—— 两个量纲分开记",
    masked.body?.count === 1 && masked.body?.rows > 0,
    `count=${masked.body?.count} rows=${masked.body?.rows}`,
  );

  const plainDenied = await call("GET", `/api/matters/${matterId}/export?plain=1`, l2.cookie);
  ok(
    "**无 can_read_plain 者调明文导出 → 403 privilege_required**（失败用例留断言）",
    plainDenied.status === 403 && plainDenied.body?.error === "privilege_required",
    `status=${plainDenied.status} err=${plainDenied.body?.error}`,
  );
  const plain = await call("GET", `/api/matters/${matterId}/export?plain=1`, cookie);
  ok(
    "明文档（有权限）→ 200，且含完整证件号",
    plain.status === 200 && plain.body?.plain === true && plain.body.csv.includes(PARTY.idNumber),
    `status=${plain.status} rows=${plain.body?.rows}`,
  );

  const exportLogs = await sql`
    select payload from mn_activity_log
    where matter_id = ${matterId} and action = 'EXPORT' order by created_at`;
  const maskedLog = exportLogs.find((x) => x.payload?.plain === false);
  const plainLog = exportLogs.find((x) => x.payload?.plain === true);
  ok(
    "**两档都写 EXPORT**，载荷 `{target_type, scope, rows, count, plain}`",
    Boolean(maskedLog) &&
      Boolean(plainLog) &&
      plainLog.payload.target_type === "matter" &&
      plainLog.payload.scope === "matter_file" &&
      plainLog.payload.count === 1 &&
      typeof plainLog.payload.rows === "number",
    `masked=${Boolean(maskedLog)} plain=${Boolean(plainLog)} payload=${JSON.stringify(plainLog?.payload)}`,
  );
  ok(
    "**载荷不含行内容**：键集合恰好是那五个，且 JSON 里不出现证件号",
    JSON.stringify(Object.keys(plainLog?.payload ?? {}).sort()) ===
      JSON.stringify(["count", "plain", "rows", "scope", "target_type"]) &&
      !JSON.stringify(plainLog?.payload ?? {}).includes(PARTY.idNumber) &&
      !JSON.stringify(maskedLog?.payload ?? {}).includes(PARTY.idNumber),
    Object.keys(plainLog?.payload ?? {}).join(","),
  );
  ok(
    "载荷的行数与响应一致（审计能回答「导出了多少行」）",
    plainLog?.payload?.rows === plain.body?.rows && maskedLog?.payload?.rows === masked.body?.rows,
    `log=${plainLog?.payload?.rows} resp=${plain.body?.rows}`,
  );

  /* ── ⑫ 数据范围：看不见这条案卷的人三处都拿 404 ── */
  const invisibleList = await call("GET", `/api/matters/${matterId}/expenses`, l2.cookie);
  const invisibleOne = await call(
    "GET",
    `/api/matters/${matterId}/expenses/${e1.body.id}`,
    l2.cookie,
  );
  const invisibleExport = await call("GET", `/api/matters/${matterId}/export`, l2.cookie);
  ok(
    "**看不见这条案卷 → 列表/单条/导出一律 404**（可见性只有 `scopedWhere` 一个出口）",
    invisibleList.status === 404 && invisibleOne.status === 404 && invisibleExport.status === 404,
    `list=${invisibleList.status} one=${invisibleOne.status} export=${invisibleExport.status}`,
  );
  const invisibleWrite = await call("POST", `/api/matters/${matterId}/expenses`, l2.cookie, {
    itemId: itemA.id,
    amount: "9.99",
    occurredDate: "2026-03-05",
  });
  ok("看不见这条案卷 → 写也 404（不是 403：不确认存在性）", invisibleWrite.status === 404, `status=${invisibleWrite.status}`);

  /* ── ⑬ 把 L2 加为关注人：看得见的人**能导脱敏档**、仍然**导不了明文档** ── */
  const added = await call("POST", `/api/matters/${matterId}/staff`, cookie, {
    userIds: [String(smoke2.id)],
    staffRole: "follower",
  });
  ok(
    "把 L2 加为关注人 → 200（added=1）",
    added.status === 200 && added.body?.added === 1,
    `status=${added.status} added=${added.body?.added}`,
  );
  const l2List = await call("GET", `/api/matters/${matterId}/expenses`, l2.cookie);
  ok(
    "参与人看得见费用列表（明细读写不加第二道判定：能看就能写明细）",
    l2List.status === 200 && l2List.body?.totals?.sum === "12345678901234.91",
    `status=${l2List.status} sum=${JSON.stringify(l2List.body?.totals?.sum)}`,
  );
  const l2Masked = await call("GET", `/api/matters/${matterId}/export`, l2.cookie);
  ok(
    "参与人**能导脱敏档**（人人可导：看得见就能导这一份）",
    l2Masked.status === 200 && l2Masked.body?.plain === false,
    `status=${l2Masked.status}`,
  );
  const l2Plain = await call("GET", `/api/matters/${matterId}/export?plain=1`, l2.cookie);
  ok(
    "**同一个人导明文档仍然 403**（特权的门在服务端，不在前端按钮上）",
    l2Plain.status === 403 && l2Plain.body?.error === "privilege_required",
    `status=${l2Plain.status} err=${l2Plain.body?.error}`,
  );
  const l2Write = await call("POST", `/api/matters/${matterId}/expenses`, l2.cookie, {
    itemId: itemB.id,
    amount: "5.00",
    occurredDate: "2026-03-06",
  });
  ok(
    "参与人能登记费用（护栏 2：明细读写只判可见性）→ 201",
    l2Write.status === 201,
    `status=${l2Write.status}`,
  );

  /* ── ⑭ 归档态只读（§5.2）：读 200、写 403 ──
   *
   * ⚠ 归档**必须走真实路径**（状态流转接口），不能直接 `update mn_matter set is_archived`。
   *
   * 原先这里就是直写那一列、**不动 `status`**，于是造出**应用永远不会产生**的状态
   * （归档位为真、状态仍是"在办"）。后果不是"数据脏"，是**给并行跑的冒烟制造假红**：
   * `smoke-reports` 的"归档视图里只剩归档行"就被它弄红过一次，被迫把全量不变式
   * **收窄成只看自己的私有行** —— 一条断言被永久削弱了。
   *
   * 根因是"归档位"与"归档态"是两件事：`is_archived` 是应用维护的冗余位，
   * 而真正的语义在 `status`（`semantics='archived'` 那一档）。直写前者就绕过了后者。
   *
   * 现在走接口：`POST /api/matters/{id}/status`，`to` 取配置里 `semantics='archived'` 的那一档，
   * 强归要带 reason（§5.2）。还原同样走接口回初始态。
   */
  const [archivedStatus] = await sql`
    select code from mn_status_config
     where host_type = 'matter' and semantics = 'archived' and is_enabled
     order by sort_order limit 1`;
  const [initialStatus] = await sql`
    select code from mn_status_config
     where host_type = 'matter' and is_initial_status and is_enabled
     order by sort_order limit 1`;
  const archTo = await call("POST", `/api/matters/${matterId}/status`, cookie, {
    to: archivedStatus.code,
    reason: "冒烟：验归档态只读",
  });
  ok(
    "**走真实路径归档成功**（不是直写 `is_archived` 造一个应用产不出的状态）",
    archTo.status === 200,
    `status=${archTo.status} to=${archivedStatus.code}`,
  );
  const [afterArch] = await sql`select is_archived, status from mn_matter where id = ${matterId}`;
  ok(
    "**归档位与归档态一致**（`is_archived` 真、`status` 也是归档态）",
    afterArch.is_archived === true && afterArch.status === archivedStatus.code,
    `is_archived=${afterArch.is_archived} status=${afterArch.status}`,
  );
  const archRead = await call("GET", `/api/matters/${matterId}/expenses`, cookie);
  const archWrite = await call("POST", `/api/matters/${matterId}/expenses`, cookie, {
    itemId: itemA.id,
    amount: "1.00",
    occurredDate: "2026-03-07",
  });
  const archPatch = await call("PATCH", `/api/matters/${matterId}/expenses/${e1.body.id}`, cookie, {
    amount: "2.00",
  });
  const archDel = await call("DELETE", `/api/matters/${matterId}/expenses/${e1.body.id}`, cookie);
  ok(
    "归档后：读 200、增/改/删一律 403 `archived`（归档是只读终态）",
    archRead.status === 200 &&
      archWrite.status === 403 &&
      archWrite.body?.error === "archived" &&
      archPatch.status === 403 &&
      archDel.status === 403,
    `read=${archRead.status} post=${archWrite.status} patch=${archPatch.status} del=${archDel.status}`,
  );
  // 还原也走接口。⚠ **没有 `/unarchive` 这条路由**：撤销归档与归档共用
  // `POST /api/matters/{id}/status` —— 特权在路由层判 `can_unarchive`，
  // 写入在服务层（`isArchived: archiving`，`matters.ts`）。
  // 原来这里先打了一发 `POST …/unarchive`：那个路径不存在、恒 404，而返回值被丢弃，
  // 于是"每次跑都白打一发必然失败的请求"这件事没有任何人会知道。
  const restore = await call("POST", `/api/matters/${matterId}/status`, cookie, {
    to: initialStatus.code,
    reason: "冒烟：撤归档并还原到初始态",
  });
  ok(
    "撤归档并回到初始态 → 200（这条路由就是撤销归档的唯一出口）",
    restore.status === 200,
    `status=${restore.status} to=${initialStatus.code} ${JSON.stringify(restore.body)?.slice(0, 60)}`,
  );
  const [afterRestore] = await sql`select is_archived, status from mn_matter where id = ${matterId}`;
  ok(
    "还原后归档位与状态**都**回到初始态（原来只查了 `is_archived`，`status` 没查）",
    afterRestore.is_archived === false && afterRestore.status === initialStatus.code,
    `is_archived=${afterRestore.is_archived} status=${afterRestore.status}（期望 ${initialStatus.code}）`,
  );

  /* ── ⑮ 事项侧同构：建、列、读、导全走一遍 ── */
  const r1 = await call("POST", "/api/risk-matters", cookie, riskBody("主", [partyRow()]));
  ok("建事项（带当事人）→ 201", r1.status === 201, `status=${r1.status}`);
  riskIds.push(r1.body?.id);
  const riskId = r1.body.id;
  const rExp = await call("POST", `/api/risk-matters/${riskId}/expenses`, cookie, {
    itemId: itemA.id,
    amount: "0.10",
    occurredDate: "2026-04-01",
  });
  ok("事项侧登记费用 → 201", rExp.status === 201, `status=${rExp.status}`);
  const rExp2 = await call("POST", `/api/risk-matters/${riskId}/expenses`, cookie, {
    itemId: itemB.id,
    amount: "0.20",
    occurredDate: "2026-04-02",
  });
  ok("事项侧第二笔 → 201", rExp2.status === 201, `status=${rExp2.status}`);
  const rList = await call("GET", `/api/risk-matters/${riskId}/expenses`, cookie);
  ok(
    "事项侧合计与案件侧同一口径（0.30，两位小数）",
    rList.status === 200 && rList.body?.totals?.sum === "0.30",
    `status=${rList.status} sum=${JSON.stringify(rList.body?.totals?.sum)}`,
  );
  const rOne = await call(
    "GET",
    `/api/risk-matters/${riskId}/expenses/${rExp.body.id}`,
    cookie,
  );
  ok(
    "事项侧单条详情 → 200（费用详情页在两侧都可按宿主查阅）",
    rOne.status === 200 && rOne.body?.itemName === itemA.name,
    `status=${rOne.status}`,
  );
  const rExport = await call("GET", `/api/risk-matters/${riskId}/export`, cookie);
  ok(
    "事项整卷导出（脱敏档）→ 200，含费用区段、证件号只留尾四位",
    rExport.status === 200 &&
      rExport.body?.plain === false &&
      rExport.body.csv.includes("[费用]") &&
      rExport.body.csv.includes(`****${tail}`) &&
      !rExport.body.csv.includes(PARTY.idNumber),
    `status=${rExport.status} rows=${rExport.body?.rows}`,
  );
  const rPlainDenied = await call(
    "GET",
    `/api/risk-matters/${riskId}/export?plain=1`,
    l2.cookie,
  );
  ok(
    "事项侧明文导出同样要特权（403）",
    rPlainDenied.status === 403 && rPlainDenied.body?.error === "privilege_required",
    `status=${rPlainDenied.status}`,
  );
  const rPlain = await call("GET", `/api/risk-matters/${riskId}/export?plain=1`, cookie);
  ok(
    "事项侧明文档 → 200 且含完整证件号",
    rPlain.status === 200 && rPlain.body.csv.includes(PARTY.idNumber),
    `status=${rPlain.status}`,
  );
  const rAudit = await sql`
    select target_type, matter_id, risk_matter_id, payload from mn_activity_log
    where risk_matter_id = ${riskId} and action = 'EXPORT' and payload->>'plain' = 'true'`;
  ok(
    "事项侧 EXPORT 挂在事项维度（`risk_matter_id` 有值、`matter_id` 为空）",
    rAudit.length === 1 && rAudit[0].matter_id === null && rAudit[0].risk_matter_id !== null,
    `n=${rAudit.length}`,
  );
  const rExpAudit = await sql`
    select target_type from mn_activity_log
    where risk_matter_id = ${riskId} and action = 'EXPENSE_CREATED' limit 1`;
  ok(
    // E03 没有 `risk_matter_expense` 这个值 ⇒ 事项侧费用审计只能挂宿主（记进交付报告的范围外发现）
    "事项侧费用审计挂宿主（E03 缺 `risk_matter_expense` 值，不往 `matter_expense` 里塞假话）",
    rExpAudit[0]?.target_type === "risk_matter",
    `target_type=${rExpAudit[0]?.target_type}`,
  );

  /* ── ⑯ **撤销转案件的前置**（映射矩阵 §5.1：无进展/费用/非预设节点） ── */
  const r2 = await call("POST", "/api/risk-matters", cookie, riskBody("撤销", [partyRow()]));
  riskIds.push(r2.body?.id);
  const converted = await call("POST", `/api/risk-matters/${r2.body.id}/convert`, cookie, {
    cases: [
      {
        name: `费用冒烟撤销案-${stamp}`,
        cause: "买卖合同纠纷",
        caseType: "civil_commercial",
        procedure: "first_instance",
        litigationRole: "plaintiff",
        level: "mid",
      },
    ],
  });
  ok("转案件 → 201", converted.status === 201, `status=${converted.status}`);
  const caseId = converted.body?.cases?.[0]?.id;
  matterIds.push(caseId);
  ok("转出来的案件 id 拿到了", Boolean(caseId), `caseId=${caseId}`);

  const cExp = await call("POST", `/api/matters/${caseId}/expenses`, cookie, {
    itemId: itemA.id,
    amount: "88.00",
    occurredDate: "2026-04-10",
  });
  ok("给转出来的案件登记一笔费用 → 201", cExp.status === 201, `status=${cExp.status}`);

  // ⚠ 2026-10-14 冻结裁定之后，这三条断言表达的是**新的规则**，不是"费用前置还能挡住撤销"。
  // 事项转过案件即冻结，而撤销要求存在关联行、关联行必然意味着 conversion_status=1，
  // 于是 UNCONVERT 恒返回 422 `frozen`，费用前置（连同进展、节点两条）在它后面，永远轮不到。
  // 费用那三条前置谓词仍由 `revred-expenses.mjs` 的源码锚点守着
  // （`node agent-work/verify-anchors.mjs` → `unconvert-expense-blocker`）。
  const blocked = await call("POST", `/api/risk-matters/${r2.body.id}/unconvert`, cookie, {
    caseId,
    reason: "费用冒烟：验证撤销前置",
  });
  ok(
    "**有费用 → 撤销被拒，但答复是 422 frozen 而不是 blocked**（冻结优先于费用前置）",
    blocked.status === 422 &&
      blocked.body?.error === "frozen" &&
      !String(blocked.body?.message ?? "").includes("费用"),
    `status=${blocked.status} err=${blocked.body?.error} msg=${blocked.body?.message}`,
  );
  const [stillLinked] = await sql`
    select count(*)::int as n from mn_risk_matter_case where risk_matter_id = ${r2.body.id}`;
  ok("被拒之后关联仍在（不是「拒了但已经删了」）", stillLinked?.n === 1, `n=${stillLinked?.n}`);

  const delExp = await call("DELETE", `/api/matters/${caseId}/expenses/${cExp.body.id}`, cookie);
  ok("软删掉那笔费用 → 200", delExp.status === 200, `status=${delExp.status}`);
  const unblocked = await call("POST", `/api/risk-matters/${r2.body.id}/unconvert`, cookie, {
    caseId,
    reason: "费用冒烟：软删后撤销仍应被冻结门挡住",
  });
  ok(
    "**软删费用之后仍然是 422 frozen**（答复与费用软删与否无关）",
    unblocked.status === 422 && unblocked.body?.error === "frozen",
    `status=${unblocked.status} body=${JSON.stringify(unblocked.body)}`,
  );
  const [countAfter] = await sql`
    select conversion_status, converted_case_count from mn_risk_matter where id = ${r2.body.id}`;
  ok(
    "**计数未被改动**（converted_case_count 仍按 COUNT(*) 重算；冻结后没有撤销可归零）",
    countAfter?.converted_case_count === 1 && countAfter?.conversion_status === 1,
    JSON.stringify(countAfter),
  );
} catch (e) {
  fail++;
  console.log(`[FAIL] 脚本中断 —— ${e?.stack ?? e}`);
} finally {
  try {
    await cleanup();
    console.log("[clean] 清场完成");
  } catch (e) {
    console.log(`[clean] 清场失败（需手工查）—— ${e?.message ?? e}`);
  }
  await dropWithRetry(smoke, "临时账号 L1");
  await dropWithRetry(smoke2, "临时账号 L2");
  await sql.end();
}

console.log(`\n${fail ? "FAIL" : "PASS"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
