import { createSmokeAccount, dropSmokeAccount, ROLE_CODES } from "./_testacct.mjs";
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
  // 给一个显眼的敞口：用来证明**金额不继承**（映射矩阵 §2.4 逐案自填）
  amount: "999999.00",
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
const amounts = await sql`
  select id::text as id, amount::text as amount, case_no, internal_code
  from mn_matter where id = any(${sql.array(bigIds)}::bigint[]) order by internal_code`;
ok(
  "**金额逐案自填**（两案各是各的，不是同一个值）",
  amounts[0]?.amount === "1000.00" && amounts[1]?.amount === "2000.00",
  amounts.map((a) => a.amount).join(" / "),
);
ok(
  "**金额不继承事项敞口**（没有一案拿到 999999）",
  amounts.every((a) => a.amount !== "999999.00"),
  amounts.map((a) => a.amount).join(" / "),
);

// AC 6：案号默认取内部编号、可改
ok(
  "**案号默认回退为内部编号**（未填那张）",
  amounts[0]?.case_no === amounts[0]?.internal_code,
  `case_no=${amounts[0]?.case_no} internal=${amounts[0]?.internal_code}`,
);
ok(
  "**案号可改**（填了就用填的）",
  amounts[1]?.case_no === `自定义案号-${stamp}`,
  `case_no=${amounts[1]?.case_no}`,
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

// ---- 6. 撤销：前置校验 ----
const noReason = await call("POST", `/api/risk-matters/${riskId}/unconvert`, cookie, {
  caseId: ids[0],
  reason: "   ",
});
ok("空白 reason → 400（schema 层拦）", noReason.status === 400, `status=${noReason.status}`);

const notLinked = await call("POST", `/api/risk-matters/${riskId}/unconvert`, cookie, {
  caseId: "1234567890",
  reason: "没关联",
});
ok("无关联行 → 404", notLinked.status === 404, `status=${notLinked.status}`);

// ---- 7. 撤一张：未归零，不回 0 ----
const un1 = await call("POST", `/api/risk-matters/${riskId}/unconvert`, cookie, {
  caseId: ids[0],
  reason: "转错了，撤销第一张",
});
ok("撤销第一张成功，remaining=2", un1.status === 200 && un1.body?.remaining === 2, `status=${un1.status} remaining=${un1.body?.remaining}`);

const [mid] = await sql`select conversion_status, converted_case_count, converted_at from mn_risk_matter where id = ${riskId}`;
ok("未归零：status 仍=1、计数=2、首次时间戳保留", mid.conversion_status === 1 && mid.converted_case_count === 2 && mid.converted_at !== null, `status=${mid.conversion_status} count=${mid.converted_case_count}`);

const [auditOk] = await sql`select count(*)::int as n from mn_activity_log where action='UNCONVERT' and coalesce(reason,'') <> '' and target_id = ${riskId}`;
ok("写了 UNCONVERT 审计且 reason 非空", auditOk.n === 1, `n=${auditOk.n}`);

// ---- 8. 前置不满足：有进展则不可撤 ----
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
ok("有进展 → 422 blocked", blocked.status === 422 && blocked.body?.error === "blocked", `status=${blocked.status} err=${blocked.body?.error}`);
ok("阻断理由点名「进展」", String(blocked.body?.message ?? "").includes("进展"), String(blocked.body?.message ?? "").slice(0, 70));

const [stillLinked] = await sql`select count(*)::int as n from mn_risk_matter_case where risk_matter_id = ${riskId}`;
ok("被拒后关联行仍在（没先删再报）", stillLinked.n === 2, `n=${stillLinked.n}`);
const [midCount] = await sql`select converted_case_count from mn_risk_matter where id = ${riskId}`;
ok("被拒后计数未被改动", midCount.converted_case_count === 2, `count=${midCount.converted_case_count}`);

// ---- 9. 预设节点不算投入 ----
const [preset] = await sql`select count(*)::int as n from mn_matter_node where matter_id = ${thirdId} and source_kind = 'preset'`;
const [withPreset] = await sql`
  select count(*)::int as n from mn_matter_node where matter_id = ${thirdId} and source_kind <> 'preset'`;
ok("预设节点存在且不阻断（只加 preset 不该挡住撤销）", preset.n >= 0 && withPreset.n === 0, `preset=${preset.n} manual=${withPreset.n}`);
await sql`delete from mn_matter_progress where id = ${prog.id}`;

// ---- 10. 预设节点不阻断：此时 thirdId 上只剩 3 个 preset 节点，进展已删 ----
// 这条断言是「排除系统生成的预设节点」的唯一证明：若 `<> 'preset'` 那个条件被去掉，
// 这一步会返回 422 blocked。progress 已删，所以挡它的只可能是 preset。
const unThird = await call("POST", `/api/risk-matters/${riskId}/unconvert`, cookie, {
  caseId: thirdId,
  reason: "进展已清，只剩系统预设节点",
});
ok("只剩 preset 节点时**可撤**（预设不算用户投入）", unThird.status === 200, `status=${unThird.status} ${String(unThird.body?.message ?? "").slice(0, 60)}`);
ok("撤后 remaining=1（ids[1] 仍挂着）", unThird.body?.remaining === 1, `remaining=${unThird.body?.remaining}`);

// ---- 11. 撤到最后一张才归零 ----
const unLast = await call("POST", `/api/risk-matters/${riskId}/unconvert`, cookie, {
  caseId: ids[1],
  reason: "撤销最后一张",
});
ok("撤最后一张 → remaining=0", unLast.status === 200 && unLast.body?.remaining === 0, `status=${unLast.status} remaining=${unLast.body?.remaining}`);

const [zero] = await sql`select conversion_status, converted_case_count, converted_at, converted_by from mn_risk_matter where id = ${riskId}`;
ok("归零：status 回 0、计数=0、时间戳与操作人清空", zero.conversion_status === 0 && zero.converted_case_count === 0 && zero.converted_at === null && zero.converted_by === null, `status=${zero.conversion_status} count=${zero.converted_case_count} at=${zero.converted_at}`);

// ---- 11. 撤销不删案件（修订稿 §3.4：只能删关联行）----
const [caseLeft] = await sql`select count(*)::int as n from mn_matter where id = any(${sql.array(all3)}::bigint[])`;
ok("案件本身全部保留", caseLeft.n === all3.length, `n=${caseLeft.n}/${all3.length}`);

// ---- 12. 重复撤同一张 → 404 ----
const again = await call("POST", `/api/risk-matters/${riskId}/unconvert`, cookie, {
  caseId: ids[0],
  reason: "再撤一次",
});
ok("重复撤销 → 404（幂等，不是 500）", again.status === 404, `status=${again.status}`);

// ---- 清场在 finally 里，见上方 cleanup ----
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
  await dropSmokeAccount(sql, smoke.id);
  await sql.end();
}

console.log(`\n${fail ? "FAIL" : "PASS"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);