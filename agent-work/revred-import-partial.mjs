/**
 * MATT-44 ③ 的反向红工具：把幂等键 `uk_mn_import_row_content` 从 partial 改成**非** partial
 * （同样的名字、同样的列，只摘掉 `WHERE status = 'imported'`），验 `db:check` 的 C16 会红。
 *
 * 用法：
 *   node agent-work/revred-import-partial.mjs inject
 *   pnpm db:check                                        # ⇒ C16 必须 [FAIL]（其余项不该变）
 *   node agent-work/revred-import-partial.mjs restore    # 用注入前抓到的 indexdef 原样重建
 *   pnpm db:check                                        # ⇒ C16 必须 [ ok ]，项数回到 17
 *
 * （`revred-*` 前缀 ⇒ 被 `agent-work/verify-anchors.mjs` 扫到；本工具没有源码锚点，
 *   它只会打印「未解析出 needle」，不是失败。）
 *
 * 为什么敢在共享 dev 库里动这条索引：
 *   · 非 partial 版本对**本服务能产出的数据**是等价的 —— `skipped` 行的 `row_hash` 恒为 NULL
 *     （`services/import.ts` 五处 `writeRow(..., null, "skipped", ...)`），而唯一索引从不约束 NULL。
 *     所以窗口期内别的写者不会因为这次改动而多出 23505；真撞上也会**当场报错**，不会静默改数据。
 *   · 注入前先把 `pg_get_indexdef` 原文存下来，还原是"按原文重建"，不是"我照记忆再写一遍"。
 *   · 窗口只有一次 `db:check` 的时间，跑完立刻还原并逐字比对 indexdef。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

const BAK = "agent-work/revred-import-partial.bak";
const INDEX = "uk_mn_import_row_content";
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

const readDef = async () => (await sql`select pg_get_indexdef(${INDEX}::regclass) as def`)[0].def;
const dropIt = () => sql.unsafe(`drop index if exists ${INDEX}`);
const createIt = (def) => sql.unsafe(def);

try {
  if (mode === "inject") {
    if (existsSync(BAK)) {
      console.error("备份已存在 —— 上一次没还原，先跑 restore");
      process.exit(2);
    }
    const def = await readDef();
    if (!/where\s+\(?\(?status/i.test(def)) {
      console.error(`当前 indexdef 里没有 WHERE 子句，中止：\n${def}`);
      process.exit(2);
    }
    writeFileSync(BAK, def, "utf8");
    const nonPartial = def.replace(/\s+WHERE\s+.*$/is, "");
    await dropIt();
    try {
      await createIt(nonPartial);
    } catch (e) {
      await createIt(def); // 建不出来就立刻还原，别把库留在半路
      console.error(`非 partial 版建不出来（${e.message}）—— 已还原 partial 版`);
      unlinkSync(BAK);
      process.exit(1);
    }
    console.log(`注入完成：\n  前 ${def}\n  后 ${await readDef()}`);
  } else if (mode === "restore") {
    if (!existsSync(BAK)) {
      console.error("没有备份可还原");
      process.exit(2);
    }
    const want = readFileSync(BAK, "utf8").trim();
    await dropIt();
    await createIt(want);
    const got = await readDef();
    console.log(`还原完成：\n  ${got}`);
    if (got.trim() === want) {
      console.log("与注入前逐字一致 ✓");
      unlinkSync(BAK);
    } else {
      console.error(`⚠ 与注入前不一致：\n  期望 ${want}`);
      process.exit(1);
    }
  } else if (mode === "check") {
    console.log(await readDef());
  } else {
    console.error("用法：inject | restore | check");
    process.exit(2);
  }
} finally {
  await sql.end({ timeout: 5 });
}
