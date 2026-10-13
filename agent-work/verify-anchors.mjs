/**
 * 反向红工具的**锚点预检**（不需要数据库）。
 *
 * 为什么单独写一个：反向红工具只在真正注入时才校验锚点，而"库回来之后再发现锚点
 * 不匹配"意味着白跑一轮——锚点校验是纯文本操作，没有任何理由等到那时候。
 *
 * 用法：node agent-work/_check-anchors.mjs
 */
import { readFileSync, readdirSync } from "node:fs";

/** 从 revred-*.mjs 里抽出 needle 字面量（不执行工具本身）。覆盖仓里出现过的三种形状：
 *
 *  ① `needle: \`...\`,` （我写的这批：revred-archive / -staff / -users）
 *  ② `const needle = '...\n' + "..." ;`（字符串拼接，revred-followers 那批）
 *  ③ `const NEEDLE = "...";`（单字面量，revred-unconvert 那批）
 *
 * 为什么要覆盖全：**锚点会随被注入的代码一起腐**。MATT-49 给创建路径加了 `followerIds`
 * 之后，`revred-staff` 的两个创建守卫锚点就再也匹配不到了——而工具自己的 `hits !== 1`
 * 守卫只会在**真跑那一刻**喊出来（"拒绝注入"），那时你已经以为反向红验过了。
 * 这个预检不需要数据库，能在跑之前把这类静默腐化全部暴露。
 */
function extractNeedles(file) {
  const src = readFileSync(file, "utf8");
  const out = [];

  // 形状 ①
  //
  // ⚠ **按对象条目切分**，不要用"needle 后面紧跟 replacement"的正则再往前后各扫 400 字
  //   去找 `file:` / `tag:`。初版就是这么写的，而条目里只要夹一段注释（`revred-batch` 的
  //   `tag-scope` 在 needle 与 replacement 之间有一段讲 `void actor;` 的注释）就会：
  //     ① 那条 needle 根本抽不出来；
  //     ② 前一条的 needle 配上了后一条的 `tag:` ⇒ **张冠李戴**，报出"某锚点 0 命中"的**假红**。
  //   假红比漏报更坏：它让人去改一个本来正确的锚点，同时把真正失效的那条掩盖在噪声里。
  //   现在每个条目是一块（顶层 2 空格缩进的 `"key": {`），块内各自取 file/needle/tag，
  //   配对不会跨条目。
  const blocks = src.split(/\n {2}(?=")/).slice(1);
  for (const block of blocks) {
    const tag = block.match(/tag:\s*"([^"]+)"/)?.[1];
    const fileConst = block.match(/file:\s*(F\w*|"[^"]+")/)?.[1];
    // needle 的收尾是「反引号 + 逗号 + 换行」；允许 needle 里出现转义反引号（`\``）
    const needleM = block.match(/needle:\s*`((?:\\[\s\S]|[^`\\])*)`,\n/);
    if (!needleM) continue;
    out.push({ tag: tag ?? "?", fileConst: fileConst ?? null, needle: needleM[1] });
  }
  if (out.length) return out;

  // 形状 ①b：`needle: "..."`（双引号，可能换行写在冒号下一行 —— revred-reports 那批）。
  //   键名当 tag（那批工具用模式名作键），`file:` 取同块内的。
  //   ⚠ 不覆盖它的话，`revred-reports.mjs` 会显示"未解析出 needle"——**门禁的盲区**，
  //     而它恰好是"能编译、能跑通、只是口径错了"那类最难发现的缺陷的守卫。
  for (const block of blocks) {
    const key = block.match(/^"([^"]+)"/)?.[1];
    const fileConst = block.match(/file:\s*(F\w*|"[^"]+")/)?.[1];
    const needleM = block.match(/needle:\s*\n?\s*"((?:[^"\\]|\\.)*)",\n/);
    if (!needleM) continue;
    out.push({
      tag: key ?? "?",
      fileConst: fileConst ?? "F",
      needle: unescapeLiteral(needleM[1]),
    });
  }
  if (out.length) return out;

  // 形状 ②/③：`const needle = <字符串表达式>;` / `const NEEDLE = <字符串表达式>;`
  //
  // ⚠ 模板串要**整体匹配到收尾反引号**，不能按 `;` 截断：模板串里常常含 `;`（例如
  //   `const picked = {};` 那种多行代码片段），非贪婪匹配会在第一个 `;\n` 处停下，
  //   于是"解析不出 needle"——本轮 revred-copycard 就是这么被漏掉的。
  let m;
  const reTpl = /const\s+(needle|NEEDLE|anchor)\s*=\s*`([\s\S]*?)`;/g;
  while ((m = reTpl.exec(src))) {
    out.push({ tag: m[1], fileConst: "F", needle: m[2] });
  }
  if (out.length) return out;

  // 单双引号字面量（可含 `+` 拼接）。变量名多一个 `anchor`：revred-preset 用它。
  const lit = `(?:"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`;
  const re2 = new RegExp(
    `const\\s+(needle|NEEDLE|anchor)\\s*=\\s*(${lit}(?:\\s*\\+\\s*${lit})*);`,
    "g",
  );
  while ((m = re2.exec(src))) {
    const parts = [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)].map((p) => {
      const raw = p[1] ?? p[2] ?? "";
      return unescapeLiteral(raw);
    });
    if (!parts.length) continue;
    out.push({ tag: m[1], fileConst: "F", needle: parts.join("") });
  }
  return out;
}

/**
 * 把**脚本源码里那段字面量文本**还原成它运行时的值。
 *
 * ## 为什么必须**单遍**、且必须包含 `\\`
 *
 * 这个工具读的是**别的脚本的源码文本**，不是 import 它们，所以 JS 在解析期做的转义
 * **它得自己做一遍**。少做一种，那个锚点就会**永远命中 0 次**——而症状与"实现变了、
 * 锚点腐化"**一模一样**，于是它会把人赶去改一个本来是对的锚点。
 *
 * ⚠ 本函数就是被这个坑逼出来的（MATT-44 报告的范围外发现 3）：本文件原先**三处各自
 *   写了一套**反转义，其中"对象 + 反引号 needle"那一处**只处理了 `` \` `` 与 `\$`**，
 *   漏了 `\\`。后果：needle 里含正则（`\\d`）时，源码文本里的 3 个字符 `\\d`
 *   没有被还原成运行时的 2 个字符 `\d`，于是 `src.split(...)` 找不到 ⇒ **假红**。
 *   实现者当时的应对是"把锚点改成无反斜杠的形态"——**被工具缺陷赶着改了写法**。
 *
 * ⚠ **必须单遍**：多遍会把已经还原出来的 `\` 再吃一次（`\\\\` 会退化成 `\`）。
 *   一个正则 + 一个映射函数天然是单遍的。
 *
 * 覆盖的转义：模板串的 `` \` `` `\$` `\\`，以及字符串共有的 `\n \t \r \" \'`。
 * 其余（如 `\uXXXX`）本仓锚点用不到；**真用到时要在这里补**，别在调用点各补一份。
 */
function unescapeLiteral(raw) {
  return raw.replace(/\\(n|t|r|`|\$|"|'|\\)/g, (_x, c) =>
    c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c,
  );
}

/** revred 脚本里的文件常量（F / F_SVC / F_MATTERS / F_RISK …） */
function extractFileConsts(file) {
  const src = readFileSync(file, "utf8");
  const map = {};
  for (const m of src.matchAll(/const (F\w*)\s*=\s*"([^"]+)";/g)) map[m[1]] = m[2];
  return map;
}

const files = readdirSync("agent-work").filter((f) => /^revred-.*\.mjs$/.test(f));
let bad = 0;
/**
 * 真的比对过的锚点数。
 *
 * ⚠ **这是自查，不是统计**（MATT-44 的检查子代理报的空转路径）：本文件此前在
 * **一条 needle 都没抽出来**时照样打印「全部锚点合格」并 exit 0 —— 于是只要抽取正则
 * 被某种格式变化打坏（本仓的 revred 脚本已有过三种形状），**这道门禁会静默变绿**，
 * 而它的「绿」正是"反向红还有人守"这个结论的唯一依据。
 *
 * 与 `agent-work/verify-struct-registry.mjs`、以及我自己给 `_nowriter.mjs` 加的那条
 * 是同一个纪律：**从源码里抠清单的脚本，抠不到东西时必须大声失败**。
 * 报"0 条通过"与报"接口 200"一样，都不能当证据。
 */
let checked = 0;
for (const f of files) {
  const path = `agent-work/${f}`;
  const consts = extractFileConsts(path);
  const needles = extractNeedles(path);
  if (!needles.length) {
    console.log(`· ${f}：未解析出 needle（可能是 restore-only 工具）`);
    continue;
  }
  for (const n of needles) {
    const target = n.fileConst ? consts[n.fileConst] : consts.F;
    if (!target) {
      console.log(`[?] ${f} / ${n.tag}：拿不到目标文件（fileConst=${n.fileConst}）`);
      bad++;
      continue;
    }
    let src;
    try {
      src = readFileSync(target, "utf8");
    } catch {
      console.log(`[✗] ${f} / ${n.tag}：读不到 ${target}`);
      bad++;
      continue;
    }
    // needle 在脚本里是**转义过的**（模板串的 `` \` ``/`\$`/`\\`，以及 `\n` 之类），
    // 读回来必须还原成运行时的样子——**用共享的那一个函数，别在这里手写一套**
    const unescaped = unescapeLiteral(n.needle);
    const hits = src.split(unescaped).length - 1;
    const mark = hits === 1 ? "[✓]" : "[✗]";
    if (hits !== 1) bad++;
    checked++;
    console.log(`${mark} ${f} / ${n.tag} → ${target}：命中 ${hits} 次（要恰好 1）`);
  }
}
// 自查：一条都没比对上 ⇒ 这不是"通过"，是脚本没读懂那些文件
if (checked === 0) {
  console.log(
    `\n🔴 一条锚点都没比对（扫到 ${files.length} 个 revred 脚本，抽出 0 条 needle）——` +
      `\n   这不是通过，是抽取正则跟不上脚本的写法了。先修本文件的 extractNeedles。`,
  );
  process.exit(1);
}
console.log(`\n（本次真的比对过 ${checked} 条锚点）`);
console.log(bad ? `\n有 ${bad} 处锚点不合格` : "\n全部锚点合格");
process.exit(bad ? 1 : 0);