/**
 * 反向红工具（MATT-8 同构表契约）：给 `mn_matter_node` 加一列，
 * 确认「列集合 diff 为空」契约测试会红。
 *
 * 用法：node agent-work/revred-iso.mjs [restore]
 *
 * 这是 AC 明文要求的动作（「给 mn_matter_node 加一列，测试必须失败；然后回滚」）。
 * 为什么必须真做一次：契约测试最典型的失败形态是**恒绿**——解析器没命中就返回空集合，
 * 空集合之间的对称差当然为空。只跑一次绿证明不了它在守东西。
 *
 * 注入位置是基线迁移里 `mn_matter_node` 的 CREATE TABLE，锚点用它的 `"matter_id"` 行
 * （该行在整份迁移里只出现一次——两侧表的外键列名不同，所以天然唯一）。
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

const F = "src/app/lib/server/db/migrations/0000_mn_baseline.sql";
const BAK = `${F}.revred.bak`;
const restore = process.argv[2] === "restore";

if (restore) {
  if (!existsSync(BAK)) {
    console.error("没有备份可还原");
    process.exit(2);
  }
  writeFileSync(F, readFileSync(BAK, "utf8"), "utf8");
  unlinkSync(BAK);
  console.log("已还原");
  process.exit(0);
}

const src = readFileSync(F, "utf8");
const needle = '\t"matter_id" bigint NOT NULL,\n\t"node_type_id" bigint NOT NULL,\n\t"name" varchar(128) NOT NULL,';
const replacement =
  '\t"matter_id" bigint NOT NULL,\n\t"zz_revred_probe" integer,\n\t"node_type_id" bigint NOT NULL,\n\t"name" varchar(128) NOT NULL,';
const hits = src.split(needle).length - 1;
if (hits !== 1) {
  console.error(`锚点命中 ${hits} 次（要恰好 1 次）—— 拒绝注入`);
  process.exit(2);
}

writeFileSync(BAK, src, "utf8");
writeFileSync(F, src.replace(needle, replacement), "utf8");
console.log("已给 mn_matter_node 注入一列 [zz_revred_probe]，备份 " + BAK);
