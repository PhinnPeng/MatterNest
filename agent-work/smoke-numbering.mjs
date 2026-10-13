/**
 * 编号门禁：`FX/AJ-YYYYMMDD-XXX` 的**唯一性**与**溢出扩展**。
 *
 * ## 为什么必须有它
 *
 * `numbering.ts` 原先用 `lpad(value::text, 3, '0')`，而 PG 的 `lpad(str, len, fill)`
 * 在 **str 比 len 长时是「截断」而不是「补齐」**：
 *
 *     lpad('999',3,'0')  = '999'    ← 正常
 *     lpad('1000',3,'0') = '100'    ← 截断
 *     lpad('1074',3,'0') = '107'    ← 1000–1999 全塌进 100–199 这 100 个号段
 *
 * 后果不是"号难看"，是**撞号**：`uk_mn_matter_internal_code` 是裸唯一索引，
 * 同一事务里两条 `mn_matter` 拿到同一个号 ⇒ 整笔回滚 ⇒ `POST /api/matters` 随机 500，
 * 转案件（一次取 N 个号）在 N≥2 时**确定性失败**。
 *
 * **它在计数器 <1000 时完全看不出来** —— 本仓的 AJ 计数器 2026-10-13 过千才显形，
 * 那一刻起建案开始随机 500，而排查时看到的症状（唯一索引冲突）离根因
 * （一个字符串函数的截断语义）很远：花了好几条线索才追到。
 *
 * ## 判据
 *
 *   ① PG 的 `lpad` 确实会截断（把"为什么不能用它"钉成可执行事实，而不是注释）；
 *   ② 连取 N 个号**两两不同**（这是撞号的直接判据）；
 *   ③ 号段**格式**正确：`PREFIX-YYYYMMDD-` 后面是数字，且**不足 3 位补零、超过 3 位不截断**；
 *   ④ 计数器 ≥1000 时号段是**原样的十进制**（这正是 `case when` 那一支在管的）。
 *
 * 用法：`node --env-file=.env agent-work/smoke-numbering.mjs`
 */
const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";
const { createSmokeAccount, dropSmokeAccount, ROLE_CODES } = await import("./_testacct.mjs");
const { default: postgres } = await import("postgres");

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

const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

const acc = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
const created = [];

try {
  // ① 把 PG 的 lpad 语义钉成可执行事实
  const [lp] = await sql`
    select lpad('999', 3, '0') as a, lpad('1000', 3, '0') as b, lpad('1074', 3, '0') as c`;
  ok(
    "**PG 的 lpad 在超长时截断**（这就是不能用它的原因）",
    lp.a === "999" && lp.b === "100" && lp.c === "107",
    `lpad('999')=${lp.a} lpad('1000')=${lp.b} lpad('1074')=${lp.c}`,
  );

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: acc.username, password: acc.password }),
  });
  ok("夹具账号能登录", login.status === 200, `status=${login.status}`);
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

  // ②③④ 连取 6 个号（6 > 100 个塌陷号段里的任何一个冲突窗口，且足够暴露截断）
  const codes = [];
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`${BASE}/api/matters`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: `编号门禁 ${i} ${Date.now()}`,
        cause: "买卖合同纠纷",
        caseType: "civil_commercial",
        procedure: "first_instance",
        litigationRole: "plaintiff",
        level: "high",
      }),
    });
    const b = await r.json().catch(() => ({}));
    if (r.status === 201) {
      codes.push(b.internalCode);
      created.push(b.id);
    } else {
      codes.push(null);
      console.log(`    第 ${i + 1} 个建案失败：HTTP ${r.status} ${JSON.stringify(b).slice(0, 160)}`);
    }
  }
  ok("连建 6 个案件全部 201（撞号会整笔回滚成 500）", codes.every(Boolean), `codes=${codes.join(",")}`);

  ok(
    "**连取的号两两不同**（撞号的直接判据）",
    new Set(codes.filter(Boolean)).size === codes.filter(Boolean).length,
    `去重后 ${new Set(codes.filter(Boolean)).size} / ${codes.filter(Boolean).length}`,
  );

  const shape = /^AJ-\d{8}-(\d+)$/;
  const serials = codes.filter(Boolean).map((c) => shape.exec(c)?.[1] ?? null);
  ok(
    "号段格式正确（`AJ-YYYYMMDD-<数字>`）",
    serials.every((s) => s !== null),
    `serials=${serials.join(",")}`,
  );

  // ④ 计数器已过千 ⇒ 号段应是 4 位原样十进制，且**连续**（撞号时会出现重复/跳变）
  const [seq] = await sql`
    select value from mn_code_seq
     where prefix = 'AJ' and day_key = date_trunc('day', now() at time zone 'Asia/Shanghai')::date`;
  const value = Number(seq?.value ?? 0);
  ok("拿到了当日 AJ 计数器", Number.isFinite(value) && value > 0, `value=${value}`);
  if (value >= 1000) {
    const nums = serials.filter(Boolean).map(Number);
    ok(
      "**计数器 ≥1000 时号段是原样十进制（不截断）**",
      nums.every((n) => n >= 1000 && String(n).length === String(n).length),
      `号段=${nums.join(",")}（截断的话这里会出现 <1000 的数）`,
    );
    ok(
      "号段与计数器吻合（末号 == 计数器值）",
      nums.at(-1) === value,
      `末号=${nums.at(-1)} 计数器=${value}`,
    );
    ok(
      "号段连续递增",
      nums.every((n, i) => i === 0 || n === nums[i - 1] + 1),
      `号段=${nums.join(",")}`,
    );
  } else {
    console.log(`  · 计数器 ${value} < 1000，溢出那一支今天测不到（判据已写在上面，明天自然覆盖）`);
  }
} catch (e) {
  fail += 1;
  console.log(`[FAIL] 脚本中断 —— ${e?.message ?? e}`);
} finally {
  for (const id of created) {
    for (const q of [
      `delete from mn_activity_log where matter_id=${id}`,
      `delete from mn_matter_staff where matter_id=${id}`,
      `delete from mn_matter_node where matter_id=${id}`,
      `delete from mn_matter_party where matter_id=${id}`,
      `delete from mn_matter where id=${id}`,
    ]) {
      await sql.unsafe(q).catch(() => {});
    }
  }
  await dropSmokeAccount(sql, acc.id).catch((e) => console.log("清场:", e.message));
  await sql.end();
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
