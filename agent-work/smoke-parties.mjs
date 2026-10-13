import { createSmokeAccount, dropSmokeAccount, ROLE_CODES } from "./_testacct.mjs";

/**
 * 对手方档案（MATT-40）的**真 HTTP 冒烟**：加密存储 / 盲索引查重 / 独立档案页 / 合并 / 防呆 / 导出两档。
 *
 * ## 跑法
 *
 *   node --env-file=.env agent-work/smoke-parties.mjs        # dev server 在 3777（SMOKE_BASE 可覆盖）
 *
 * 前置（缺任何一个都会带着人话退出，不静默跳过）：
 *   · `MN_AES_KEY` / `MN_HMAC_KEY` —— 字段加密的两把钥匙（生成命令见 `field-crypto.ts` 头注）；
 *   · `MN_OWN_COMPANY_NAMES` —— 本企业名，防呆要知道本企业叫什么（IQ-7）。
 *
 * ## 先反向红一次（本仓纪律：没有反向红的冒烟等于没有冒烟）
 *
 *   node agent-work/revred-parties.mjs          # 往 insertNewParties 注入"明文落库"
 *   node --env-file=.env agent-work/smoke-parties.mjs   # ⇒ 必须红（断言②）
 *   git checkout src/app/lib/server/services/parties.ts # 或按脚本打印的路径还原备份
 *   node --env-file=.env agent-work/smoke-parties.mjs   # ⇒ 必须绿
 *
 * ## 断言清单（票面逐条）
 *
 *   ① 建案挂当事人 → 201，且库里 `id_number` 是 `v1:` 密文、`id_number_hash` 是 64 位 hex；
 *   ② **反向红的目标**：明文没有落库（`id_number !== 明文`，且前缀是信封）；
 *   ③ 检索下拉仍能给"尾四位"（读路径解密后才取尾四位）；
 *   ④ 档案详情是**明文**（IQ-12 展示层全明文；"没有显示明文按钮"由
 *      `parties.spec.ts` 的源码守卫盯着，HTTP 这一层只能证明"接口直接给明文"）；
 *   ⑤ 同证件号第二次建案 → **复用同一行**，不新建（查重 hash 不变）；
 *   ⑥ 同名不同证件号 → 新建一行 + 回 `nameConflicts`（**只生成同名时新建而非自动合并**）；
 *   ⑦ 输入本企业名 → 400，且库里没有多出那一行（防呆：提示而非建档）；
 *   ⑧ 合并：关联改挂主记录 + 被并方软删（`merged_into_id` 指主记录）+ `PARTY_MERGED` 审计
 *      （载荷记 surviving/merged id）；同一案卷上的重复关联被丢掉并计数（`dropped`）；
 *   ⑨ 被并方在接口上给 404（软删语义与 F3-7 一致）；
 *   ⑩ 导出两档：脱敏档人人可导（证件号只留尾四位）、明文档要 `can_read_plain`（否则 403），
 *      两档都记 `EXPORT`（载荷 `plain` 布尔 + 行数）；
 *   ⑪ 数据范围：看不见这条档案的人拿 404（§7.2 的谓词是"我对它关联的宿主可见"）。
 *
 * 清场：本脚本自己建的案件/事项/档案/活动日志全删（含案件预设节点），再删临时账号
 * （`dropSmokeAccount` 会拒绝代删业务行 —— 所以夹具必须自己清干净）。
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

const ownNames = (process.env.MN_OWN_COMPANY_NAMES ?? "")
  .split(/[,，]/)
  .map((s) => s.trim())
  .filter(Boolean);
if (!process.env.MN_AES_KEY || !process.env.MN_HMAC_KEY) {
  console.error(
    "缺 MN_AES_KEY / MN_HMAC_KEY：字段加密的密钥不许有默认值（见 src/app/lib/server/crypto/field-crypto.ts）。\n" +
      '生成：node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
  );
  process.exit(2);
}
if (ownNames.length === 0) {
  console.error(
    "缺 MN_OWN_COMPANY_NAMES：本企业名防呆（IQ-7）要知道本企业叫什么，猜不出来。\n" +
      "在 .env 里写：MN_OWN_COMPANY_NAMES=某某集团有限公司（多个别名用逗号分隔）",
  );
  process.exit(2);
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

const smoke = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
/** L2 且**没有** `can_read_plain`（joined_operator）：用来撞明文导出的那道 403 */
const smoke2 = await createSmokeAccount(sql, { roles: [ROLE_CODES.joined] });
const matterIds = [];
const partyIds = [];

/** 当事人夹具：名字带 stamp，证件号唯一（18 位，形状像统一社会信用代码） */
const A = {
  name: `冒烟对手方甲${stamp}`,
  idNumber: `91320100MA1X9${String(stamp).slice(-5)}A`,
  plainContact: "13800001234",
};
const B = { name: `冒烟对手方乙${stamp}`, idNumber: `91320100MA1X9${String(stamp).slice(-5)}B` };
const C = { name: `冒烟对手方丙${stamp}`, idNumber: `91320100MA1X9${String(stamp).slice(-5)}C` };

function matterBody(parties, tag) {
  return {
    name: `冒烟案件-${tag}-${stamp}`,
    cause: "买卖合同纠纷",
    caseType: "civil_commercial",
    procedure: "first_instance",
    litigationRole: "plaintiff",
    level: "mid",
    parties,
  };
}
const partyRow = (p, role = "defendant") => ({
  name: p.name,
  type: "legal_person",
  partyRole: role,
  idType: "unified_social_credit",
  idNumber: p.idNumber,
});

async function cleanup() {
  const mids = matterIds.map(BigInt);
  const pids = partyIds.map(BigInt);
  if (mids.length) {
    await sql`delete from mn_activity_log where matter_id = any(${sql.array(mids)}::bigint[])`;
    await sql`delete from mn_matter_party where matter_id = any(${sql.array(mids)}::bigint[])`;
    await sql`delete from mn_matter_node where matter_id = any(${sql.array(mids)}::bigint[])`;
    await sql`delete from mn_matter_staff where matter_id = any(${sql.array(mids)}::bigint[])`;
    await sql`delete from mn_matter where id = any(${sql.array(mids)}::bigint[])`;
  }
  if (pids.length) {
    await sql`delete from mn_activity_log where target_id = any(${sql.array(pids)}::bigint[])`;
    await sql`delete from mn_matter_party where party_id = any(${sql.array(pids)}::bigint[])`;
    await sql`delete from mn_party where id = any(${sql.array(pids)}::bigint[])`;
  }
}

try {
  const l1 = await login(smoke.username, smoke.password);
  ok("L1 登录（full_admin + is_admin + can_read_plain）", l1.status === 200, `status=${l1.status}`);
  const cookie = l1.cookie;
  const l2 = await login(smoke2.username, smoke2.password);
  ok("L2 登录（joined_operator，无 can_read_plain）", l2.status === 200, `status=${l2.status}`);

  // ── ① 建案挂当事人（快速新增）──
  const m1 = await call("POST", "/api/matters", cookie, matterBody([partyRow(A)], "甲"));
  ok("建案 + 快速新增当事人 → 201", m1.status === 201, `status=${m1.status}`);
  matterIds.push(m1.body?.id);
  const [rowA] = await sql`select id, id_number, id_number_hash from mn_party where name = ${A.name}`;
  ok("当事人行落库", Boolean(rowA), `id=${rowA?.id}`);
  partyIds.push(String(rowA.id));

  // ── ② 加密存储（反向红的目标）──
  ok(
    "**证件号是密文**（`v1:` 信封，且不等于明文）",
    typeof rowA.id_number === "string" &&
      rowA.id_number.startsWith("v1:") &&
      rowA.id_number !== A.idNumber,
    `id_number=${String(rowA.id_number).slice(0, 12)}…`,
  );
  ok(
    "**盲索引落库**（HMAC-SHA256 hex 64 位，查重靠它）",
    /^[0-9a-f]{64}$/.test(rowA.id_number_hash ?? ""),
    `hash=${String(rowA.id_number_hash).slice(0, 12)}…`,
  );

  // ── ③ 检索下拉：读路径解密后只给尾四位 ──
  const search = await call("GET", `/api/parties?q=${encodeURIComponent(A.name)}`, cookie);
  ok(
    "检索下拉 → 尾四位（解密后取尾串）",
    search.status === 200 && search.body?.items?.[0]?.idNumberTail === A.idNumber.slice(-4),
    `tail=${search.body?.items?.[0]?.idNumberTail}`,
  );
  ok(
    "输入的不是本企业名 → ownCompany=false（防呆不误报）",
    search.body?.ownCompany === false,
    `ownCompany=${search.body?.ownCompany}`,
  );

  // ── ④ 档案详情：展示层全明文 ──
  const detail = await call("GET", `/api/parties/${rowA.id}`, cookie);
  ok(
    "**档案详情是明文**（IQ-12：展示层全明文，无「显示明文」按钮）",
    detail.status === 200 && detail.body?.idNumber === A.idNumber,
    `status=${detail.status} idNumber=${String(detail.body?.idNumber).slice(0, 12)}`,
  );
  ok(
    "详情列出卷入的案件与地位（对方 + 我方两列）",
    detail.body?.matters?.length === 1 &&
      detail.body.matters[0].partyRole === "defendant" &&
      detail.body.matters[0].ourLitigationRole === "plaintiff",
    `n=${detail.body?.matters?.length}`,
  );

  // ── ⑤ 同证件号 → 复用同一行（查重 hash 不变）──
  const m2 = await call(
    "POST",
    "/api/matters",
    cookie,
    matterBody([partyRow({ ...A, name: `冒烟对手方甲别名${stamp}` })], "甲2"),
  );
  ok("同证件号再建案 → 201（自动复用既有档案）", m2.status === 201, `status=${m2.status}`);
  matterIds.push(m2.body?.id);
  const [dupCount] = await sql`select count(*)::int as n from mn_party where name = ${`冒烟对手方甲别名${stamp}`}`;
  ok("**没有为同证件号新建第二行**", dupCount.n === 0, `n=${dupCount.n}`);
  const links = await sql`select distinct party_id from mn_matter_party where matter_id = any(${sql.array([BigInt(m1.body.id), BigInt(m2.body.id)])}::bigint[])`;
  ok("两个案件挂在同一份档案上", links.length === 1, `distinct party=${links.length}`);

  // ── ⑥ 同名不同证件号 → 新建 + 提示（绝不自动合并）──
  const m3 = await call("POST", "/api/matters", cookie, matterBody([partyRow(B)], "乙"));
  matterIds.push(m3.body?.id);
  const [rowB] = await sql`select id from mn_party where name = ${B.name}`;
  partyIds.push(String(rowB.id));
  const m4 = await call(
    "POST",
    "/api/matters",
    cookie,
    matterBody([partyRow({ ...B, idNumber: `${B.idNumber}Z` })], "乙2"),
  );
  matterIds.push(m4.body?.id);
  const [sameNameCount] = await sql`select count(*)::int as n from mn_party where name = ${B.name}`;
  ok(
    "**同名不同证件号 → 新建一行 + 回 nameConflicts**（只生成同名时新建，不自动合并）",
    m4.status === 201 &&
      Array.isArray(m4.body?.nameConflicts) &&
      m4.body.nameConflicts.length >= 1 &&
      sameNameCount.n === 2,
    `status=${m4.status} conflicts=${m4.body?.nameConflicts?.length} rows=${sameNameCount.n}`,
  );

  // ── ⑦ 本企业名防呆：提示而非建档 ──
  const [ownBefore] = await sql`select count(*)::int as n from mn_party where name = ${ownNames[0]}`;
  const ownMatter = await call(
    "POST",
    "/api/matters",
    cookie,
    matterBody([partyRow({ name: ownNames[0], idNumber: `91320100MA1X9${String(stamp).slice(-5)}O` })], "本企业"),
  );
  const [ownAfter] = await sql`select count(*)::int as n from mn_party where name = ${ownNames[0]}`;
  ok(
    "**输入本企业名 → 400 且没有建档**（IQ-7 的闸门）",
    ownMatter.status === 400 && ownAfter.n === ownBefore.n,
    `status=${ownMatter.status} before=${ownBefore.n} after=${ownAfter.n}`,
  );
  ok(
    "防呆的文案点名了本企业与下一步",
    typeof ownMatter.body?.message === "string" && ownMatter.body.message.includes(ownNames[0]),
    `${String(ownMatter.body?.message).slice(0, 40)}…`,
  );
  const ownCreate = await call("POST", "/api/parties", cookie, {
    name: ownNames[0],
    type: "legal_person",
  });
  ok(
    "**独立建档入口同样拒**（防呆不是只挡建案那一条路）",
    ownCreate.status === 422 && ownCreate.body?.error === "own_company",
    `status=${ownCreate.status} err=${ownCreate.body?.error}`,
  );

  // ── 独立建档（F3-2）：手机号也加密 ──
  const c1 = await call("POST", "/api/parties", cookie, {
    name: C.name,
    type: "legal_person",
    idType: "unified_social_credit",
    idNumber: C.idNumber,
    contact: A.plainContact,
    remark: "冒烟：手机号加密 + 合并",
  });
  ok("独立建档 → 201", c1.status === 201, `status=${c1.status}`);
  partyIds.push(String(c1.body?.id));
  const [rowC] = await sql`select id_number, contact from mn_party where id = ${String(c1.body.id)}`;
  ok(
    "**手机号同样加密存储**",
    typeof rowC.contact === "string" &&
      rowC.contact.startsWith("v1:") &&
      rowC.contact !== A.plainContact,
    `contact=${String(rowC.contact).slice(0, 12)}…`,
  );
  const cDetail = await call("GET", `/api/parties/${c1.body.id}`, cookie);
  ok("手机号在详情页是明文", cDetail.body?.contact === A.plainContact, `${cDetail.body?.contact}`);

  // 同证件号再建一次 → 409（冲突语义 = "你要建的东西已经在了"）
  const cDup = await call("POST", "/api/parties", cookie, {
    name: `${C.name}再来一份`,
    type: "legal_person",
    idNumber: C.idNumber,
  });
  ok(
    "同证件号独立建档 → 409 并回既有那条的 id",
    cDup.status === 409 && cDup.body?.partyId === String(c1.body.id),
    `status=${cDup.status} partyId=${cDup.body?.partyId}`,
  );

  // ── ⑧ 合并：把 C 并进 A ──
  // 先造两种关联各一条，把合并的两条路都覆盖到：
  //   · m6 只挂 C            → 合并后**改挂**到 A（moved）
  //   · m5 同时挂 A 与 C     → 合并后撞 uk_mn_matter_party，**丢掉** C 那一行（dropped）
  const m5 = await call(
    "POST",
    "/api/matters",
    cookie,
    matterBody([partyRow(A), partyRow(C, "third_party")], "甲丙同案"),
  );
  matterIds.push(m5.body?.id);
  ok("同一案卷上同时挂 A 与 C → 201", m5.status === 201, `status=${m5.status}`);
  const m6 = await call("POST", "/api/matters", cookie, matterBody([partyRow(C, "third_party")], "只挂丙"));
  matterIds.push(m6.body?.id);
  ok("只挂 C 的案卷 → 201", m6.status === 201, `status=${m6.status}`);

  const merge = await call("POST", `/api/parties/${rowA.id}/merge`, cookie, {
    mergedIds: [String(c1.body.id)],
    reason: "冒烟：同一家登记了两次",
  });
  ok("合并 → 200", merge.status === 200, `status=${merge.status}`);
  ok(
    "合并回执：改挂 1 条（只挂丙那件）+ 丢掉 1 条重复关联（甲丙同案）",
    merge.body?.moved === 1 && merge.body?.dropped === 1,
    `moved=${merge.body?.moved} dropped=${merge.body?.dropped}`,
  );

  const [rowCAfter] = await sql`select is_deleted, merged_into_id, merged_at from mn_party where id = ${String(c1.body.id)}`;
  ok(
    "**被并方软删 + 指出主记录**（is_deleted + merged_into_id + merged_at）",
    rowCAfter.is_deleted === true &&
      String(rowCAfter.merged_into_id) === String(rowA.id) &&
      rowCAfter.merged_at !== null,
    `is_deleted=${rowCAfter.is_deleted} into=${rowCAfter.merged_into_id}`,
  );
  const [cLinks] = await sql`select count(*)::int as n from mn_matter_party where party_id = ${String(c1.body.id)}`;
  ok("被并方的关联已全部改挂（自己名下 0 条）", cLinks.n === 0, `n=${cLinks.n}`);
  const [aOnM5] = await sql`select count(*)::int as n from mn_matter_party where party_id = ${String(rowA.id)} and matter_id = ${m5.body.id}`;
  ok("同一案卷上只剩主记录那一行（重复关联被丢掉）", aOnM5.n === 1, `n=${aOnM5.n}`);

  const logs = await sql`select target_type, matter_id, payload from mn_activity_log where action = 'PARTY_MERGED' order by created_at`;
  const hostLogs = logs.filter((l) => l.target_type === "matter");
  const summaryLog = logs.find((l) => l.target_type === "app_user");
  ok(
    "**全程写 PARTY_MERGED**：受影响案卷各一条 + 操作者汇总一条",
    hostLogs.length >= 2 && Boolean(summaryLog),
    `host=${hostLogs.length} summary=${summaryLog ? 1 : 0}`,
  );
  ok(
    "载荷记 surviving / merged id",
    summaryLog?.payload?.surviving_party_id === String(rowA.id) &&
      Array.isArray(summaryLog?.payload?.merged_party_ids) &&
      summaryLog.payload.merged_party_ids.includes(String(c1.body.id)),
    JSON.stringify(summaryLog?.payload ?? {}).slice(0, 90),
  );

  // ── ⑨ 被并方在接口上 404（软删语义与 F3-7 一致）──
  const mergedDetail = await call("GET", `/api/parties/${c1.body.id}`, cookie);
  ok("被并方详情 → 404（软删行没有页面）", mergedDetail.status === 404, `status=${mergedDetail.status}`);
  const mergedAgain = await call("POST", `/api/parties/${rowA.id}/merge`, cookie, {
    mergedIds: [String(c1.body.id)],
  });
  ok("再并一次已被并走的档案 → 404（不重复改挂）", mergedAgain.status === 404, `status=${mergedAgain.status}`);

  // 形状错误：空选择 400（与"看不见/不存在"的 404 分工）
  const emptyMerge = await call("POST", `/api/parties/${rowA.id}/merge`, cookie, { mergedIds: [] });
  ok("空 mergedIds → 400（形状错误，不是权限问题）", emptyMerge.status === 400, `status=${emptyMerge.status}`);
  const ghostMerge = await call("POST", `/api/parties/${rowA.id}/merge`, cookie, {
    mergedIds: ["999999999"],
  });
  ok("并一条不存在的档案 → 404", ghostMerge.status === 404, `status=${ghostMerge.status}`);

  // ── ⑩ 导出两档 ──
  const masked = await call("GET", "/api/parties?export=1", cookie);
  ok(
    "脱敏档：200 且证件号只留尾四位",
    masked.status === 200 &&
      masked.body?.plain === false &&
      masked.body.csv.includes(`****${A.idNumber.slice(-4)}`) &&
      !masked.body.csv.includes(A.idNumber),
    `status=${masked.status} count=${masked.body?.count}`,
  );
  const plainDenied = await call("GET", "/api/parties?export=1&plain=1", l2.cookie);
  ok(
    "**明文档没有 can_read_plain → 403**",
    plainDenied.status === 403 && plainDenied.body?.error === "privilege_required",
    `status=${plainDenied.status} err=${plainDenied.body?.error}`,
  );
  const plain = await call("GET", "/api/parties?export=1&plain=1", cookie);
  ok(
    "明文档（有权限）→ 200 且含完整证件号",
    plain.status === 200 && plain.body?.plain === true && plain.body.csv.includes(A.idNumber),
    `status=${plain.status} count=${plain.body?.count}`,
  );
  const exports = await sql`select payload from mn_activity_log where action = 'EXPORT' order by created_at`;
  const maskedLog = exports.find((e) => e.payload?.plain === false);
  const plainLog = exports.find((e) => e.payload?.plain === true);
  ok(
    "**两档都记 EXPORT**（载荷 plain 布尔 + 行数）",
    Boolean(maskedLog) && Boolean(plainLog) && typeof plainLog.payload.rows === "number",
    `masked=${maskedLog ? 1 : 0} plain=${plainLog ? 1 : 0} rows=${plainLog?.payload?.rows}`,
  );

  // ── ⑪ 数据范围：看不见的人拿 404 ──
  const invisible = await call("GET", `/api/parties/${rowA.id}`, l2.cookie);
  ok(
    "**没参与的账号看档案详情 → 404**（§7.2 谓词 = 我对它关联的宿主可见）",
    invisible.status === 404,
    `status=${invisible.status}`,
  );
  const listForL2 = await call("GET", "/api/parties?page=1&pageSize=20", l2.cookie);
  ok(
    "L2 的档案列表里也没有它",
    listForL2.status === 200 && !listForL2.body.items.some((x) => x.id === String(rowA.id)),
    `n=${listForL2.body?.items?.length}`,
  );
  const listForL1 = await call("GET", `/api/parties?keyword=${encodeURIComponent(A.name)}`, cookie);
  ok(
    "L1 用**完整证件号**也能搜到（盲索引的正当用法）",
    (
      await call("GET", `/api/parties?keyword=${encodeURIComponent(A.idNumber)}`, cookie)
    ).body?.items?.some((x) => x.id === String(rowA.id)) === true,
    `byName=${listForL1.body?.items?.length}`,
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
  await dropSmokeAccount(sql, smoke.id).catch((e) => console.log("drop smoke:", e.message));
  await dropSmokeAccount(sql, smoke2.id).catch((e) => console.log("drop smoke2:", e.message));
  await sql.end();
}

console.log(`\n${fail ? "FAIL" : "PASS"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
