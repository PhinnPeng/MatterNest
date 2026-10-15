import {
  createSmokeAccount,
  dropSmokeAccount,
  finishSmoke,
  noteCleanupFailure,
  ROLE_CODES,
} from "./_testacct.mjs";
/**
 * 进展写入的真 HTTP 冒烟（MATT-59）。
 *
 * ## 这一批要钉住的那句话
 *
 * AC 的原话是「写完进展后 `last_progress_at` 真的前进了」。这句话之所以值得单独一条冒烟，
 * 是因为它有两个出口、而两个出口**漂移起来不报错**：
 *
 *   · `mn_matter.last_progress_at`（规则 4「30 天无更新」的唯一基准）
 *   · 详情页展出的进展列表
 *
 * 「进展写进去了、基准没动」是完全可能被观察到的：那一届 `addProgress` 什么都不做也能让
 * 详情页显出一条新进展。所以本脚本每条断言都同时问两边，而「基准到底动没动」一律直查库，
 * 不靠详情接口转述 —— 接口是它的第二出口，不是它的事实源。
 *
 * ## 为什么先把 `last_progress_at` 压回 40 天前
 *
 * 建案时就落了一次初值（`services/matters.ts` 的 `createMatter`），写进展时也写 `now()`。
 * 两者相隔几百毫秒 ⇒ 「比建案时晚」这种断言几乎恒真，删掉那条 UPDATE 也可能照样判绿 ——
 * 这是本批最容易糊过去的一处。所以这里在写进展**之前**直查库把它压回 40 天前：
 *
 *   · 「前进」变成「从 40 天前跳到现在」，量级差六个数量级，不可能靠时钟精度蒙混；
 *   · 顺带把这个夹具摆成规则 4 的真实形态（一个确实久未更新的案件），
 *     于是断言读起来就是判据本身：这么久没人动的案子，写完一条进展就不该再算「无更新」。
 *
 * ## 时间一律按毫秒数值比，不按字符串比
 *
 * `mn_matter.last_progress_at` 是 `timestamptz`：库里存到微秒（`2026-09-21 11:24:31.49635+00`），
 * 而 postgres.js 交出来的是 JS `Date`（毫秒精度），详情接口给的又是 ISO 串。
 * 三个形态的字符串互不相同，**按字符串比会在实现全对的时候假红**，所以统一 `new Date(x).getTime()`。
 *
 * ## 反向红盯哪一处
 *
 * 把 `addProgress` 事务里那句 `update(matter).set({ lastProgressAt })` 删掉：
 * 「库里的基准跳到此刻」与「详情接口与库内同值」这两条必须红。
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

/** 一切时间统一过这个函数再比：见文件头「按毫秒数值比」那一段 */
function ms(v) {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  const n = d.getTime();
  return Number.isFinite(n) ? n : null;
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

/**
 * 睡够 20 毫秒再写第二条。
 *
 * `last_progress_at` 写的是 `new Date().toISOString()` —— 只有毫秒精度。
 * 两条进展若落在同一毫秒，「第二条严格晚于第一条」会随机红。这在 CI 上是真会撞到的
 * （开门那一段可能只有几毫秒），所以这里显式隔开，而不是指望请求往返够慢。
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

/** 40 天前 —— 规则 4 的判据原文是 `now - last_progress_at > 30d`，取 40 天是为了让
 *  「前进过之后」与「没前进」在任何时区解释下都不可能同值 */
const STALE_DAYS = 40;
const DAY_MS = 86_400_000;

const boss = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
const outsider = await createSmokeAccount(sql, { roles: [ROLE_CODES.self] });
const matterIds = [];

async function cleanup() {
  // 顺序按外键：活动日志与从属明细先走，宿主最后（全是 RESTRICT，顺序错会直接报约束名）。
  // ⚠ `mn_matter_progress.author_id` 是 NOT NULL 且不 SET NULL —— 它记的是「这条进展是谁写的」，
  //   把人抹掉等于把 authorship 变成孤儿。所以**进展行必须在这里删**；留给 `dropSmokeAccount`
  //   的后果是它抛一句「还有 NOT NULL 的业务行指着它」，而那句话指不到本脚本。
  for (const id of matterIds) {
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
  for (const acc of [boss, outsider]) {
    if (!acc?.id) continue;
    await sql`delete from mn_activity_log where operator_id = ${acc.id}`.catch((e) =>
      noteCleanupFailure(`活动日志 ${acc.id}`, e),
    );
    // 会话与角色是 CASCADE，显式删只为不依赖外键动作（与其余 17 个脚本同口径）
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
  const s = await login(boss.username, boss.password);
  ok("夹具账号能登录", s.status === 200, `status=${s.status}`);

  const m = await call("POST", "/api/matters", s.cookie, {
    name: `进展冒烟 ${stamp}`,
    cause: "建设工程施工合同纠纷",
    caseType: "civil_commercial",
    procedure: "first_instance",
    litigationRole: "defendant",
    level: "high",
  });
  ok("建案 → 201", m.status === 201, `status=${m.status}`);
  matterIds.push(m.body?.id);
  const mid = m.body.id;

  // ── 1. 建案落过初值（这一列 NOT NULL，它同时是规则 4 的基准起点）──
  const [created] = await sql`
    select last_progress_at as lp from mn_matter where id=${mid}`;
  ok("建案就落了 `last_progress_at` 初值", !!created?.lp, `lp=${created?.lp?.toISOString?.() ?? created?.lp}`);

  // ── 2. 压回 40 天前：把「前进」摆成一个不可能靠时钟精度蒙混的量级差 ──
  await sql`
    update mn_matter
       set last_progress_at = now() - (${String(STALE_DAYS)} || ' days')::interval
     where id = ${mid}`;
  const [stale] = await sql`
    select last_progress_at as lp,
           (now() - last_progress_at) > interval '30 days' as due30
      from mn_matter where id=${mid}`;
  ok(
    "**夹具处在规则 4 的真形态**：写进展之前它是「30 天无更新」状态",
    stale?.due30 === true,
    `lp=${stale?.lp?.toISOString?.()} due30=${stale?.due30}`,
  );
  const staleMs = ms(stale?.lp);

  // ── 3. 第一条进展 ──
  const t0 = Date.now();
  const p1 = await call("POST", `/api/matters/${mid}/progress`, s.cookie, {
    progressType: "court_action",
    content: "开庭一次，对方缺席，延期 14 天。",
    progressDate: "2026-10-15",
    nextPlan: "补交证据目录",
  });
  ok("**写第一条进展 → 201**", p1.status === 201, `status=${p1.status} body=${JSON.stringify(p1.body)}`);
  const [row1] = await sql`
    select last_progress_at as lp from mn_matter where id=${mid}`;
  const ms1 = ms(row1?.lp);
  ok(
    "**核心 AC：库里的 `last_progress_at` 真的前进了**（不是建案初值，更不是 40 天前那个）",
    ms1 !== null && staleMs !== null && ms1 > staleMs && ms1 >= t0,
    `写前=${stale?.lp?.toISOString?.()}（${STALE_DAYS} 天前） · 写后=${row1?.lp?.toISOString?.()} · 请求=${new Date(t0).toISOString()}`,
  );
  ok(
    "**前进之后不再算「30 天无更新」** —— 这正是规则 4 读它的那个形态",
    ms1 !== null && Date.now() - ms1 < 30 * DAY_MS,
    `距今 ${ms1 === null ? "?" : Math.round((Date.now() - ms1) / 1000)} 秒`,
  );

  // ── 4. 第二条也前进（「只有首次生效」是另一种一眼很难看出来的漂移）──
  await sleep(20);
  const t1 = Date.now();
  const p2 = await call("POST", `/api/matters/${mid}/progress`, s.cookie, {
    progressType: "material_filing",
    content: "已提交证据目录共 12 项。",
    progressDate: "2026-10-16",
  });
  ok("写第二条进展 → 201", p2.status === 201, `status=${p2.status}`);
  const [row2] = await sql`
    select last_progress_at as lp from mn_matter where id=${mid}`;
  const ms2 = ms(row2?.lp);
  ok(
    "**第二条之后基准继续前进**（每条都刷新，不是只有首条生效）",
    ms2 !== null && ms1 !== null && ms2 > ms1 && ms2 >= t1,
    `首条后=${row1?.lp?.toISOString?.()} · 二条后=${row2?.lp?.toISOString?.()}`,
  );

  // ── 5. 两个出口一致：详情接口不许另说一套 ──
  const detail = await call("GET", `/api/matters/${mid}`, s.cookie);
  ok("案件详情 → 200", detail.status === 200, `status=${detail.status}`);
  ok(
    "**详情接口的 `lastProgressAt` 与库里同值**（它是同一列的重述，不是另一处重算）",
    detail.body?.lastProgressAt !== undefined && ms(detail.body?.lastProgressAt) === ms2,
    `接口=${detail.body?.lastProgressAt} · 库=${ms2}`,
  );
  const arr = detail.body?.progress ?? [];
  ok(
    "详情的进展列表里两条都在",
    arr.length === 2 &&
      arr.some((x) => x.content.includes("延期 14 天")) &&
      arr.some((x) => x.content.includes("证据目录")),
    `条数=${arr.length} 首条日期=${arr[0]?.progressDate}`,
  );
  ok(
    "列表里每条都有作者姓名（详情页据此显示「谁记的」）",
    arr.length === 2 && arr.every((x) => !!x.author),
    `authors=${JSON.stringify(arr.map((x) => x.author))}`,
  );

  // ── 6. 审计：`PROGRESS_CREATED` 必须留痕（写了却查不到出处，是最难补的一种漏）──
  const [log] = await sql`
    select action, target_type, target_id, operator_id
      from mn_activity_log
     where matter_id=${mid} and action='PROGRESS_CREATED'
     order by created_at desc limit 1`;
  ok(
    "**`PROGRESS_CREATED` 落审计流水** 且指着刚写的这条进展",
    log?.action === "PROGRESS_CREATED" &&
      log.target_type === "matter_progress" &&
      String(log.target_id) === String(p2.body?.id),
    `target=${log?.target_type}/${log?.target_id} · 进展id=${p2.body?.id}`,
  );

  // ── 7. 写也要判可见：看不到案件的人**也写不进去**（不是只在读侧挡一道）──
  const o = await login(outsider.username, outsider.password);
  ok("范围受限账号能登录", o.status === 200, `status=${o.status}`);
  const denied = await call("POST", `/api/matters/${mid}/progress`, o.cookie, {
    progressType: "routine",
    content: "不在我这边的案件也试着写一条。",
    progressDate: "2026-10-15",
  });
  ok(
    "**看不见的案件 → 写也 404**（不是 403 —— 403 等于承认那个 id 存在）",
    denied.status === 404,
    `status=${denied.status} err=${denied.body?.error}`,
  );
  const deniedRead = await call("GET", `/api/matters/${mid}`, o.cookie);
  ok("同一个账号读它也是 404（读侧同口径）", deniedRead.status === 404, `status=${deniedRead.status}`);
  const [afterDenied] = await sql`
    select last_progress_at as lp from mn_matter where id=${mid}`;
  ok(
    "**被拒的那次写入没有推进基准**（拒绝的本质是「什么都没发生」）",
    ms(afterDenied?.lp) === ms2,
    `被拒后=${afterDenied?.lp?.toISOString?.()}`,
  );

  // ── 8. 载荷校验：三条判据各自的错指在哪个字段 ──
  const bad = [
    ["非法的 progressType", { progressType: "whatever", content: "写一条进展。", progressDate: "2026-10-15" }, "progressType"],
    ["空进展内容", { progressType: "routine", content: "", progressDate: "2026-10-15" }, "content"],
    ["日期不是 ISO", { progressType: "routine", content: "写一条进展。", progressDate: "2026/10/15" }, "progressDate"],
  ];
  for (const [label, payload, field] of bad) {
    const r = await call("POST", `/api/matters/${mid}/progress`, s.cookie, payload);
    ok(
      `**${label} → 400 validation_failed** 且错指 ${field}`,
      r.status === 400 &&
        r.body?.error === "validation_failed" &&
        (r.body?.issues ?? []).some((i) => i.path === field),
      `status=${r.status} issues=${JSON.stringify((r.body?.issues ?? []).map((i) => i.path))}`,
    );
  }
  const [afterBad] = await sql`
    select last_progress_at as lp from mn_matter where id=${mid}`;
  ok(
    "**被拒的载荷没有推进基准**（空进展若被收下，`last_progress_at` 就会替它说谎）",
    ms(afterBad?.lp) === ms2,
    `lp=${afterBad?.lp?.toISOString?.()}`,
  );

  // ── 9. 寻址形状：不存在 vs 写错 ──
  const gone = await call("POST", `/api/matters/999999999999/progress`, s.cookie, {
    progressType: "routine",
    content: "给一个不存在的案件写进展。",
    progressDate: "2026-10-15",
  });
  ok("**不存在的案件 id → 404**（与「不可见」同形）", gone.status === 404, `status=${gone.status}`);
  const badId = await call("POST", `/api/matters/abc/progress`, s.cookie, {
    progressType: "routine",
    content: "写进展给一个不是数字的路径 id。",
    progressDate: "2026-10-15",
  });
  ok(
    "**路径 id 不是数字 → 400 bad_id**（不是 500 —— 5xx 会让监控以为服务端坏了）",
    badId.status === 400 && badId.body?.error === "bad_id",
    `status=${badId.status} err=${badId.body?.error}`,
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
