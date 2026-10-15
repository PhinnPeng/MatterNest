import {
  createSmokeAccount,
  dropSmokeAccount,
  finishSmoke,
  noteCleanupFailure,
  ROLE_CODES,
} from "./_testacct.mjs";
/**
 * 案件侧来源风险卡片的真 HTTP 冒烟（MATT-65 / F2-22）。
 *
 * ## 这条链路要钉住什么
 *
 * `riskMatterCase`（关联表）全仓只被 `services/risks.ts` 用：写关联、撤销、计数、
 * **事项侧反查**（详情页那张「已转案件」卡）。于是 F1-19（事项→案件）早已实现，
 * 而 F2-22（案件→事项）的反查根本不存在 —— 案件详情页没有来源卡片，
 * `spec-slice1` Problem Statement 第 2 条说的事（「关联一断，案件就找不到源头」）
 * 在案件这一侧原样成立。
 *
 * ## 两组断言，第二组比第一组更重要
 *
 * ① **正向**：转过案件的案件，详情里能看到来源事项（名称/编号/等级都在），
 *    且带一条点得进的链接（G2 之后剩下的唯一链路验收点）。
 * ② **泄露面**：来源事项不可见时 —— 卡片渲染占位，且**响应体里不含那条事项的
 *    任何字段**。这一条比①重：它防的是"占位做得好看、数据照常泄露"，
 *    而那正是这个功能最危险的失败形态（AC 第 5 条原话）。
 *
 * ⚠ ②的两个断言必须**同时**断：只断"有占位"的话，实现可以既渲染占位、
 *    又把整条事项塞进响应体（前端不显示而已）—— 那种形态肉眼看不出来。
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
});

// L1 全局范围（看得见全部）；L3 self_operator（只看得见自己经办或创建的）
/**
 * ⚠ 两个账号之间**必须错开至少 1ms**：`createSmokeAccount` 的角色行 id 是
 * `Date.now()*1000 + 序号`，同一毫秒建的两个账号会撞 `mn_app_user_role` 主键，
 * 而那里是 `on conflict do nothing` ⇒ **后一个账号静默丢掉全部角色**。
 * 症状极隐蔽：登录成功、能建事项，但 `dataScope` 落成 owned（无角色时的兜底），
 * 于是"靠 staff 行看得见"这条整段失效，读起来像权限判错了。
 * （本票第一版就是这么栽的：`/api/session` 回 `roles: []`。）
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const boss = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
await sleep(2);
const outsider = await createSmokeAccount(sql, { roles: [ROLE_CODES.joined] });

const matterIds = [];
const riskIds = [];

async function cleanup() {
  // 关联行先走（没有 FK，删不掉也不报错 —— 靠顺序保证）
  for (const id of matterIds) {
    await sql`delete from mn_risk_matter_case where matter_id = ${id}`.catch((e) =>
      noteCleanupFailure(`关联行 ${id}`, e),
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
    await sql`delete from mn_risk_matter_case where risk_matter_id = ${id}`.catch((e) =>
      noteCleanupFailure(`关联行 ${id}`, e),
    );
    for (const q of [
      `delete from mn_activity_log where risk_matter_id=${id}`,
      `delete from mn_risk_matter_staff where risk_matter_id=${id}`,
      `delete from mn_risk_matter where id=${id}`,
    ]) {
      await sql.unsafe(q).catch((e) => noteCleanupFailure(`夹具行 ${q}`, e));
    }
  }
  for (const acc of [boss, outsider]) {
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

try {
  const c = (await login(boss.username, boss.password)).cookie;
  const oC = (await login(outsider.username, outsider.password)).cookie;

  // ── 1. 建事项 → 转出案件（真实链路，不是直插关联行）──
  const r = await call("POST", "/api/risk-matters", c, {
    name: `来源冒烟 事项 ${stamp}`,
    type: "contract",
    level: "high",
    description: "转出一个案件，然后从案件侧反查回来",
  });
  ok("建事项 → 201", r.status === 201, `status=${r.status}`);
  const rid = r.body?.id;
  riskIds.push(rid);

  // 转案件的前置：事项至少要有一个关联当事人（服务层 `parties_required`）。
  // 请求体是 `{ parties: [挂接…] }`（`riskPartyAppendSchema`），每条要么 `partyId`
  // 引用既有、要么 `name`+`type` 快建（`partyLinkSchema` 的 superRefine）。
  const party = await call("POST", `/api/risk-matters/${rid}/parties`, c, {
    parties: [
      {
        name: `来源冒烟 当事人 ${stamp}`,
        type: "legal_person",
        partyRole: "applicant",
      },
    ],
  });
  // 追加接口回的是 200 + `{added}`，不是 201 —— 断 201 会以"接口写错了"的形式红，
  // 而真因是"追加"与"新建"两种语义的返回码不同。
  ok(
    "给事项挂一个当事人 → 200 且 added=1",
    party.status === 200 && party.body?.added === 1,
    `status=${party.status} ${JSON.stringify(party.body)?.slice(0, 60)}`,
  );

  const conv = await call("POST", `/api/risk-matters/${rid}/convert`, c, {
    // 转案件的请求体是 `{ cases: [卡片…] }`（`convertSchema`，一次可转多案）。
    // ⚠ 卡里**不带** `parties` / `description` / `ownerId`（`convertCardSchema` omit 掉的三项），
    //   而服务层另要求「事项已有关联当事人」—— 所以先给事项挂一个当事人再转。
    cases: [
      {
        name: `来源冒烟 案件 ${stamp}`,
        cause: "建设工程施工合同纠纷",
        caseType: "civil_commercial",
        procedure: "first_instance",
        litigationRole: "defendant",
        level: "high",
      },
    ],
  });
  ok("转案件 → 201", conv.status === 201, `status=${conv.status} ${JSON.stringify(conv.body)?.slice(0, 90)}`);
  const caseId = conv.body?.cases?.[0]?.id ?? null;
  ok("拿到转出的案件 id", !!caseId, `caseId=${caseId}`);
  if (caseId) matterIds.push(caseId);

  // ── 2. 正向：L1 看得见来源 ──
  const detail = await call("GET", `/api/matters/${caseId}`, c);
  ok("案件详情 → 200", detail.status === 200, `status=${detail.status}`);
  const src = detail.body?.sourceRisks ?? [];
  ok(
    "**案件侧能反查到来源事项**（G2 之后剩下的唯一链路验收点）",
    src.length === 1 && String(src[0].id) === String(rid),
    `n=${src.length} 首条 id=${src[0]?.id}（事项 id=${rid}）`,
  );
  ok(
    "来源带编号与名称（不是只有一行 id）",
    !!src[0]?.code && !!src[0]?.name,
    `code=${src[0]?.code} name=${src[0]?.name}`,
  );
  ok(
    "详情响应体里**没有** hidden 计数（看得见就没有占位）",
    (detail.body?.sourceRisksHidden ?? 0) === 0,
    `hidden=${detail.body?.sourceRisksHidden}`,
  );
  // 链接点得进去：占位不能只成越权入口，来源必须真的可跳转
  const jump = await call("GET", `/api/risk-matters/${rid}`, c);
  ok("**卡上那条链接点得进去**（不是给了 id 却 404）", jump.status === 200, `status=${jump.status}`);

  // ── 3. 泄露面：L3 看不见来源 ──
  const denied = await call("GET", `/api/matters/${caseId}`, oC);
  ok(
    "看不见这条案件的账号连详情都 404（前提：整条链路对他不可见）",
    denied.status === 404,
    `status=${denied.status}`,
  );

  // 换一个看得见案件、但看不见来源事项的账号：
  // 把案件**分派**给 outsider 当协办（`mn_matter_staff` 有行 ⇒ participating 范围看得见），
  // 来源事项仍是 boss 建的（不在他范围）。
  // ⚠ 必须**直查库确认 staff 行真的落下**：只断 HTTP 200 的话，
  //   "加了但没落库"会让后面每一步都以"他其实看不见"的形式假绿/假红，
  //   而那种形态读起来像权限判错了。
  const reassign = await call("POST", `/api/matters/${caseId}/staff`, c, {
    userIds: [String(outsider.id)],
    staffRole: "co_owner",
  });
  ok("把 outsider 加成协办 → 200", reassign.status === 200, `status=${reassign.status}`);
  const [staffRow] = await sql`
    select staff_role from mn_matter_staff
     where matter_id = ${caseId} and user_id = ${outsider.id} limit 1`;
  ok(
    "**staff 行真的落了库**（HTTP 200 不等于落库 —— 后面每一步都以它为前提）",
    !!staffRow,
    `role=${staffRow?.staff_role}`,
  );

  // ⚠ **先钉住他的数据范围**：`joined_operator` ⇒ participating，这是"靠 staff 行看得见"
  //   的唯一前提。scope 若退成 owned，后面每一步都会以"他看不见"的形式失败，
  //   而那种形态读起来像权限判错了（本票第一版就是这么栽的）。
  const [outsiderActor] = await Promise.all([
    call("GET", "/api/session", oC),
    call("GET", "/api/session", c),
  ]);
  ok(
    "**outsider 的数据范围是 participating**（否则 staff 行白写）",
    outsiderActor.body?.dataScope === "participating",
    `scope=${outsiderActor.body?.dataScope} roles=${JSON.stringify(outsiderActor.body?.roles ?? [])}`,
  );
  ok("对照：boss 是 all", c && (await call("GET", "/api/session", c)).body?.dataScope === "all");

  const detailOutsider = await call("GET", `/api/matters/${caseId}`, oC);
  ok("现在他看得见这条案件了", detailOutsider.status === 200, `status=${detailOutsider.status}`);
  const srcOut = detailOutsider.body?.sourceRisks ?? [];
  const hiddenOut = detailOutsider.body?.sourceRisksHidden ?? 0;
  ok(
    "**但他看不见来源事项 ⇒ 列表空、占位计数 > 0**",
    srcOut.length === 0 && hiddenOut > 0,
    `visible=${srcOut.length} hidden=${hiddenOut}`,
  );

  // ── 4. 泄露面的核心：响应体里不含那条事项的任何字段 ──
  // 只断"有占位"不够 —— 实现可以既渲染占位、又把整条事项塞进响应体（前端不显示而已）。
  // 那种形态肉眼看不出来，只能靠"整段文本里搜不到来源事项的任何标识"来抓。
  const raw = JSON.stringify(detailOutsider.body ?? {});
  const [srcRow] = await sql`select code, name from mn_risk_matter where id = ${rid}`;
  const leakCode = !!srcRow?.code && raw.includes(String(srcRow.code));
  const leakName = !!srcRow?.name && raw.includes(String(srcRow.name));
  const leakId = raw.includes(String(rid));
  ok(
    "**响应体里没有来源事项的编号**（占位不能夹带数据）",
    !leakCode,
    `code=${srcRow?.code} 出现=${leakCode}`,
  );
  ok(
    "**响应体里没有来源事项的名称**",
    !leakName,
    `name=${srcRow?.name} 出现=${leakName}`,
  );
  ok(
    "**响应体里连来源事项的 id 都没有**（给了 id 就等于给了枚举入口）",
    !leakId,
    `id=${rid} 出现=${leakId}`,
  );
  ok(
    "占位文案的数字是真的（说「有 N 条」就真是 N 条，不是拍一个）",
    hiddenOut === 1,
    `hidden=${hiddenOut}`,
  );

  // ── 5. 没有来源的案件：空态，且与"看不见"是两套文案 ──
  const plain = await call("POST", "/api/matters", c, {
    name: `来源冒烟 直建 ${stamp}`,
    cause: "建设工程施工合同纠纷",
    caseType: "civil_commercial",
    procedure: "first_instance",
    litigationRole: "defendant",
    level: "high",
  });
  matterIds.push(plain.body?.id);
  const plainDetail = await call("GET", `/api/matters/${plain.body.id}`, c);
  ok(
    "**直接新建的案件没有来源**（空数组 + hidden=0，两张卡都不渲染）",
    (plainDetail.body?.sourceRisks ?? []).length === 0 &&
      (plainDetail.body?.sourceRisksHidden ?? 0) === 0,
    `visible=${(plainDetail.body?.sourceRisks ?? []).length} hidden=${plainDetail.body?.sourceRisksHidden}`,
  );
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
