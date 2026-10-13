/**
 * MATT-44 ② 的反向红工具：把 `shared/schema/import.ts` 里说明行的**取值分隔符**退回 `/`。
 *
 * 期望变红：`import.spec.ts` 的
 *   「说明行的取值清单按分隔符切开，每一段都是真取值（分隔符不许出现在取值里）」
 * —— E16 的「对外纠纷/投诉」自带 `/`，切出来的「对外纠纷」「投诉」都不是注册表取值。
 *
 * 用法：
 *   node agent-work/revred-import-sep.mjs inject
 *   pnpm exec vitest run src/shared/schema/import.spec.ts      # ⇒ 必须红
 *   node agent-work/revred-import-sep.mjs restore              # 还原（**别用 git checkout**：树上有未提交改动）
 *   pnpm exec vitest run src/shared/schema/import.spec.ts      # ⇒ 必须绿
 *
 * 单锚点、带备份、注入前拒绝覆盖已有备份、还原后打印 sha256 —— 与 `revred-import.mjs` 同款。
 *
 * 文件名用 `revred-` 前缀是**有意的**：`agent-work/verify-anchors.mjs` 只扫 `revred-*.mjs`
 * （本轮实测：改名后它报「命中 1 次」，锚点总数 74 → 75）。这样这条锚点自己也在门禁里：
 * 锚点一旦腐化，注入会失败或变成假红，而门禁当场报出来。
 */
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const F = "src/shared/schema/import.ts";
const BAK = "agent-work/revred-import-sep.bak";
const NEEDLE = 'export const VALUE_LIST_SEP = "、";';
const REPLACEMENT = 'export const VALUE_LIST_SEP = "/"; // 反向红：退回与取值相撞的分隔符';
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const mode = process.argv[2] ?? "";

if (mode === "inject") {
  if (existsSync(BAK)) {
    console.error("备份已存在 —— 上一次没还原，先跑 restore");
    process.exit(2);
  }
  const src = readFileSync(F, "utf8");
  if (src.split(NEEDLE).length - 1 !== 1) {
    console.error("锚点命中次数不为 1，中止");
    process.exit(2);
  }
  copyFileSync(F, BAK);
  writeFileSync(F, src.replace(NEEDLE, REPLACEMENT), "utf8");
  console.log(`注入完成。前 ${sha(BAK).slice(0, 12)}… → 后 ${sha(F).slice(0, 12)}…`);
  console.log(`（干净版 sha256 = ${sha(BAK)}）`);
} else if (mode === "restore") {
  if (!existsSync(BAK)) {
    console.error("没有备份可还原");
    process.exit(2);
  }
  const want = sha(BAK);
  copyFileSync(BAK, F);
  console.log(`还原完成：sha256 = ${sha(F)}`);
  console.log(sha(F) === want ? "与备份逐字节一致" : "⚠ 与备份不一致，人工检查");
  unlinkSync(BAK);
} else if (mode === "check") {
  console.log(`${F} sha256=${sha(F)}`);
} else {
  console.error("用法：inject | restore | check");
  process.exit(2);
}
