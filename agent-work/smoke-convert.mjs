import {
  createSmokeAccount,
  dropSmokeAccount,
  finishSmoke,
  noteCleanupFailure,
  ROLE_CODES,
} from "./_testacct.mjs";
/**
 * 转案件 + 撤销关联 的真 HTTP 冒烟（切片一 T2）。
 *
 * 与 `smoke-demo.mjs` 分开而不是并进去：这条链的断言要**造数据再拆干净**，
 * 混进那份通用冒烟会让它的清场段承担不属于自己的责任。
 *
 * 唯一直接写库的地方：给案件塞一条「进展」，以及补当事人。
 * 两者都是因为**当前没有对应的 HTTP 入口**（`riskMatterParty` 全仓无写入路径；
 * 进展录入属 T9 的范围）。这不是绕过校验——被测的转案件与撤销本身全走 HTTP，
 * 写库只负责布置前置条件。
 *
 * 列名与枚举值一律**从 API 造出来的行上取**，不硬编码：手写 insert 时猜错列名
 * （`party_type` vs `type`）已经浪费过一轮。
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
const card = (i, over = {}) => ({
  name: `转案件冒烟 ${stamp}-${i}`,
  cause: "建设工程施工合同纠纷",
  caseType: "civil_commercial",
  procedure: "first_instance",
  litigationRole: "defendant",
  level: "high",
  ...over,
});

const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

const smoke = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
const l1 = await login(smoke.username, smoke.password);
ok("L1 登录（临时账号）", l1.status === 200, `status=${l1.status}`);
const cookie = l1.cookie;

// （旧的演示账号登录块已移除，改用上面的临时账号）

// 中途断言失败时也要清场，否则半截数据会留在库里被下一轮当成真实数据。
// 用 try/finally 而不是只在末尾清：前两轮就是在中途抛异常，留下了一地残留。
const createdCaseIds = new Set();
const createdRiskIds = new Set();
async function cleanup() {
  const cids = [...createdCaseIds].map(BigInt);
  const rids = [...createdRiskIds].map((s) => BigInt(s));
  // 顺序即外键拓扑：先活动日志（它同时指两个宿主），再一切指向宿主的从属/关联表，
  // 最后才动宿主本身。前两轮就是这里顺序错了才清不掉。
  if (cids.length) {
    await sql`delete from mn_activity_log where matter_id = any(${sql.array(cids)}::bigint[])`;
    await sql`delete from mn_risk_matter_case where matter_id = any(${sql.array(cids)}::bigint[])`;
    await sql`delete from mn_matter_progress where matter_id = any(${sql.array(cids)}::bigint[])`;
    await sql`delete from mn_matter_node where matter_id = any(${sql.array(cids)}::bigint[])`;
    await sql`delete from mn_matter_staff where matter_id = any(${sql.array(cids)}::bigint[])`;
    await sql`delete from mn_matter_party where matter_id = any(${sql.array(cids)}::bigint[])`;
    await sql`delete from mn_matter where id = any(${sql.array(cids)}::bigint[])`;
  }
  if (rids.length) {
    await sql`delete from mn_activity_log where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
    await sql`delete from mn_risk_matter_node where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
    await sql`delete from mn_risk_matter_party where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
    await sql`delete from mn_risk_matter_case where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
    await sql`delete from mn_risk_matter where id = any(${sql.array(rids)}::bigint[])`;
    await sql`delete from mn_event_outbox where payload->>'risk_matter_id' = any(${sql.array(rids.map(String))}::text[])`;
  }
  // 两条建当事人路径用了不同前缀（追加 / 建时带入），清理要一起覆盖。
// 少覆盖一条就是每跑一次漏一份数据——比断言红更难发现。
await sql`delete from mn_party where name like ${`%${stamp}%`}`;
}

try {
// ---- 1. 建事项 ----
const created = await call("POST", "/api/risk-matters", cookie, {
  name: `转案件冒烟事项 ${stamp}`,
  type: "contract",
  level: "high",
  description: "冒烟用临时事项",
});
ok("建事项", created.status === 201, `status=${created.status}`);
const riskId = created.body?.id;
createdRiskIds.add(riskId);

// ---- 2. 无当事人时转案件应被拒，并给出下一步动作 ----
const noParty = await call("POST", `/api/risk-matters/${riskId}/convert`, cookie, {
  cases: [card("x")],
});
ok("无当事人 → 422", noParty.status === 422, `status=${noParty.status}`);
ok("拒绝码是 parties_required", noParty.body?.error === "parties_required", String(noParty.body?.error));

// ---- 3. 补当事人（走 HTTP：T10 之前这里只能直接写库）----
const appended = await call("POST", `/api/risk-matters/${riskId}/parties`, cookie, {
  parties: [
    { partyId: "", name: `冒烟对手方 ${stamp}`, type: "legal_person", partyRole: "defendant" },
  ],
});
ok("追加当事人 → 200", appended.status === 200 && appended.body?.added === 1, `status=${appended.status} added=${appended.body?.added}`);

const listed = await call("GET", `/api/risk-matters/${riskId}/parties`, cookie);
ok("GET 当事人区返回 1 条", listed.status === 200 && Array.isArray(listed.body) && listed.body.length === 1, `status=${listed.status} n=${listed.body?.length}`);
ok("当事人行带本体信息（name/type），不是只有关联行", String(listed.body?.[0]?.name ?? "").includes("冒烟对手方"), String(listed.body?.[0]?.name));
const linkId = listed.body?.[0]?.id;
// 显式守住"真的拿到了 id"：下面几条都靠它当基准，若这里取到 undefined，
// 后面所有比较都会因为两边同为 undefined 而**假绿**（已经踩过一次）
ok("拿到了关联行 id（后续断言的基准）", typeof linkId === "string" && linkId.length > 0, `linkId=${linkId}`);

// 再挂一个，证明 sort_order 接着排而不是插到中间
const appended2 = await call("POST", `/api/risk-matters/${riskId}/parties`, cookie, {
  parties: [{ partyId: "", name: `冒烟第三方 ${stamp}`, type: "legal_person", partyRole: "third_party" }],
});
const listed2 = await call("GET", `/api/risk-matters/${riskId}/parties`, cookie);
ok("追加后顺序稳定（新行排在已有行之后）", listed2.body?.[0]?.id === linkId, `first=${listed2.body?.[0]?.id} 期望仍为 ${linkId}`);

// 摘掉刚加的第二个，回到 1 条
const secondId = listed2.body?.[1]?.id;
const removed = await call("DELETE", `/api/risk-matters/${riskId}/parties/${secondId}`, cookie);
ok("摘除当事人 → 200", removed.status === 200, `status=${removed.status}`);
const listed3 = await call("GET", `/api/risk-matters/${riskId}/parties`, cookie);
ok("摘除后剩 1 条", listed3.body?.length === 1, `n=${listed3.body?.length}`);

// 摘一个别人的 / 不存在的 → 404，不是 500
const badRemove = await call("DELETE", `/api/risk-matters/${riskId}/parties/1234567890`, cookie);
ok("摘不存在的关联行 → 404", badRemove.status === 404, `status=${badRemove.status}`);

// 路径参数非法 → 400（不是 500）
const junkRemove = await call("DELETE", `/api/risk-matters/${riskId}/parties/abc`, cookie);
ok("关联行 id 非数字 → 400", junkRemove.status === 400, `status=${junkRemove.status}`);

// ---- 3b. 建事项时**直接带入**当事人（另一条写入路径）----
// 与"建完再追加"是两条不同的代码路径（createRiskMatter 内联 vs appendRiskParties），
// 只验一条会漏掉另一条。而且这条路径更常用：用户填事项时通常还不知道当事人是谁。
const createdWith = await call("POST", "/api/risk-matters", cookie, {
  name: `建时带入当事人 ${stamp}`,
  type: "contract",
  level: "high",
  description: "冒烟用：建事项时带入当事人",
  parties: [
    { partyId: "", name: `建时对手方 ${stamp}`, type: "legal_person", partyRole: "defendant" },
    { partyId: "", name: `建时第三方 ${stamp}`, type: "legal_person", partyRole: "third_party" },
  ],
});
createdRiskIds.add(createdWith.body?.id);
ok("建事项带入 2 个当事人 → 201", createdWith.status === 201, `status=${createdWith.status}`);
const listedCreated = await call("GET", `/api/risk-matters/${createdWith.body?.id}/parties`, cookie);
ok("建时带入的当事人已挂上（2 条）", listedCreated.body?.length === 2, `n=${listedCreated.body?.length}`);

// ---- 3c. 不写 represented（IQ-15 软作废的列不能被新路径写回去）----
// 这一列随 IQ-15 判定"应用层不再读写"，但**列还留在库里**——新写入路径第一次
// 有了写它的机会。补一个默认值就等于把刚摘除的语义悄悄写回去。
const [rep] = await sql`
  select bool_or(represented) as any_true from mn_risk_matter_party
  where risk_matter_id = ${createdWith.body?.id}`;
ok("**represented 全为 false** —— 新路径没有把它写回去", rep.any_true !== true, `any_true=${rep.any_true}`);

// ---- 4. 一次转 N=2 ----
// 两张卡各带自己的金额（AC：金额留空逐案填、**不继承**事项敞口 999999）；
// 第 2 张还带一个自定义案号，用来验「案号可改」。
const conv = await call("POST", `/api/risk-matters/${riskId}/convert`, cookie, {
  cases: [card(1, { amount: "1000.00" }), card(2, { amount: "2000.00", caseNo: `自定义案号-${stamp}` })],
});
ok("一次提交 N=2 建出 2 个案件", conv.status === 201 && conv.body?.cases?.length === 2, `status=${conv.status} n=${conv.body?.cases?.length}`);
const made = conv.body?.cases ?? [];
ok("两案编号不同（取号不重号）", made.length === 2 && made[0].internalCode !== made[1].internalCode, made.map((c) => c.internalCode).join(" / "));
const ids = made.map((c) => c.id);
const bigIds = ids.map(BigInt);

// AC 5：金额逐案填、不继承敞口
//
// ⚠ **不要按位置断言**（这里踩过一次抖动）：`convertToCase` 用
// `Promise.all(inputs.map(() => nextCode("matter")))` **并发取号**，
// 所以"卡序"与"编号序"不保证一致——按 `order by internal_code` 取回来的第 0 行
// 不一定是第 1 张卡。前几次恰好一致，于是这条断言看起来是绿的；换一次调度就翻。
// 改为**按特征识别**：带自定义案号的那张是第 2 张卡，另一张是第 1 张。
const amounts = await sql`
  select id::text as id, amount::text as amount, case_no, internal_code
  from mn_matter where id = any(${sql.array(bigIds)}::bigint[])`;
const customNo = amounts.find((a) => a.case_no === `自定义案号-${stamp}`);
const defaulted = amounts.find((a) => a.case_no === a.internal_code);
ok(
  "**金额逐案自填**（两案各是各的，不是同一个值）",
  amounts.length === 2 &&
    amounts.some((a) => a.amount === "1000.00") &&
    amounts.some((a) => a.amount === "2000.00"),
  amounts.map((a) => a.amount).join(" / "),
);

// AC 6：案号默认取内部编号、可改
ok(
  "**案号默认回退为内部编号**（未填那张）",
  Boolean(defaulted),
  `默认那张=${defaulted?.case_no ?? "（没找到）"} 全部=${amounts.map((a) => a.case_no).join(" / ")}`,
);
ok(
  "**案号可改**（填了就用填的，且金额是它自己那张的）",
  customNo?.amount === "2000.00",
  `自定义那张：case_no=${customNo?.case_no} amount=${customNo?.amount}`,
);

const [afterConv] = await sql`select conversion_status, converted_case_count from mn_risk_matter where id = ${riskId}`;
ok("conversion_status=1 且计数=2", afterConv.conversion_status === 1 && afterConv.converted_case_count === 2, `status=${afterConv.conversion_status} count=${afterConv.converted_case_count}`);

const [linkRows] = await sql`select count(*)::int as n from mn_risk_matter_case where risk_matter_id = ${riskId}`;
ok("关联行数=2", linkRows.n === 2, `n=${linkRows.n}`);

// IQ-5：事项侧无预设节点。这是 T1 详情页的前置——建事项时不该被塞进任何系统节点。
// 断言同时查两端：配置侧（preset_on_create 必须是 false）与数据侧（新事项节点数必须是 0）。
// 只查一端会漏：配置改了但建号路径还在调、或路径改了但配置还是 true，都会漏。
const [cfgPreset] = await sql`
  select count(*)::int as n from mn_node_type_config
  where host_type = 'risk_matter' and preset_on_create = true`;
ok("配置侧：risk_matter 节点类型无 preset_on_create", cfgPreset.n === 0, `仍为 true 的行=${cfgPreset.n}`);
const [cfgRange] = await sql`
  select count(*)::int as n from mn_node_type_config
  where host_type = 'risk_matter' and time_type <> 'point'`;
ok("配置侧：risk_matter 节点类型全是时间点", cfgRange.n === 0, `非时间点行=${cfgRange.n}`);
const [nodesOnNew] = await sql`
  select count(*)::int as n from mn_risk_matter_node where risk_matter_id = ${riskId}`;
ok("数据侧：新建事项节点数为 0（无预设节点）", nodesOnNew.n === 0, `节点数=${nodesOnNew.n}`);

const [obx] = await sql`select count(*)::int as n from mn_event_outbox where payload->>'risk_matter_id' = ${riskId}`;
ok("同事务写了 outbox", obx.n === 1, `n=${obx.n}`);

// ---- 5. 追加转（可二次）----
// 这张**故意用与上一张相同的案号**：§6.3 明写案号非唯一、重复只提示不阻止
//（不同法院案号体系会重号，真正的唯一锚点始终是内部编号）。
const conv2 = await call("POST", `/api/risk-matters/${riskId}/convert`, cookie, {
  cases: [card(3, { caseNo: `自定义案号-${stamp}` })],
});
ok(
  "**案号非唯一**：重复案号照样建案（只提示不阻止）",
  conv2.status === 201,
  `status=${conv2.status} ${JSON.stringify(conv2.body)?.slice(0, 80)}`,
);
const [afterConv2] = await sql`select conversion_status, converted_case_count from mn_risk_matter where id = ${riskId}`;
ok("可二次转：status 保持 1、计数到 3", conv2.status === 201 && afterConv2.conversion_status === 1 && afterConv2.converted_case_count === 3, `count=${afterConv2.converted_case_count}`);
const all3 = [...bigIds, BigInt(conv2.body.cases[0].id)];
for (const id of all3) createdCaseIds.add(String(id));

// ---- 6. 撤销：冻结门（2026-10-14 裁定）—— 本节整体改写 ----
//
// ⚠ **这一节改的是断言所表达的那条规则，不是把它们删掉。**
// 事项一旦转过案件就被冻结，而 `unconvertFromCase` 要求存在 `mn_risk_matter_case` 关联行；
// 关联行必然意味着 `conversion_status = 1`，两者在业务上互斥。
// 于是 UNCONVERT 对任何已转案件的事项都恒返回 422 `frozen`
//（用户当时在「保留端点并给出理由」与「删掉端点」之间选了前者）。
//
// 原先本节证明的是「三条前置（进展 / 非预设节点 / 费用）能挡住撤销、预设节点不挡」，
// 那个结论**现在无法通过本端点观测**（门在三条前置之前就返回了）。
// 因此：造数与控制断言**全部保留**，每一条改为证明新的那一条规则
// （冻结恒拒 / 冻结优先于前置 / 被拒后库一个字节都不动）；
// 三条前置的谓词本身由 `revred-unconvert.mjs` 的源码锚点继续守着
// （`node agent-work/verify-anchors.mjs` 盯 `sourceKind} <> 'preset'` 那条 needle）。

const noReason = await call("POST", `/api/risk-matters/${riskId}/unconvert`, cookie, {
  caseId: ids[0],
  reason: "   ",
});
ok("空白 reason → 400（schema 层拦）", noReason.status === 400, `status=${noReason.status}`);

const notLinked = await call("POST", `/api/risk-matters/${riskId}/unconvert`, cookie, {
  caseId: "1234567890",
  reason: "没关联",
});
ok(
  "**冻结门排在关联行判定之前**：带一个不存在的 caseId 也回 422 frozen（不是 404）",
  notLinked.status === 422 && notLinked.body?.error === "frozen",
  `status=${notLinked.status} err=${notLinked.body?.error}`,
);

// ---- 7. 撤一张：恒被拒，且库一个字节都不动 ----
const un1 = await call("POST", `/api/risk-matters/${riskId}/unconvert`, cookie, {
  caseId: ids[0],
  reason: "转错了，撤销第一张",
});
ok("撤销 → 422 frozen", un1.status === 422 && un1.body?.error === "frozen", `status=${un1.status} err=${un1.body?.error}`);
ok(
  "**答复点名「冻结」**（不是笼统的 blocked —— 两者的下一步完全不同）",
  String(un1.body?.message ?? "").includes("冻结"),
  String(un1.body?.message ?? "").slice(0, 70),
);

const [mid] = await sql`select conversion_status, converted_case_count, converted_at from mn_risk_matter where id = ${riskId}`;
ok(
  "被拒后 status 仍=1、计数仍=3、首次时间戳仍在（没有先改再报）",
  mid.conversion_status === 1 && mid.converted_case_count === 3 && mid.converted_at !== null,
  `status=${mid.conversion_status} count=${mid.converted_case_count}`,
);

const [auditNone] = await sql`select count(*)::int as n from mn_activity_log where action='UNCONVERT' and target_id = ${riskId}`;
ok("**被拒之后没有写 UNCONVERT 审计**（拒了就是没发生）", auditNone.n === 0, `n=${auditNone.n}`);

// ---- 8. 三条前置：造数保留，答复恒为 frozen（证明的是**优先级**）----
const thirdId = String(conv2.body.cases[0].id);
// author_id 是指向 mn_app_user 的真外键，取库里真实存在的那个而不是猜 id=1
const [author] = await sql`select id from mn_app_user where is_enabled and not is_deleted order by id limit 1`;
const [prog] = await sql`
  insert into mn_matter_progress (id, matter_id, progress_type, content, progress_date, author_id, created_at, updated_at)
  values (${7100000000000000000n + BigInt(stamp)}, ${thirdId}, 'routine', '冒烟：已有进展', current_date, ${author.id}, now(), now())
  returning id`;

const blocked = await call("POST", `/api/risk-matters/${riskId}/unconvert`, cookie, {
  caseId: thirdId,
  reason: "试着撤",
});
ok(
  "**冻结优先于三条前置**：案件上有进展，答复仍是 frozen 而不是 blocked",
  blocked.status === 422 && blocked.body?.error === "frozen",
  `status=${blocked.status} err=${blocked.body?.error}`,
);
ok(
  "答复里**不提「进展」**（把它并进 blocked 会让人跑去案件上清进展，而清完也撤不掉）",
  !String(blocked.body?.message ?? "").includes("进展"),
  String(blocked.body?.message ?? "").slice(0, 70),
);

const [stillLinked] = await sql`select count(*)::int as n from mn_risk_matter_case where risk_matter_id = ${riskId}`;
ok("被拒后关联行仍在（没先删再报）", stillLinked.n === 3, `n=${stillLinked.n}`);
const [midCount] = await sql`select converted_case_count from mn_risk_matter where id = ${riskId}`;
ok("被拒后计数未被改动", midCount.converted_case_count === 3, `count=${midCount.converted_case_count}`);
await sql`delete from mn_matter_progress where id = ${prog.id}`;

// ---- 9. 预设节点：降级为**纯数据侧控制断言** ----
//
// ⚠ 原断言是 HTTP 200「只剩 preset 就能撤」，它是「排除系统生成的预设节点」的唯一行为证明。
// 冻结门在它前面就返回了，那条结论**再也无法从本端点观测**——所以这里只留下
// "前提确实成立"的数据侧控制，而谓词本身继续由源码锚点（`verify-anchors.mjs`）守着。
// 承认观测能力变窄，比把断言改成恒真要诚实。
const [preset] = await sql`select count(*)::int as n from mn_matter_node where matter_id = ${thirdId} and source_kind = 'preset'`;
const [withPreset] = await sql`
  select count(*)::int as n from mn_matter_node where matter_id = ${thirdId} and source_kind <> 'preset'`;
ok(
  "**控制**：thirdId 上 progress 已清、非预设节点为 0（只剩系统生成的）",
  preset.n >= 0 && withPreset.n === 0,
  `preset=${preset.n} manual=${withPreset.n}`,
);

// ---- 10. 三条前置全部"满足"时，撤销依然恒拒（挡住它的不是前置）----
const unThird = await call("POST", `/api/risk-matters/${riskId}/unconvert`, cookie, {
  caseId: thirdId,
  reason: "进展已清，只剩系统预设节点",
});
ok(
  "**即使只差前置也撤不掉**：答复恒为 frozen",
  unThird.status === 422 && unThird.body?.error === "frozen",
  `status=${unThird.status} err=${unThird.body?.error}`,
);

// ---- 11. 归零分支已不存在：conversion_status 永不回 0 ----
//
// 原断言是「撤最后一张 → remaining=0，status 回 0、时间戳与操作人清空」。
// 裁定明写 `conversion_status` 再也不会回落到 0，而写 0 的那个分支就在本函数里。
// 所以这里断言的是新规则本身：撤不掉 ⇒ 计数不减、时间戳与操作人都在。
const unLast = await call("POST", `/api/risk-matters/${riskId}/unconvert`, cookie, {
  caseId: ids[1],
  reason: "撤销最后一张",
});
ok(
  "撤最后一张 → 422 frozen（不再是 remaining=0）",
  unLast.status === 422 && unLast.body?.error === "frozen",
  `status=${unLast.status} remaining=${unLast.body?.remaining}`,
);

const [zero] = await sql`select conversion_status, converted_case_count, converted_at, converted_by from mn_risk_matter where id = ${riskId}`;
ok(
  "**冻结之后不存在归零**：status 仍=1、计数仍=3、时间戳与操作人都还在",
  zero.conversion_status === 1 &&
    zero.converted_case_count === 3 &&
    zero.converted_at !== null &&
    zero.converted_by !== null,
  `status=${zero.conversion_status} count=${zero.converted_case_count} at=${zero.converted_at}`,
);

// ---- 11b. 案件本身全部保留（修订稿 §3.4：只能删关联行）----
// 冻结之后这一条不再有"撤销会删案件吗"的作用，保留它是作为**清场前的对照**：
// 这一整节什么都没删，所以三个案件都还在。若哪天撤销又被放开，这条会立刻失效。
const [caseLeft] = await sql`select count(*)::int as n from mn_matter where id = any(${sql.array(all3)}::bigint[])`;
ok("案件本身全部保留", caseLeft.n === all3.length, `n=${caseLeft.n}/${all3.length}`);

// ---- 12. 重复撤同一张：不再是 404，恒为 422 frozen ----
// 冻结门排在关联行判定之前，所以"换个 id 再试"这条探测拿到的是**同一个答案**——
// 这正是要达到的效果：不让调用方以为"只是这个 id 不行，换一个也许能撤"。
const again = await call("POST", `/api/risk-matters/${riskId}/unconvert`, cookie, {
  caseId: ids[0],
  reason: "再撤一次",
});
ok(
  "重复撤销 → 422 frozen（不是 404、不是 500）",
  again.status === 422 && again.body?.error === "frozen",
  `status=${again.status}`,
);

// ---- 12b. 软删口径：三条前置的同口径已无法从本端点观测，改为证明答复稳定 ----
//
// 三条前置（进展/节点/费用）必须**同口径**：`NOT is_deleted`。原先只有进展那条漏了，
// 于是"列表里已经看不到这条进展了，撤销却还被它挡着"，而提示语会说"案件上已经登记了进展"。
// 光读注释看不出来（注释把三条写成了统一口径），是检查子代理逐条对照谓词才发现的。
// 与费用那条（`smoke-expenses.mjs`）对称。
//
// ⚠ 冻结之后，这一对断言证明的不再是"软删放行"，而是"**答复与进展软删与否无关**"。
// 它守的是冻结门的稳定性（同一条事项、同一个端点，答复不随库里的其他变化漂移）。
// 软删谓词本身的守卫仍是 `revred-unconvert.mjs` + `revred-expenses.mjs` 的源码锚点。
const convSoft = await call("POST", `/api/risk-matters/${riskId}/convert`, cookie, {
  cases: [card(4, { caseNo: `软删进展用例-${stamp}` })],
});
ok("为软删用例新转一张案件 → 201", convSoft.status === 201, `status=${convSoft.status}`);
const softCaseId = String(convSoft.body?.cases?.[0]?.id ?? "");
if (softCaseId) createdCaseIds.add(softCaseId);
const [progSoft] = await sql`
  insert into mn_matter_progress (id, matter_id, progress_type, content, progress_date, author_id, created_at, updated_at)
  values (${7200000000000000000n + BigInt(stamp)}, ${softCaseId}, 'routine', '冒烟：将被软删的进展', current_date, ${author.id}, now(), now())
  returning id`;
const softBlocked = await call("POST", `/api/risk-matters/${riskId}/unconvert`, cookie, {
  caseId: softCaseId,
  reason: "冒烟：先看未软删时的答复",
});
ok(
  "未软删时 → 422 frozen（控制项在，前提成立）",
  softBlocked.status === 422 && softBlocked.body?.error === "frozen",
  `status=${softBlocked.status}`,
);
await sql`update mn_matter_progress set is_deleted = true, deleted_at = now() where id = ${progSoft.id}`;
const softPass = await call("POST", `/api/risk-matters/${riskId}/unconvert`, cookie, {
  caseId: softCaseId,
  reason: "冒烟：进展已软删，撤销仍应被冻结门挡住",
});
ok(
  "**软删之后仍然是 422 frozen**（不是 200：答复与软删口径无关）",
  softPass.status === 422 && softPass.body?.error === "frozen",
  `status=${softPass.status} err=${softPass.body?.error}`,
);
// ---- 清场在 finally 里，见上方 cleanup ----
} catch (err) {
  fail++;
  console.log(`[FAIL] 脚本中断 —— ${err?.message ?? err}`);
} finally {
  try {
    await cleanup();
    console.log("[clean] 清场完成");
  } catch (e) {
    noteCleanupFailure("夹具清场", e);
  }
  // ⚠ 这一句必须在 try 里：`dropSmokeAccount` 是**故意**抛错的（还有 NOT NULL 的
  //   业务行指着账号），裸调时它一抛就中断整个 finally —— 后面的 `sql.end()` 都不跑，
  //   而且失败只留在 unhandledRejection 里，退出码看不出"库脏了"。
  try {
    await dropSmokeAccount(sql, smoke.id);
  } catch (e) {
    noteCleanupFailure(`临时账号 ${smoke.username}（${smoke.id}）`, e);
  }
  await sql.end();
}

console.log(`\n${fail ? "FAIL" : "PASS"}：${pass} 通过 / ${fail} 失败`);
finishSmoke(fail);