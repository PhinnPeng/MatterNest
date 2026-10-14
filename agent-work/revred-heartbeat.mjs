/**
 * MATT-83 的反向红工具：把定时器心跳行推进/退回三种状态，验 `db:check` 的 C18 会分别怎么报。
 *
 * 用法（每一步都是一条独立命令，DB 命令不需要 MN_DB_CONFIRM —— 本工具只动一行数据）：
 *   node agent-work/revred-heartbeat.mjs status      # 当前行（不动库）
 *   node agent-work/revred-heartbeat.mjs snapshot    # 注入前先把原行存下来（.bak）
 *   node agent-work/revred-heartbeat.mjs never       # 注入「从未跑过」= created_at IS NULL
 *   pnpm db:check                                    # ⇒ C18 [FAIL]，文案必须是「定时器**从未运行**」
 *   node agent-work/revred-heartbeat.mjs stale       # 注入「跑过但停摆」= 20 分钟前的戳
 *   pnpm db:check                                    # ⇒ C18 [FAIL]，文案必须是「定时器**已停摆**」
 *   node agent-work/revred-heartbeat.mjs fresh       # 注入「跑过且新鲜」= now() + 计数 +1
 *   pnpm db:check                                    # ⇒ C18 [ ok ]，项数 18
 *   node agent-work/revred-heartbeat.mjs constraint  # 断言第二行插不进去（回滚事务，不留痕）
 *   node agent-work/revred-heartbeat.mjs restore     # 按 .bak 逐字还原并比对
 *
 * ## 为什么这条反向红值得单独写
 *
 * C18 的**全部价值**在于两种红的说法不同（「没起来」vs「起过后不动了」）。
 * 只验"红过一次"是不够的：把两句话合并成一句「心跳异常」之后，探针**照样红**，
 * 而排障的人会被送去错的那一半。所以下面每次注入之后都要人眼比对**具体措辞**，
 * 不是只看 exit code。
 *
 * ## 为什么敢在共享 dev 库里动这一行
 *
 *   · 这行**没有第二个消费者**：它只被探针读（本票），泵还没落地（MATT-74）。
 *   · 注入前先把原行（`created_at` + `pump_count`）存成 `.bak`，还原是"按存档写回"，
 *     不是"我照记忆再写一遍"，写完再逐字比对。
 *   · 窗口只有一次 `db:check` 的时间。
 *
 * ⚠ `restore` 的终点是**注入前的那个态**，不是"NULL"。若你在 NULL 态上直接跑过
 *   `fresh`/`stale` 而没先 `snapshot`，本工具会拒绝还原（宁可留着也不猜）。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

const BAK = "agent-work/revred-heartbeat.bak";
const mode = process.argv[2] ?? "";

const { default: postgres } = await import("postgres");
try {
  process.loadEnvFile();
} catch {
  /* 已经由 --env-file 注入 */
}
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  max: 1,
});

const readRow = async () => {
  const rows = await sql`
    select id::text, created_at, pump_count::text,
           extract(epoch from (now() - created_at))::int as age_s
      from mn_timer_heartbeat order by id`;
  return rows;
};
const show = (rows) => {
  if (rows.length === 0) return "(表里没有任何行)";
  return rows
    .map(
      (r) =>
        `id=${r.id} created_at=${r.created_at === null ? "NULL" : r.created_at.toISOString()} ` +
        `pump_count=${r.pump_count} age=${r.age_s === null ? "—" : `${r.age_s}s`}`,
    )
    .join("\n");
};
const requireOne = async (rows) => {
  if (rows.length !== 1) {
    console.error(`心跳行不是恰好 1 行（${rows.length}）—— 本工具拒绝继续，先查库`);
    process.exit(2);
  }
  return rows[0];
};

try {
  if (mode === "status") {
    console.log(await show(await readRow()));
  } else if (mode === "snapshot") {
    if (existsSync(BAK)) {
      console.error(`备份已存在（${BAK}）—— 上一次没还原，先跑 restore`);
      process.exit(2);
    }
    const row = await requireOne(await readRow());
    writeFileSync(
      BAK,
      JSON.stringify({
        created_at: row.created_at === null ? null : row.created_at.toISOString(),
        pump_count: Number(row.pump_count),
      }),
      "utf8",
    );
    console.log(`已存原行：\n${await show(await readRow())}`);
  } else if (mode === "never") {
    await requireOne(await readRow());
    await sql`update mn_timer_heartbeat set created_at = null, pump_count = 0 where id = 1`;
    console.log(`注入「从未跑过」后：\n${await show(await readRow())}`);
  } else if (mode === "stale") {
    await requireOne(await readRow());
    // 20 分钟 > 15 分钟阈值（3 个周期），且刻意不是 15：边界值是另一条断言，不混在这里
    await sql`update mn_timer_heartbeat set created_at = now() - interval '20 minutes' where id = 1`;
    console.log(`注入「跑过但停摆」后：\n${await show(await readRow())}`);
  } else if (mode === "fresh") {
    await requireOne(await readRow());
    await sql`update mn_timer_heartbeat
                 set created_at = now(), pump_count = pump_count + 1
               where id = 1`;
    console.log(`注入「跑过且新鲜」后：\n${await show(await readRow())}`);
  } else if (mode === "constraint") {
    // 单行钉的**行为**验证：第二行必须插不进去。整个事务回滚，库里不留痕。
    // 与 db:check 的 C10 同款纪律：预期失败各自包 SAVEPOINT（PG 里一句报错就 abort 整个事务）。
    class Rollback extends Error {}
    const seen = [];
    try {
      await sql.begin(async (tx) => {
        // id 换一个新值 ⇒ 撞的是 CHECK (id = 1)，不是主键。两条路分开报，否则测不出是哪条在挡。
        try {
          await tx.savepoint(async (sp) => {
            await sp`insert into mn_timer_heartbeat (id, created_at, pump_count)
                     values (2, now(), 0)`;
          });
          seen.push("id=2 插进去了 —— 单行钉失效");
        } catch (e) {
          seen.push(`id=2 被挡：${e.message.split("\n")[0]}`);
        }
        try {
          await tx.savepoint(async (sp) => {
            await sp`insert into mn_timer_heartbeat (id, created_at, pump_count)
                     values (1, now(), 0)`;
          });
          seen.push("id=1 又插了一次 —— 主键没挡（不可能）");
        } catch (e) {
          seen.push(`id=1 重复被挡：${e.message.split("\n")[0]}`);
        }
        throw new Rollback("探针回滚");
      });
      seen.push("⚠ 回滚没有抛出来（事务提交了）");
    } catch (e) {
      if (!(e instanceof Rollback)) seen.push(`EXC:${e.message.split("\n")[0]}`);
    }
    const ok = seen.some((s) => s.startsWith("id=2 被挡")) && seen.some((s) => s.startsWith("id=1 重复被挡"));
    console.log(`单行钉实撞：\n  ${seen.join("\n  ")}`);
    console.log(`库内行数（应仍为 1）：\n${await show(await readRow())}`);
    if (!ok) process.exit(1);
  } else if (mode === "restore") {
    if (!existsSync(BAK)) {
      console.error(`没有备份可还原（${BAK}）`);
      process.exit(2);
    }
    const want = JSON.parse(readFileSync(BAK, "utf8"));
    const before = await requireOne(await readRow());
    await sql`update mn_timer_heartbeat
                 set created_at = ${want.created_at}::timestamptz, pump_count = ${want.pump_count}
               where id = 1`;
    const after = await requireOne(await readRow());
    const sameKind =
      (want.created_at === null) === (after.created_at === null) &&
      String(want.pump_count) === String(after.pump_count);
    console.log(`还原前：\n${show([before])}\n还原后：\n${show([after])}`);
    console.log(`与存档一致（含 NULL 态）：${sameKind ? "是 ✓" : "否 ✗"}`);
    if (!sameKind) process.exit(1);
    unlinkSync(BAK);
  } else {
    console.error("用法：status | snapshot | never | stale | fresh | constraint | restore");
    process.exit(2);
  }
} finally {
  await sql.end({ timeout: 5 });
}
