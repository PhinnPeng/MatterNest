/**
 * 反向红工具（T1）：分别注入两个缺陷，确认对应的守卫真会红。
 *
 * 用法：node agent-work/revred-t1.mjs <owner|archived> [restore]
 *
 * 几条从前面几轮换来的纪律，这个工具一律遵守：
 *   · 只用 Node 做替换（PowerShell 的反引号会吃掉 `sql`${...}`` 里的反引号，
 *     替换静默不命中，产出一个"没改却说是反向红"的假证据）；
 *   · 判断"是否已注入"只扫**代码行**，不扫注释（注释里就写着要注入的那个字符串）；
 *   · 注入后的代码必须**能编译**，否则红的是编译错误不是断言。
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

const F = "src/app/lib/server/services/risks.ts";
const BAK = `${F}.revred.bak`;
const mode = process.argv[2];
const restore = process.argv[3] === "restore";

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
const codeLines = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
const has = (s) => codeLines.some((l) => l.includes(s));

let out;
if (mode === "owner") {
  // 缺陷：经办人缺省落成创建人（原实现），使"未指派"不可达。
  // 守卫要认**缺陷**的签名（`?? actor.userId`），不是正确代码的签名——
  // 第一版写反了，于是"该跑的时候说已注入、该拒绝的时候照跑"。
  if (has("input.ownerId ?? actor.userId")) {
    console.error("看起来已注入");
    process.exit(2);
  }
  const needle = "const owner = input.ownerId ? BigInt(input.ownerId) : null;";
  if (!src.includes(needle)) {
    console.error("未找到 owner 赋值行");
    process.exit(2);
  }
  out = src.replace(needle, "const owner = BigInt(input.ownerId ?? actor.userId);");
} else if (mode === "archived") {
  // 缺陷：去掉"归档是只读终态"的拦截。
  // 同样是认**缺陷**的签名——缺陷是「那一行不在了」，所以守卫查的是它**在不在**。
  if (!has('if (cur.isArchived) return { ok: false, why: "forbidden" };')) {
    console.error("看起来已注入（拦截行已不在）");
    process.exit(2);
  }
  const needle = '  if (cur.isArchived) return { ok: false, why: "forbidden" };\n';
  if (!src.includes(needle)) {
    console.error("未找到归档拦截行");
    process.exit(2);
  }
  out = src.replace(needle, "  // 反向红：故意去掉只读终态拦截\n");
} else {
  console.error("用法：node revred-t1.mjs <owner|archived> [restore]");
  process.exit(2);
}

writeFileSync(BAK, src, "utf8");
writeFileSync(F, out, "utf8");
console.log(`已注入缺陷 [${mode}]，备份 ${BAK}`);