/**
 * 量一下本地到 PG 的通路稳定性：连打 N 次，报成功/失败与耗时。
 *
 * 为什么需要：这一轮跑门禁时它断过又回来过，smoke 里出现"L1 登录 500"。
 * 分不清是代码坏了还是通路抖了，就只能反复重跑——那是在用重试掩盖不确定性。
 */
const t0 = Date.now();
let ok = 0;
const fails = [];
const N = 20;

for (let i = 0; i < N; i++) {
  const s = Date.now();
  try {
    const { default: postgres } = await import("postgres");
    const sql = postgres({
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT),
      user: process.env.PGUSER,
      database: process.env.PGDATABASE,
      password: process.env.PGPASSWORD,
      connect_timeout: 5,
    });
    await sql`select 1`;
    await sql.end();
    ok++;
    process.stdout.write(".");
  } catch (e) {
    fails.push(`#${i} ${e?.code ?? e?.message ?? e}`);
    process.stdout.write("X");
  }
  await new Promise((r) => setTimeout(r, 400));
}
console.log(`\n${ok}/${N} 成功，共 ${Date.now() - t0} ms`);
if (fails.length) {
  console.log("失败：");
  for (const f of fails) console.log("  " + f);
}