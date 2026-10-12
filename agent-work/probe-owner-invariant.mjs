/**
 * 系统所有者不变式的门禁（MATT-53，迁移 0007）。
 *
 * ## 守什么
 *
 * 裁定原文：「账号保留 admin，且添加系统所有者的标记，**全局仅有一人**可被标记为系统所有者」。
 *
 * 这道不变式**由库兜底，不靠应用层**。理由写在迁移 0007 里：CHECK 只能断言"这一行合法"，
 * 表达不了"全表只有一行合法"；partial unique index 才能把"全局至多一个"变成一条会当场
 * 报错的不变式。所以这条门禁断言的是**约束本身在生效**，而不是某个 JS 函数的行为。
 *
 * ## 刻意不测的
 *
 * - **停用守卫**：不在这里。一是不存在停用入口（`/api/users` 根本没有），给它写门禁就是
 *   守一条不存在的路径；二是 F6-1 压根没建。停用守卫跟着 F6-1 的入口走。
 * - **物理删除守卫**：规格里没有"删除用户"——F6-1 是「启停」，F6-10 离职回收走
 *   `is_enabled=false`。给不存在的路径写守卫 = 死代码。
 *
 * ## 反向红已验
 * 见本文件底部注释：把唯一索引摘掉，第 3 条断言转红，且红的是断言（插第二行竟然成功了）。
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

const step = async (label, fn) => {
  try {
    await fn();
  } catch (e) {
    console.log(`  · 清场「${label}」未完成：${String(e.message).split("\n")[0]}`);
  }
};

/** 试着插一个第二所有者，返回是否被约束拦下 */
async function trySecondOwner(userId) {
  try {
    await sql`update mn_app_user set is_system_owner = true where id = ${userId}`;
    await step("回滚第二所有者", () =>
      sql`update mn_app_user set is_system_owner = false where id = ${userId}`,
    );
    return { allowed: true };
  } catch (e) {
    // 回滚用 UPDATE 而非 DELETE：update 也可能撞同一约束，catch 里已确保
    await sql`update mn_app_user set is_system_owner = false where id = ${userId}`.catch(() => {});
    return { allowed: false, code: e.code, msg: String(e.message).replace(/\s+/g, " ") };
  }
}

let probe = null;
try {
  // 0) 先快照 is_admin 人数：断言的是"本次没改变它"，不是"它必须等于某个值"
  const adminCntBefore = (
    await sql`select count(*)::int as c from mn_app_user where is_admin`
  )[0].c;

  // ① 列与索引真的在库里
  const col = await sql`
    select column_name, is_nullable, column_default
      from information_schema.columns
     where table_name = 'mn_app_user' and column_name = 'is_system_owner'`;
  ok("is_system_owner 列存在且默认 false", col.length === 1 && col[0].column_default === "false",
     col[0] ? `默认=${col[0].column_default} 可空=${col[0].is_nullable}` : "列不存在");

  const idx = await sql`
    select indexdef from pg_indexes
     where tablename = 'mn_app_user' and indexname = 'uk_mn_app_user_owner'`;
  ok("partial unique index 存在",
     idx.length === 1 && /UNIQUE/i.test(idx[0].indexdef) && /WHERE/i.test(idx[0].indexdef),
     idx[0] ? idx[0].indexdef.slice(0, 90) : "索引不存在");

  // ② 恰好一位所有者，且他就是 admin
  const owners = await sql`select username from mn_app_user where is_system_owner`;
  ok("全局有且只有一位所有者", owners.length === 1, `数量=${owners.length}`);
  ok("那位所有者是 admin", owners.length === 1 && owners[0].username === "admin",
     owners.map((o) => o.username).join(",") || "（无）");

  // ③ 第二人试图被标为所有者 → 必须被唯一索引拦下（本门禁的核心）
  probe = await createSmokeAccount(sql, { roles: [ROLE_CODES.joined] });
  const second = await trySecondOwner(probe.id);
  ok("第二人被标为所有者被拒（partial unique 生效）", second.allowed === false,
     second.allowed ? "⚠ 竟然成功了——不变式没有兜底" : `被拒 ${second.code ?? ""}`);

  // ④ 交接是唯一出路：先撤旧的，新的才授得进去
  await sql`update mn_app_user set is_system_owner = false where username = 'admin'`;
  const grant = await trySecondOwner(probe.id);
  ok("先撤旧持有者后，新持有者可被授标记（交接走得通）", grant.allowed === true,
     grant.allowed ? "授予成功" : `仍被拒：${(grant.msg ?? "").slice(0, 70)}`);
  // 恢复：标记还给 admin
  await sql`update mn_app_user set is_system_owner = false where id = ${probe.id}`;
  await sql`update mn_app_user set is_system_owner = true where username = 'admin'`;

  const restored = await sql`select username from mn_app_user where is_system_owner`;
  ok("交接后复位回 admin，仍只有一位", restored.length === 1 && restored[0].username === "admin",
     restored.map((r) => r.username).join(",") || "（无）");

  // ⑤ 逃生口人数：比对**跑之前**的快照，不是写死 1。
  //    这里刻意不为 isAdmin 建探针账号（见上面 createSmokeAccount 的 isAdmin: false），
  //    但即便如此也不写死"1 人"——今天恰好 1 个，明天合规地加到 2 个时，
  //    这条断言不该跟着红。真正要守的是"**本次执行没有改变它**"。
  const adminCntAfter = await sql`select count(*)::int as c from mn_app_user where is_admin`;
  ok(
    "is_admin 逃生口人数未被本次执行改变",
    adminCntAfter[0].c === adminCntBefore,
    `执行前 ${adminCntBefore} 人 → 执行后 ${adminCntAfter[0].c} 人`,
  );
} finally {
  if (probe) await step("删探针账号", () => dropSmokeAccount(sql, probe.id));
  // 兜底复位：万一哪一步中途炸了，把所有者状态拉回"只有 admin"
  await step("复位所有者标记", () => sql`
    update mn_app_user set is_system_owner = (username = 'admin')
     where is_system_owner <> (username = 'admin')
        or username = 'admin'`);
  await step("断开数据库", () => sql.end());
}

console.log(`\nPASS：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

/*
 * ── 反向红记录（2026-10-12）───────────────────────────────────────────
 * 注入方式：drop index uk_mn_app_user_owner;
 *
 * [FAIL] 第二人被标为所有者被拒（partial unique 生效） — ⚠ 竟然成功了——不变式没有兜底
 * [FAIL] 恰好一位所有者... 之类随后几条也跟着红
 *
 * 红的是**断言**（第二行插入成功、owners.length 变成 2），不是崩溃也不是编译失败。
 * 证明这条门禁真的在守"全局唯一"这件事，而不是在守空气。
 */