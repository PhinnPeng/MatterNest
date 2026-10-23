import {
  createSmokeAccount,
  dropSmokeAccount,
  finishSmoke,
  noteCleanupFailure,
  ROLE_CODES,
} from "./_testacct.mjs";
/**
 * 富文本描述（MATT-57 / ADR-0002）的真 HTTP 冒烟。
 *
 * 断言两类东西：
 *  ① **markdown 往返**：写入的 markdown 原样存、原样读回（列表/标题/换行不丢），
 *     且列表的 ILIKE 搜索对 markdown 正文仍然命中（存储选 markdown 的全部理由）。
 *  ② **审计不落正文**（ADR-0002 的硬约束）：改描述写 RISK_UPDATED，但
 *     `field_diffs` 里**没有**描述的任何值，`payload.bodyFields` 只记"改了哪些字段"。
 *     审计表不能变成明文书的存放处——这条是安全断言，反向红要能抓。
 *
 * 只走 HTTP：编辑器（BlockNote）在浏览器侧，本冒烟验的是它**存进去的东西**这条契约，
 * 不验编辑器交互（那是 N7/观感走查的边界）。
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

const stamp = Date.now();
const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

const acct = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
const lr = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: acct.username, password: acct.password }),
});
const cookie = (lr.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
const riskIds = [];

async function cleanup() {
  const rids = riskIds.map(BigInt);
  if (rids.length) {
    await sql`delete from mn_activity_log where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
    await sql`delete from mn_risk_matter_staff where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
    await sql`delete from mn_risk_matter where id = any(${sql.array(rids)}::bigint[])`;
  }
}

// 一段有结构的 markdown：标题 + 列表 + 加粗 + 段内换行
const MD = `### 违约经过\n\n供应商**连续三次**延迟交付：\n\n- 第一批晚 12 天\n- 第二批晚 20 天\n\n已发函催告，等待书面回复。`;

try {
  // ① markdown 往返
  const created = await call("POST", "/api/risk-matters", cookie, {
    name: `富文本冒烟 ${stamp}`,
    type: "contract",
    level: "high",
    description: MD,
  });
  ok("建事项（markdown 描述）→ 201", created.status === 201, `status=${created.status}`);
  const riskId = created.body?.id;
  riskIds.push(riskId);

  const detail = await call("GET", `/api/risk-matters/${riskId}`, cookie);
  ok("详情 → 200", detail.status === 200, `status=${detail.status}`);
  ok(
    "**markdown 原样存回**（标题/列表/加粗/换行不丢）",
    detail.body?.description === MD,
    `存回长度=${detail.body?.description?.length} 期望=${MD.length}`,
  );

  // markdown 以**纯文本**存储 → 直接对 description 列 ILIKE 就能命中，
  // 不需要为搜索另加纯文本投影列（这正是 ADR 选 markdown 而非 JSON 的理由）。
  // ⚠ 注意：事项的关键词筛选器（keywordFilter）当前只搜 name/code，**不含 description**
  //   ——「已采取措施」那一段已随迁移 0017 从筛选面撤下；描述不进关键词是既有产品口径，本票没扩它。这里验的是"存储格式可被 ILIKE 直接命中"这条契约，
  //   不是"描述进不进关键词筛选"。
  const [ilikeHit] = await sql`
    select count(*)::int as n from mn_risk_matter
    where id=${riskId} and lower(description) like lower(${"%连续三次%"})`;
  ok(
    "**markdown 正文可被 ILIKE 直接命中**（无需投影列，ADR 选 markdown 的理由）",
    ilikeHit.n === 1,
    `n=${ilikeHit.n}`,
  );

  // ② 审计不落正文
  const NEW_MD = `### 更新后的经过\n\n对方已书面承认违约，进入赔偿谈判。`;
  const patched = await call("PATCH", `/api/risk-matters/${riskId}`, cookie, {
    description: NEW_MD,
  });
  ok("改描述 → 200", patched.status === 200, `status=${patched.status}`);
  const d2 = await call("GET", `/api/risk-matters/${riskId}`, cookie);
  ok("描述已更新为新 markdown", d2.body?.description === NEW_MD, "");

  const [audit] = await sql`
    select field_diffs::text as diffs, payload::text as payload
    from mn_activity_log
    where action='RISK_UPDATED' and risk_matter_id=${riskId}
    order by created_at desc limit 1`;
  ok("改了描述会写 RISK_UPDATED 审计", !!audit, "");
  const diffs = audit?.diffs ?? "";
  const payload = audit?.payload ?? "";
  // 正文值既不在 field_diffs，也不能以任何形式出现在审计里
  ok(
    "**审计 field_diffs 不含描述正文**（ADR-0002）",
    !diffs.includes("更新后的经过") && !diffs.includes("违约经过") && !diffs.includes("对方已书面"),
    `diffs=${diffs.slice(0, 80)}`,
  );
  ok(
    "**审计 payload 只记改了哪些字段**（bodyFields 含 description，不含值）",
    payload.includes("bodyFields") && payload.includes("description") && !payload.includes("经过"),
    `payload=${payload.slice(0, 80)}`,
  );

  // 反向对照：改 name（非正文字段）→ 值应正常进 field_diffs（证明"不落正文"是精准豁免，不是一律不落）
  const renamed = await call("PATCH", `/api/risk-matters/${riskId}`, cookie, {
    name: `富文本冒烟改名 ${stamp}`,
  });
  ok("改名 → 200", renamed.status === 200, `status=${renamed.status}`);
  const [nameAudit] = await sql`
    select field_diffs::text as diffs from mn_activity_log
    where action='RISK_UPDATED' and risk_matter_id=${riskId}
    order by created_at desc limit 1`;
  ok(
    "非正文字段（name）改动**仍进 field_diffs**（豁免精准，不扩大）",
    (nameAudit?.diffs ?? "").includes("name"),
    `diffs=${nameAudit?.diffs?.slice(0, 80)}`,
  );

  // 空白描述不该过 min2 校验（PATCH 口径：trim 后为空即拒，不存空正文）
  const blank = await call("PATCH", `/api/risk-matters/${riskId}`, cookie, {
    description: "   \n  ",
  });
  ok(
    "纯空白描述 → 400（trim 后为空，min2 拒掉，不存空正文）",
    blank.status === 400,
    `status=${blank.status}`,
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
  try {
    await dropSmokeAccount(sql, acct.id);
  } catch (e) {
    noteCleanupFailure(`临时账号 ${acct.username}（${acct.id}）`, e);
  }
  await sql.end();
}

console.log(`\n${fail ? "FAIL" : "PASS"}：${pass} 通过 / ${fail} 失败`);
finishSmoke(fail);
