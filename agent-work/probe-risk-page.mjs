/**
 * T1 详情页的真 HTTP 门禁。
 *
 * ## 为什么门禁断言的是 API 而不是页面 HTML
 *
 * 第一版这脚本断言「事项名/编号渲染进了 HTML」，三条全红。查下来是**我断言的前提错了**：
 * `risk-detail.tsx` 是 `"use client"`，SSR 只发 loading 骨架，内容是客户端 fetch 之后才有的。
 * 更糟的是同版本里有一条 `html.includes("已归档")` 的断言**绿了——绿得毫无意义**：
 * 它命中的是侧边导航的菜单项（`ant-menu-item-content`），不是页面上的归档提示卡。
 *
 * 一个因为错误的原因而通过的断言，比没有更危险：它会让人以为这条门禁在守着什么。
 * 所以这里只断言两类真正成立的东西：
 *   · **SSR 层**：页面 200、无 Next 错误标记（证明组件没在服务端炸）
 *   · **数据层**：详情接口真的带着 `nodeTypes` 等字段（这才是"加节点能不能用"的根据）
 *
 * ## 特别守着 nodeTypes
 *
 * 页面原先另发一次 `/api/meta?host=risk_matter` 去取节点类型，而那个接口**根本不返回
 * `nodeTypes`**（`host` 只决定状态/等级/标签）。于是下拉恒空、**界面上加不了节点**。
 * tsc 不管、服务层冒烟也不管（它是直接 POST `/nodes` 绕过界面的）。
 * 这条断言就是为了让那个洞以后再关不上。
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

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`[ ok ] ${name}${extra ? " — " + extra : ""}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}${extra ? " — " + extra : ""}`);
  }
};

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

// ⚠ 账号创建必须在 `try` **之内**。原来它在外面：反向红那两轮正好在改 `risks.ts`、
// dev server 正在重编译，于是登录那步抛错 → 账号从��被清 → 库里留了两个孤儿。
// 「测试装置自己漏清理」这种坑，只有真去反查残留才发现得了。
const acct = await (async () => {
  try {
    return await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
  } catch (e) {
    console.log(`  · 建账号失败：${String(e.message).split("\n")[0]}`);
    await sql.end();
    process.exit(2);
  }
})();

let cookie = "";
let riskId = null;
try {
  const lr = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: acct.username, password: acct.password }),
  });
  cookie = (lr.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  ok("临时账号登录", lr.status === 200 && Boolean(cookie), `status=${lr.status}`);

  // 造一条自己的事项
  const now = new Date().toISOString();
  const [r] = await sql`
    insert into mn_risk_matter
      (id, code, name, type, level, status, description, discover_date, created_by, created_at, updated_at)
    values (
      ${BigInt(Date.now() * 1000) + 7n},
      ${"PROBE-" + Date.now().toString(36).toUpperCase()},
      ${"详情门禁探针 " + Date.now().toString(36)},
      'other', 'mid', 'open', '详情页门禁，跑完即删', ${now}, ${acct.id}, ${now}, ${now}
    ) returning id, code, name`;
  riskId = r.id;

  // ── 数据层：详情接口必须带齐页面要用的字段 ──
  const detail = await call("GET", `/api/risk-matters/${riskId}`, cookie);
  ok("详情接口 200", detail.status === 200, `status=${detail.status}`);

  const body = detail.body ?? {};
  ok(
    "详情带 nodeTypes（加节点弹窗靠它，原缺陷就在这）",
    Array.isArray(body.nodeTypes) && body.nodeTypes.length > 0,
    `拿到 ${Array.isArray(body.nodeTypes) ? body.nodeTypes.length : "非数组"} 个`,
  );
  // ⚠ 下面两条都先要求 `length > 0`：反向红验证时发现，`[].every(...)` 恒真、
  // `id = any('{}')` 匹配 0 行，于是"数组空了"反而两条都绿——那正是我一直在反对的
  // 那种因为错误原因而通过的断言。空集合必须先把上一条断言判死，不能自己活下来。
  ok(
    "nodeTypes 每项都有中文名与 id",
    Array.isArray(body.nodeTypes) &&
      body.nodeTypes.length > 0 &&
      body.nodeTypes.every((t) => t && t.id && t.code && t.name) &&
      !/^[a-z_]+$/.test(String(body.nodeTypes[0]?.name ?? "")),
    `首项 name=${JSON.stringify(body.nodeTypes?.[0]?.name)}`,
  );
  ok("详情带 convertedCases（已转案件反查块）", Array.isArray(body.convertedCases));
  ok("详情带 statuses（状态流转依据）", Array.isArray(body.statuses) && body.statuses.length > 0);
  ok("详情带 activity（活动流）", Array.isArray(body.activity));

  // 事项节点只支持时间点：nodeTypes 里不得混入 range 类型。
  // 先确认真的检查到了东西——否则「混入 0 个」只是在数空气。
  const typeIds = body.nodeTypes.map((t) => t.id);
  const range = typeIds.length
    ? await sql`
        select count(*)::int as c
        from mn_node_type_config
        where id = any(${sql.array(typeIds)}::bigint[])
          and time_type is distinct from 'point'`
    : [{ c: -1 }];
  ok(
    "nodeTypes 全是时间点（IQ-5）",
    typeIds.length > 0 && range[0].c === 0,
    typeIds.length ? `检查了 ${typeIds.length} 个，混入 ${range[0].c} 个非 point` : "无可检查项",
  );

  // ── SSR 层：页面能在服务端渲染出来 ──
  const page = await fetch(`${BASE}/risk-matters/${riskId}`, { headers: { cookie } });
  const html = await page.text();
  ok("详情页 SSR 200", page.status === 200, `status=${page.status} 长度=${html.length}`);
  const errMarks = ["__next_error__", "Application error", "Unhandled Runtime Error"];
  const hit = errMarks.filter((m) => html.includes(m));
  ok("SSR 无 Next 错误标记", hit.length === 0, hit.length ? `命中：${hit.join(", ")}` : "");

  // 登录页不得再出现演示账号清单（F1 的界面侧尾巴）
  const lp = await fetch(`${BASE}/login`);
  const lhtml = await lp.text();
  const demoNames = ["wangkf", "lichen", "zhaolj", "suny", "hezp"];
  const leaked = demoNames.filter((n) => lhtml.includes(n));
  ok("登录页不含演示账号清单", leaked.length === 0, leaked.length ? `仍出现：${leaked.join(", ")}` : "");
  ok("登录页不再宣称「口令 = 账号」", !lhtml.includes("口令 = 账号"), "");
} finally {
  // 清场各步**互相独立**：一步抛错不能连累后面的（原来第一句抛了就什么都不剩）
  const step = async (label, fn) => {
    try {
      await fn();
    } catch (e) {
      console.log(`  · 清场「${label}」未完成：${String(e.message).split("\n")[0]}`);
    }
  };
  await step("删探针事项", async () => {
    if (riskId) await sql`delete from mn_risk_matter where id = ${riskId}`;
  });
  await step("删临时账号", () => dropSmokeAccount(sql, acct.id));
  await step("断开数据库", () => sql.end());
}

console.log(`\nPASS：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);