/**
 * MATT-44 ①：在 `guards.canImport` 被注入「`dataScope === "all"` 恒 false」的**同一次**代码状态下，
 * 证明「L1 正路」与「`is_admin` 逃生口」确实是**两条分支** —— 于是旧夹具
 * （`full_admin` + `isAdmin: true`）永远走不到被变异的那一支。
 *
 * 四条断言（HTTP，与冒烟同一入口）：
 *   1. 非 admin 的 L1（角色给的 dataScope=all）→ **403**（这是被变异的那一支，说明夹具真在验它）
 *   2. is_admin=true 但数据范围不是 L1 → **200**（逃生口，不受变异影响）
 *   3. 非 admin 的 L2（joined_operator）→ 403（拒绝方向，恒定）
 *   4. **旧夹具原样**（`full_admin` + `isAdmin: true`）→ 变异态下**照样 200**
 *      ⇒ 这就是改造前「把那一支改成恒 false，96 条仍全绿」的机制本身
 *
 * 跑法（配合 L1 变异注入，注入工具见 `agent-work/chk44-l1hole.mjs`）：
 *   node agent-work/chk44-l1hole.mjs inject
 *   node --env-file=.env agent-work/probe-l1branch.mjs   # ⇒ ①②③④ 应为 403 / 200 / 403 / 200
 *   node agent-work/chk44-l1hole.mjs restore
 *   node --env-file=.env agent-work/probe-l1branch.mjs   # ⇒ ① 翻回 200（探针能分辨两种状态，不是橡皮图章）
 *
 * ⚠ ① 那一条**只在注入态才成立**：干净代码上它必然 FAIL（非 admin 的 L1 本来就该 200）。
 *   所以这个探针是"变异态下的一次性取证"，不是常驻门禁 —— 别把它接进 CI。
 */
import { createSmokeAccount, dropSmokeAccount, ROLE_CODES } from "./_testacct.mjs";

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";
const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

async function login(username, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
}
const probe = (cookie) => fetch(`${BASE}/api/import/templates?hostType=party`, { headers: { cookie } });

let fail = 0;
const accounts = [];
try {
  accounts.push(await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin] }));
  accounts.push(await createSmokeAccount(sql, { roles: [ROLE_CODES.self], isAdmin: true }));
  accounts.push(await createSmokeAccount(sql, { roles: [ROLE_CODES.joined] }));
  /** ④ = **旧夹具的原样**（`full_admin` + `isAdmin: true`）：改造前冒烟用的就是它 */
  accounts.push(await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true }));

  const [l1, escapee, l2, oldFixture] = [
    await probe(await login(accounts[0].username, accounts[0].password)),
    await probe(await login(accounts[1].username, accounts[1].password)),
    await probe(await login(accounts[2].username, accounts[2].password)),
    await probe(await login(accounts[3].username, accounts[3].password)),
  ];
  const rows = [
    ["① 非 admin 的 L1（角色 dataScope=all）—— 被变异的那一支", l1.status, 403],
    ["② is_admin=true + 数据范围非 L1 —— 逃生口（变异够不着）", escapee.status, 200],
    ["③ 非 admin 的 L2（joined_operator）—— 拒绝方向", l2.status, 403],
    ["④ **旧夹具**（full_admin + isAdmin=true）—— 变异态下照样 200 ⇒ 以前 96 全绿的原因", oldFixture.status, 200],
  ];
  for (const [name, got, want] of rows) {
    const okk = got === want;
    if (!okk) fail++;
    console.log(`[${okk ? " ok " : "FAIL"}] ${name} — status=${got}（期望 ${want}）`);
  }
} finally {
  for (const a of accounts) await dropSmokeAccount(sql, a.id).catch((e) => console.error(e.message));
  console.log(`残留账号：${accounts.length ? "已逐个清场" : "无"}`);
  await sql.end({ timeout: 5 });
}
console.log(fail === 0 ? `${rows.length} 条断言全部符合预期` : `${fail} 条断言不符`);
