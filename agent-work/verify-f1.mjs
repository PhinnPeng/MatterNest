/**
 * F1 的落地校验：seed 不再下发口令 ≠ 库里已没有可用口令。
 *
 * 这两件事必须分开验：
 *   · **仓库里**没有凭据了 —— 已由 seed 改动保证
 *   · **库里**没有可用凭据了 —— 只有把既有摘要清成 NULL 才算
 *
 * 只验前者就宣布"已修"是危险的：老库的 password_hash 列里还躺着旧的演示摘要，
 * 而列可空、verifyPassword 对 null 返回 false —— 清成 NULL 就是"建号即不可登入"。
 *
 * 只报告相等/不等，不打印摘要本身。
 */
const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST, port: Number(process.env.PGPORT),
  user: process.env.PGUSER, database: process.env.PGDATABASE, password: process.env.PGPASSWORD,
});

const APPLY = process.argv.includes("--apply");

const rows = await sql`
  select id, username, is_admin,
    (password_hash is null) as has_no_password,
    coalesce(length(password_hash), 0) as hash_len
  from mn_app_user order by id`;

console.log("=== 库内现状 ===");
for (const r of rows) {
  console.log(
    `  ${String(r.username).padEnd(10)} admin=${String(r.is_admin).padEnd(5)} 无口令=${String(r.has_no_password).padEnd(5)} 摘要长度=${r.hash_len}`,
  );
}
const withPwd = rows.filter((r) => !r.has_no_password);
console.log(`\n仍有可用口令的账号：${withPwd.length} 个`);

if (!withPwd.length) {
  console.log("PASS：库里也没有可用凭据了。");
  await sql.end();
  process.exit(0);
}

if (!APPLY) {
  console.log("→ 加 --apply 可把这些账号的摘要清成 NULL（该列可空，清完即不可登入）");
  await sql.end();
  process.exit(1);
}

const ids = withPwd.map((r) => r.id);
const cleared = await sql`
  update mn_app_user set password_hash = null, updated_at = now()
  where id = any(${sql.array(ids)}::bigint[]) returning username`;
console.log(`\n已清成 NULL：${cleared.map((r) => r.username).join(", ")}`);

// 顺带把这些账号的旧会话作废：口令清了就该连带清会话，否则旧 cookie 还能用
const sess = await sql`
  delete from mn_auth_session where user_id = any(${sql.array(ids)}::bigint[]) returning id`;
console.log(`已作废旧会话：${sess.length} 条`);

await sql.end();
console.log("PASS：仓库与库都没有可用凭据了。");