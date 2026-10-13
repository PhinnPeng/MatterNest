/**
 * 独立验证 MATT-46 返工新增的那条口径：**随筛选联动**（PRD §4.7 第 6 条）。
 *
 * 为什么父代理要自己验一次：这条能力是**返工时新增**的（原实现只有自己的
 * `archivedOnly` 开关，与列表筛选无关），而它同时改了 `/api/reports` 的入参与两个列表页。
 * 新增能力最容易"看起来接上了、实际没生效"——所以这里不看代码，只发请求比数字。
 *
 * 判据（不依赖任何夹具的具体值，只依赖"筛选真的改变了集合"）：
 *   1. 不带筛选的 total 与带某个状态筛选的 total **必须不同**（否则筛选没生效）；
 *   2. 带筛选时，返回的每一行都必须是那个状态（否则是"数字变了但不是按这个筛的"）；
 *   3. 多传一个不认识的参数必须 **400**（schema 是 `.strict()`，静默丢掉最难查）。
 */
const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";
const { createSmokeAccount, dropSmokeAccount, ROLE_CODES } = await import("./_testacct.mjs");
const { default: postgres } = await import("postgres");

const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass += 1;
    console.log(`[ ok ] ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const account = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });

async function call(path, cookie) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

try {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: account.username, password: account.password }),
  });
  ok("夹具账号能登录", r.status === 200, `status=${r.status}`);
  const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

  // 先看库里有哪些状态值可用（不硬编码 code）
  // ⚠ `mn_status_config` **没有 `is_deleted` 列**（它有 is_enabled / is_archive_status /
  //   is_initial_status / semantics）——配置表不做软删，停用就是 is_enabled=false。
  //   我第一版照抄了业务表的习惯加 `not is_deleted`，直接 42703。
  const statuses = await sql`
    select code from mn_status_config
     where host_type = 'matter' and is_enabled
     order by sort_order`;
  const codes = statuses.map((s) => s.code);
  ok("拿到案件侧状态取值（配置驱动，不硬编码）", codes.length >= 2, `codes=${codes.join(",")}`);

  const all = await call("/api/reports", cookie);
  ok("不带筛选 → 200", all.status === 200, `status=${all.status}`);
  const allTotal = all.body?.matters?.total ?? all.body?.cards?.matters?.total;
  ok("不带筛选的 total 是数字", typeof allTotal === "number", `total=${allTotal}`);

  // ① 换一个状态筛选，total 必须变（除非那个状态恰好等于全集——所以试到第一个不同的为止）
  //
  // ⚠ 选的是**行数最多**的那个筛选，不是"第一个变了就算"。
  //   第一版就是"第一个变了就算"，结果命中的是 `archived`：默认视图不含归档 ⇒ total 5 → 0，
  //   于是下面那条"筛选后每一行都是那个状态"**在空集上平凡为真**——一条假绿。
  //   这与本轮抓到的其它几处同形：**断言通过了，但它没在检验任何东西**。
  let changed = null;
  for (const code of codes) {
    const one = await call(`/api/reports?status=${encodeURIComponent(code)}`, cookie);
    if (one.status !== 200) {
      ok(`status=${code} 的筛选请求 → 200`, false, `status=${one.status}`);
      continue;
    }
    const oneTotal = one.body?.matters?.total ?? one.body?.cards?.matters?.total;
    if (oneTotal === allTotal) continue;
    if (changed === null || oneTotal > changed.oneTotal) changed = { code, oneTotal, one };
  }
  ok(
    "**至少有一个状态筛选真的改变了集合**（联动生效，不是装饰）",
    changed !== null,
    changed ? `status=${changed.code} 时 total ${allTotal} → ${changed.oneTotal}` : "所有状态筛选后 total 都没变",
  );

  // ② 筛选后返回的每一行都必须是那个状态（防"数字变了但不是按这个筛的"）
  if (changed) {
    const rows = changed.one.body?.matters?.rows ?? changed.one.body?.cards?.matters?.rows ?? [];
    // 先要求非空，否则"每行都满足"是空过的
    ok(
      "**被选中的那个筛选确实有行**（否则下面那条会空过）",
      rows.length > 0,
      `status=${changed.code} rows=${rows.length}`,
    );
    ok(
      "**筛选后每一行都是那个状态**（不是「数字变了但行没筛」）",
      rows.length > 0 && rows.every((x) => x.status === changed.code),
      `rows=${rows.length} 状态集=${[...new Set(rows.map((x) => x.status))].join(",")}`,
    );
  }

  // ③ 不认识的参数必须 400（`.strict()`），不能静默丢掉
  const bogus = await call("/api/reports?nonsense=1", cookie);
  ok(
    "**多传不认识的参数 → 400**（`.strict()`，静默丢掉最难查）",
    bogus.status === 400,
    `status=${bogus.status}`,
  );

  // ④ 归档二态仍在（返工不该碰坏它）
  const archived = await call("/api/reports?archivedOnly=1", cookie);
  ok("archivedOnly=1 → 200", archived.status === 200, `status=${archived.status}`);
} catch (e) {
  fail += 1;
  console.log(`[FAIL] 脚本中断 —— ${e?.stack ?? e}`);
} finally {
  await dropSmokeAccount(sql, account.id).catch((e) => console.log("清场:", e.message));
  await sql.end();
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
