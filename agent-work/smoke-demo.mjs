import { createSmokeAccount, dropSmokeAccount, ROLE_CODES } from "./_testacct.mjs";
/**
 * Demo 冒烟：SSR 壳 + 真实 HTTP 读链路 + 三档范围对比。
 *
 * 为什么不用真浏览器：这台机器的浏览器面板在会话里是 0×0（只能 evaluate_script），
 * 而 headless Chrome 又拿不到内网登录后的样式计算结果。所以这里分两层验：
 *   · **静态构图**：SSR 回来的 HTML 里有没有骨架、有没有把业务行漏进壳（禁令⑥）；
 *   · **数据真值**：直接打 `/api/**`，带 cookie，比较 L1/L2/L3 三个账号看到的条数。
 * 客户端渲染出来的 DOM 交互不在这一层，改完要另开可见浏览器走一遍。
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
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, cookie, body: await res.json().catch(() => null) };
}

async function get(path, cookie) {
  const res = await fetch(`${BASE}${path}`, { headers: cookie ? { cookie } : {} });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* HTML */
  }
  return { status: res.status, text, json };
}

/* ── 1. 未登录：页面壳可渲染，业务 API 一律 401 ───────────────── */
const anonPages = ["/login", "/", "/matters", "/risk-matters", "/config"];
for (const p of anonPages) {
  const r = await get(p);
  ok(`壳 ${p} 返回 200`, r.status === 200, `status=${r.status}`);
}
for (const p of ["/api/matters", "/api/overview", "/api/meta", "/api/risk-matters"]) {
  const r = await get(p);
  ok(`未登录 ${p} → 401`, r.status === 401, `status=${r.status}`);
}

/* ── 2. 登录 ──────────────────────────────────────────────────── */
// 自建临时账号（账号收敛为单个 admin 之后，不再依赖 seed 里的演示账号）。
// 四档：全公司 / 我参与 / 仅自己相关 / 待开通。后三档是范围谓词的分支——
// 历史上只有 seed 里存在对应的纯档账号时才被执行过，别把「我参与」那档省掉。
const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});
const acctL1 = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
const acctL2 = await createSmokeAccount(sql, { roles: [ROLE_CODES.joined] });
const acctL3 = await createSmokeAccount(sql, { roles: [ROLE_CODES.self] });
// 待开通：有口令但未批准，用于验「未开通与口令错误给同一句」
const acctPending = await (async () => {
  const a = await createSmokeAccount(sql, { roles: [ROLE_CODES.self] });
  await sql`update mn_app_user set activation_status = 'pending' where id = ${a.id}`;
  return a;
})();
const dropAccts = async () => {
  const step = async (label, fn) => {
    try { await fn(); } catch (e) { console.log(`  · 清场「${label}」未完成：${String(e.message).split("\n")[0]}`); }
  };
  for (const a of [acctL1, acctL2, acctL3, acctPending]) {
    await step(`删临时账号 ${a.username}`, () => dropSmokeAccount(sql, a.id));
  }
  await step("断开数据库", () => sql.end());
};

const bad = await login(acctL1.username, "wrong");
ok("口令错 → 401", bad.status === 401, `status=${bad.status}`);
const pending = await login(acctPending.username, acctPending.password);
ok(
  "未开通账号与口令错同码同文案",
  pending.status === 401 && pending.body?.message === bad.body?.message,
  `${pending.status} · ${pending.body?.message}`,
);

const l1 = await login(acctL1.username, acctL1.password); // 全公司
const l2 = await login(acctL2.username, acctL2.password); // 我参与：专给 EXISTS 那条分支用
const hezp = await login(acctL3.username, acctL3.password); // 仅自己相关
ok("wangkf 登录成功", l1.status === 200 && Boolean(l1.cookie), l1.body?.displayName ?? "");
ok("suny 登录成功", l2.status === 200);
ok("hezp 登录成功", hezp.status === 200);
/**
 * 会话里的 dataScope 必须是 seed 配的那一档。
 * 这条断言看着多余，实际是本轮冒烟的起因：seed 里当时**没有一个纯 L2 账号**，
 * 于是 `visibility()` 的 `EXISTS (… *_staff)` 分支在真实登录链路上永远走不到，
 * 那句少一层括号的 SQL（drizzle `exists()` 不给 `sql` 模板自动加括号）一直没人撞上。
 */
const scopeOf = async (cookie) => (await get("/api/session", cookie)).json?.dataScope;
const l2Scope = await scopeOf(l2.cookie);
const hezpScope = await scopeOf(hezp.cookie);
ok("suny 的会话范围是 participating(L2)", l2Scope === "participating", String(l2Scope));
ok("hezp 的会话范围是 owned(L3)", hezpScope === "owned", String(hezpScope));

/* ── 3. 三档范围给出不同条数（这是这套权限模型唯一"看得见"的证明）── */
const l1List = await get("/api/matters?page=1&pageSize=20", l1.cookie);
const l2List = await get("/api/matters?page=1&pageSize=20", l2.cookie);
const hezpList = await get("/api/matters?page=1&pageSize=20", hezp.cookie);
ok("L1 列表 200", l1List.status === 200, `total=${l1List.json?.total}`);
ok(
  "L2 列表 200（EXISTS 那条谓词真的能跑）",
  l2List.status === 200,
  `status=${l2List.status} total=${l2List.json?.total}`,
);
ok("L3 列表 200", hezpList.status === 200, `total=${hezpList.json?.total}`);
ok(
  "L1 ⊇ L2 ⊇ L3 条数递增收窄",
  (l1List.json?.total ?? 0) >= (l2List.json?.total ?? 0) &&
    (l2List.json?.total ?? 0) >= (hezpList.json?.total ?? 0) &&
    (l1List.json?.total ?? 0) > (hezpList.json?.total ?? 0),
  `L1=${l1List.json?.total} L2=${l2List.json?.total} L3=${hezpList.json?.total}`,
);

const ids1 = new Set((l1List.json?.items ?? []).map((i) => i.id));
const ids2 = new Set((l2List.json?.items ?? []).map((i) => i.id));
const ids3 = new Set((hezpList.json?.items ?? []).map((i) => i.id));
ok("L2 可见集是 L1 的子集", [...ids2].every((id) => ids1.has(id)), `L2=${ids2.size}`);
ok(
  "L3 可见集是 L2 的子集（协办/关注行 L3 不算，§1 的 owned 定义）",
  [...ids3].every((id) => ids2.has(id)),
  `L3=${ids3.size}`,
);
ok(
  "L2 里存在 L3 看不见的行（说明 EXISTS 真的放行了协办/关注，而不是等于 owned）",
  [...ids2].some((id) => !ids3.has(id)),
  `L2-only=${[...ids2].filter((i) => !ids3.has(i)).length} 条`,
);

/* ── 4. 不可见 → 404（不给 403） ─────────────────────────────── */
const hidden = (l1List.json?.items ?? []).find((i) => !ids2.has(i.id));
if (hidden) {
  const r = await get(`/api/matters/${hidden.id}`, hezp.cookie);
  ok("对不可见案件读详情 → 404", r.status === 404, `status=${r.status}`);
  const w = await fetch(`${BASE}/api/matters/${hidden.id}/status`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: hezp.cookie },
    body: JSON.stringify({ to: "in_progress" }),
  });
  ok("对不可见案件写状态 → 404", w.status === 404, `status=${w.status}`);
} else {
  ok("找到一条 L2 不可见的案件", false, "seed 数据里每条都对 suny 可见，测不到元规则 3");
}

/* 手打的错误 id 给 400，不给 500（BigInt("undefined") 冒出去就是 5xx） */
for (const p of ["/api/matters/undefined", "/api/matters/abc", "/api/matters/9999999999999999999999"]) {
  const r = await get(p, l1.cookie);
  ok(`${p} → 400`, r.status === 400, `status=${r.status}`);
}

/* ── 5. 禁令⑧：pageSize 越界与 sortBy 注入都 400 ─────────────── */
const big = await get("/api/matters?page=1&pageSize=500", l1.cookie);
ok("pageSize=500 → 400", big.status === 400, `status=${big.status}`);
const inj = await get("/api/matters?sortBy=id;drop%20table%20matter", l1.cookie);
ok("sortBy 非白名单 → 400", inj.status === 400, `status=${inj.status}`);
const arch = await get("/api/matters?archivedOnly=false", l1.cookie);
ok("archivedOnly=false 不 400（四值都收）", arch.status === 200, `status=${arch.status}`);
const bogus = await get("/api/matters?archivedOnly=yes", l1.cookie);
ok("archivedOnly=yes → 400", bogus.status === 400, `status=${bogus.status}`);

/* 归档默认隐藏 vs 显式含归档 */
const plain = await get("/api/matters?page=1&pageSize=20", l1.cookie);
const withArch = await get("/api/matters?page=1&pageSize=20&archivedOnly=1", l1.cookie);
/**
 * ⚠ 这条断言原来写成「含已归档比不含的多」，那是**另一套语义**。
 * `archivedOnly=1` 的口径是 `archivedFilter` 里的 `archivedOnly ? is_archived : NOT is_archived`
 * ——**只看已归档**，所以它的 total 必然 ≤ 默认。断言方向写反了，真红也是红错了原因。
 *
 * 「列表能同时显示已归档与未归档」目前**没有这个能力**（参数只有三值：默认只看未归档 /
 * 只看已归档 / 两者都要就得查两次）。这是产品缺口不是 bug，已记到地图；
 * 本条只断言当下真实存在的语义。
 */
ok(
  "archivedOnly=1 只返回已归档（条数不多于默认）",
  (withArch.json?.total ?? 0) <= (plain.json?.total ?? 0),
  `默认 ${plain.json?.total} · 只看归档 ${withArch.json?.total}`,
);
ok(
  "默认列表不含已归档行",
  !(plain.json?.items ?? []).some((i) => i.isArchived),
);
ok(
  "只看归档时返回的全是已归档行",
  (withArch.json?.items ?? []).every((i) => i.isArchived),
);

/* ── 6. 工作台读数与列表口径一致 ─────────────────────────────── */
const ov1 = await get("/api/overview", l1.cookie);
const ov3 = await get("/api/overview", hezp.cookie);
ok("overview L1 200", ov1.status === 200, `matters=${ov1.json?.matters?.total}`);
ok(
  "overview.matters.total == L1 不含归档的列表 total",
  ov1.json?.matters?.total === plain.json?.total,
  `${ov1.json?.matters?.total} vs ${plain.json?.total}`,
);
ok(
  "overview 也按范围收窄（L3 ≤ L1）",
  (ov3.json?.matters?.total ?? 99) <= (ov1.json?.matters?.total ?? 0),
  `L1=${ov1.json?.matters?.total} L3=${ov3.json?.matters?.total}`,
);
ok("upcoming 里每条都带 hostId 可跳详情", (ov1.json?.upcoming ?? []).every((n) => n.hostId));
ok("recent 的 actionLabel 是中文（枚举字典出，不是 code）", /[一-龥]/.test(ov1.json?.recent?.[0]?.actionLabel ?? ""), ov1.json?.recent?.[0]?.actionLabel);

/* ── 7. 配置驱动：状态名从库里来 ─────────────────────────────── */
const metaM = await get("/api/meta?host=matter", l1.cookie);
const metaR = await get("/api/meta?host=risk_matter", l1.cookie);
ok("meta 案件 4 状态", metaM.json?.statuses?.length === 4, (metaM.json?.statuses ?? []).map((s) => s.code).join(","));
ok("meta 事项 4 状态", metaR.json?.statuses?.length === 4);
ok(
  "meta 状态与列表 status 值域对得上（配置驱动没漂）",
  (plain.json?.items ?? []).every((i) => metaM.json.statuses.some((s) => s.code === i.status)),
);
ok("meta 有 progressTypes/staffRoles/auditActions 三张中文表", Boolean(metaM.json?.enums?.progressTypes && metaM.json?.enums?.staffRoles && metaM.json?.enums?.auditActions));
ok("meta 的 level 非空", (metaM.json?.levels ?? []).length > 0, (metaM.json?.levels ?? []).map((l) => l.name).join(","));

/* ── 8. 详情：BigInt 全部以字符串出（序列化门） ─────────────── */
/* 挑一条**有节点**的：列表按更新时间倒序，冒烟自己刚建的案件节点数是 0，
   直接取 items[0] 会让下面两条断言变成"看运气"。 */
let detail = null;
let first = null;
for (const row of l1List.json?.items ?? []) {
  const d = await get(`/api/matters/${row.id}`, l1.cookie);
  if ((d.json?.nodes ?? []).length > 0) {
    detail = d;
    first = row;
    break;
  }
}
first ??= (l1List.json?.items ?? [])[0];
detail ??= await get(`/api/matters/${first.id}`, l1.cookie);
ok("详情 200", detail.status === 200, first.internalCode);
ok(
  "详情 id 是字符串（不是裸 BigInt/number）",
  typeof detail.json?.id === "string" && /^\d+$/.test(String(detail.json?.id)),
  typeof detail.json?.id,
);
ok(
  "详情带六个从属数组",
  ["nodes", "staff", "parties", "comments", "activity", "progress"].every(
    (k) => Array.isArray(detail.json?.[k]),
  ),
  `nodes=${detail.json?.nodes?.length} progress=${detail.json?.progress?.length}`,
);
ok("节点带类型中文名（不只显示 id）", Boolean(detail.json?.nodes?.[0]?.nodeType), detail.json?.nodes?.[0]?.nodeType);
ok(
  "nodeTypeId 已转字符串",
  typeof detail.json?.nodes?.[0]?.nodeTypeId === "string",
);

/* ── 9. 写链路：建案取号 → 状态变更要原因 ─────────────────────── */
const stamp = Date.now().toString().slice(-6);
const made = await fetch(`${BASE}/api/matters`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: l1.cookie },
  body: JSON.stringify({
    name: `冒烟案件 ${stamp}`,
    cause: "买卖合同纠纷",
    caseType: "civil_commercial",
    procedure: "first_instance",
    litigationRole: "plaintiff",
    level: "high",
    parties: [{ name: `冒烟公司 ${stamp}`, type: "legal_person", partyRole: "defendant", represented: false }],
  }),
});
const madeBody = await made.json();
ok("建案 201", made.status === 201, `${made.status} · ${madeBody?.internalCode}`);
ok(
  "内部编号形如 AJ-YYYYMMDD-NNN",
  /^AJ-\d{8}-\d{3,}$/.test(madeBody?.internalCode ?? ""),
  madeBody?.internalCode,
);
const madeDetail = await get(`/api/matters/${madeBody.id}`, l1.cookie);
const initial = (metaM.json?.statuses ?? []).find((s) => s.semantics === "open");
ok(
  `初始态 = 配置表里 semantics=open 的那行（${initial?.code}），不是代码里的字面量`,
  madeDetail.json?.status === initial?.code,
  `实际=${madeDetail.json?.status}`,
);

const noReason = await fetch(`${BASE}/api/matters/${madeBody.id}/status`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: l1.cookie },
  body: JSON.stringify({ to: "archived" }),
});
ok("归档不填原因 → 4xx", noReason.status >= 400 && noReason.status < 500, `status=${noReason.status}`);
const withReason = await fetch(`${BASE}/api/matters/${madeBody.id}/status`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: l1.cookie },
  body: JSON.stringify({ to: "archived", reason: "冒烟：验完就收" }),
});
ok("归档带原因 → 200", withReason.status === 200, `status=${withReason.status}`);
const afterArch = await get("/api/matters?page=1&pageSize=100", l1.cookie);
ok(
  "归档后从默认列表消失",
  !(afterArch.json?.items ?? []).some((i) => i.id === madeBody.id),
  `total=${afterArch.json?.total}`,
);
const inArch = await get("/api/matters?page=1&pageSize=100&archivedOnly=1", l1.cookie);
ok(
  "显式含归档时又看得见（这条记录没被删）",
  (inArch.json?.items ?? []).some((i) => i.id === madeBody.id),
);

/* ── 10. 事项 → 转案件（旗舰动作） ───────────────────────────── */
const risk = await fetch(`${BASE}/api/risk-matters`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: l1.cookie },
  body: JSON.stringify({
    name: `冒烟风险 ${stamp}`,
    type: "compliance",
    level: "mid",
    description: "冒烟脚本建的验证条目",
    // 带上当事人，否则转案件必 422（`parties_required`）——那是**正确**行为。
    // T10 之前没有任何入口能给事项挂当事人，所以这一段过去必然红。
    parties: [
      { partyId: '', name: `冒烟公司 ${stamp}`, type: 'legal_person', partyRole: 'defendant' },
    ],
  }),
});
const riskBody = await risk.json();
ok("建事项 201", risk.status === 201, `${risk.status} · ${riskBody?.code}`);
// 转案件：**先给事项挂当事人**（T10 之前这里没有入口，于是必然 422）。
// `parties` 走建事项时带入，与新增的 `riskCreateSchema.parties` 同一道门。
const conv = await fetch(`${BASE}/api/risk-matters/${riskBody.id}/convert`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: l1.cookie },
  body: JSON.stringify({
    cases: [
      {
        name: `冒烟转案件 ${stamp}`,
        cause: "合同纠纷",
        caseType: "civil_commercial",
        procedure: "first_instance",
        litigationRole: "defendant",
        level: "mid",
      },
    ],
  }),
});
const convBody = await conv.json();
const convCase = convBody?.cases?.[0];
ok(
  "转案件 200/201",
  conv.status < 300 && Boolean(convCase?.internalCode),
  `${conv.status} · ${convCase?.internalCode}`,
);
const riskList = await get("/api/risk-matters?page=1&pageSize=100", l1.cookie);
const mine = (riskList.json?.items ?? []).find((i) => i.id === riskBody.id);
ok(
  "事项侧标成已转且计数=1",
  mine?.conversionStatus === 1 && mine?.convertedCaseCount === 1,
  `status=${mine?.conversionStatus} count=${mine?.convertedCaseCount}`,
);
// 列表上要看得见挂了几个当事人 —— 0 个时转案件必被 422 挡下
ok("事项列表带 partyCount（0 个当事人一眼可见）", mine?.partyCount === 1, `partyCount=${mine?.partyCount}`);
ok(
  "金额不继承（P0-1）：新案件标的额为 0",
  (await get(`/api/matters/${convCase?.id}`, l1.cookie)).json?.amount === "0.00",
);

/* ── 11. 页面壳里不许有业务行（禁令⑥） ───────────────────────── */
for (const p of ["/matters", "/risk-matters", "/config"]) {
  const r = await get(p);
  const leaked = /AJ-\d{8}-\d{3}|FX-\d{8}-\d{3}/.test(r.text);
  ok(`壳 ${p} 不含业务编号`, !leaked, leaked ? "SSR 里出现了真实编号" : "干净");
  ok(`壳 ${p} 有骨架（菜单/标题在）`, /MatterNest|风险事项|案件|配置/.test(r.text));
}
/* 登录页：演示账号提示块由 `NODE_ENV !== "production"` 门控。
 * 生产构建里 **必须看不到**它（`process.env.NODE_ENV` 在构建期被内联成 "production"，
 * 整块是死代码被摇掉）——所以这条断言反着写：验的是"生产不泄露口令=账号"这件事。
 * 想看提示块请用 `pnpm dev`。
 *
 * ⚠ 这条**只在生产构建下成立**。跑 `pnpm dev` 时该块按设计会显示，断言必然红——
 * 那是环境不对，不是代码坏了。所以这里用 `SMOKE_PROD=1` 显式声明"我在验生产"，
 * 没声明就报 skip 而不是报红：把环境不匹配的断言记成失败，等于让门禁学会撒谎。 */
const loginHtml = await get("/login");
const onProd = process.env.SMOKE_PROD === "1";
if (onProd) {
  ok("生产构建的登录页不含演示账号清单", !loginHtml.text.includes("wangkf"));
} else {
  console.log(`[skip] 生产构建的登录页不含演示账号清单 —— 当前是 dev 构建（设 SMOKE_PROD=1 后生效）`);
}
ok("登录页不在 <html> 里漏 session cookie", !/mn_session=[A-Za-z0-9._-]/.test(loginHtml.text));
ok("登录页有表单骨架（账号/口令两个控件在 SSR 里就出现）", /账号|口令/.test(loginHtml.text));

console.log(`\n冒烟：${pass} 通过 / ${fail} 失败`);

/* ── 12. 清场：删掉本轮造的两条宿主及其从属 ──────────────────── */
if (process.env.SMOKE_KEEP !== "1") {
  const { default: postgres } = await import("postgres");
  const sql = postgres({
    host: process.env.PGHOST ?? "127.0.0.1",
    port: Number(process.env.PGPORT ?? 30432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    max: 1,
  });
  // **按名字找**而不是按本轮拿到的 id 删：前面几轮崩在中途时留下的冒烟行也要一起清掉，
  // 否则 dev 库里会攒出一堆"归档的冒烟案件"，下个人以为是正经数据。
  const foundM = await sql`select id::text as id from mn_matter where name like ${`冒烟%`}`;
  const foundR = await sql`select id::text as id from mn_risk_matter where name like ${`冒烟%`}`;
  const hosts = [...foundM, ...foundR].map((r) => r.id);
  if (hosts.length === 0) console.log("[clean] 库里没有冒烟遗留行，无需清场");
  // 删除顺序按 FK RESTRICT 来：日志/评论/关联先走，宿主最后。
  // 列名一律 `matter_id` / `risk_matter_id`：`hostId` 只是 Drizzle 侧的属性名，
  // 同构表对在建表时各自落成不同的真实列名（`schema/hosts.ts` 的 staffTable/partyLinkTable）。
  await sql`delete from mn_activity_log where matter_id = any(${hosts}::bigint[]) or risk_matter_id = any(${hosts}::bigint[])`;
  await sql`delete from mn_comment where target_id = any(${hosts}::bigint[])`;
  await sql`delete from mn_risk_matter_case where risk_matter_id = any(${hosts}::bigint[]) or matter_id = any(${hosts}::bigint[])`;
  await sql`delete from mn_matter_progress where matter_id = any(${hosts}::bigint[])`;
  await sql`delete from mn_matter_node where matter_id = any(${hosts}::bigint[])`;
  await sql`delete from mn_risk_matter_node where risk_matter_id = any(${hosts}::bigint[])`;
  await sql`delete from mn_matter_staff where matter_id = any(${hosts}::bigint[])`;
  await sql`delete from mn_risk_matter_staff where risk_matter_id = any(${hosts}::bigint[])`;
  await sql`delete from mn_matter_party where matter_id = any(${hosts}::bigint[])`;
  await sql`delete from mn_risk_matter_party where risk_matter_id = any(${hosts}::bigint[])`;
  const left = await sql`delete from mn_matter where id = any(${hosts}::bigint[]) returning id`;
  const leftRisk = await sql`delete from mn_risk_matter where id = any(${hosts}::bigint[]) returning id`;
  await sql`delete from mn_party where name like ${`冒烟公司 ${stamp}%`}`;
  const rest = await sql`select count(*)::int as n from mn_activity_log where target_id = any(${hosts}::bigint[])`;
  await sql.end();
  console.log(
    `[clean] 删案件 ${left.length} · 删事项 ${leftRisk.length} · 残留日志 ${rest[0].n}`,
  );
  ok("清场后不留残余活动记录", rest[0].n === 0, `n=${rest[0].n}`);
}

// ⚠ 临时账号的清场必须在**宿主清场之后、进程退出之前**。
// 上面那段清场自己建了 `sql` 客户端并已 `end()`，所以这里用 `dropAccts` 里那条连接。
// 少了这一步就每次往库里留四个孤儿账号（两个还是 is_admin=true）——
// 本轮实测：定义了 dropAccts 却忘了调用，跑一轮就漏四个。
if (process.env.SMOKE_KEEP !== "1") await dropAccts();

process.exit(fail ? 1 : 0);
