/**
 * 禁令⑨ 业务日不许写成 UTC 日切片（2026-10-15，MATT-79）。
 *
 * ## 防的是什么
 *
 * 本仓有两处**同形**的静默缺陷，都是「业务日语义的『今天』取成了 UTC 日」：
 *
 *   · `closing_date`（案件结案日期）—— MATT-69，提交 `2c4806d` 已修
 *   · `discover_date`（事项发现日期）—— MATT-79 已修
 *
 * 后果：上海时间 00:00–08:00 之间发生的动作被记成**前一天**，
 * 而用户无从发现 —— 他确实是在那天做的。没有报错、没有类型错、测试也绿。
 *
 * `src/shared/time/zh-cn.ts` 的 `businessDateKey` 就是为这件事存在的，
 * 它的注释里已经写明理由（「否则上海时间 0–8 点之间的那一批扫描会归到前一天，
 * 而前一天的 key 已经被用过 ⇒ 那一批提醒被静默吞掉」）。
 *
 * ## 为什么是源码断言而不是 eslint 规则
 *
 * eslint 的 `no-restricted-syntax` 表达不了「你**必须** import 某个东西」
 * （只能表达「不得 import 什么」或「某节点形态不得出现」）。
 * 而 `check.mjs` 已经有现成的「walk src → 读文件 → 正则 → 命中即 failure」机制
 * （副标题纪律、富文本白名单），复用它是 ~20 行，不引入新 config 段。
 *
 * ## 为什么窄到必须含 `toISOString()`
 *
 * 本仓的注释里**会写**这个表达式来解释它为什么不能用（`matters.ts:419` 与
 * 本文件自己）。裸 `slice(0, 10)` 匹配会把说明文字自己拦下来 ——
 * 与副标题断言同一个理由（"属性形态才是真的有人在用"，不是词级匹配）。
 *
 * ## 这条断言抓不到什么（别高估它）
 *
 * · **换一种拼法**：`substring(0,10)`、`split("T")[0]`、手写 `+ 8`
 * · **换一种库**：`dayjs(x).format("YYYY-MM-DD")` 少了 `.tz()` ——
 *   `src/app/lib/client/format.ts:19-21` 的 `dateTime()` 就是这个形状
 *   （客户端函数，走浏览器时区，只在浏览器时区 ≠ Asia/Shanghai 时暴露；
 *   本轮**没有**实测到真实用户存在这种浏览器，所以只记在这里，不当作缺陷）
 * · **语义**：一条正则分不出「落库的真错」与「文件名戳的轻错」——
 *   所以本仓的选择是**两处都改成业务日**（MATT-79 顺手做了），
 *   于是规则可以严格、不需要白名单。白名单一旦写出来，就会变成下一轮
 *   没人更新的第二事实源。
 * · **间接落库**：`import.ts:249` 那种「把 null 传给一个会兜底的函数」的路径，
 *   正则看不见（但兜底那一处在本断言覆盖范围内）。
 */

import { readdir, readFile } from "node:fs/promises";

/** 只扫应用源码；`agent-work/` 是探针与冒烟，它们自己会有夹具用的切片 */
const SRC_ROOT = "src";

/**
 * 窄形态：**必须**含 `toISOString()`。
 * 这样注释里为了解释而写出的 `now.slice(0, 10)` 不会被误伤。
 */
const UTC_DAY_SLICE = /toISOString\(\)\s*\.\s*slice\(\s*0\s*,\s*10\s*\)/;

/**
 * 剥掉 TS/TSX 的注释，再拿去匹配。
 *
 * ## 为什么必须剥（第一版没剥，当场被自己绊倒）
 *
 * 第一版只靠「窄形态」防误伤，理由写的是「注释里会写 `now.slice(0, 10)`，
 * 不含 `toISOString()` 就天然排除了」。**那个假设是错的** ——
 * 本禁令自己的文档注释里就完整写了这个表达式（解释为什么不能用它），
 * 于是门禁上线第一次运行就报了 `risks.ts` 的**注释**。
 *
 * 教训与冒烟卫生那条同源：**注释里出现的值不算命中**。
 * 解释「不要用 X」这件事，自然要把 X 写出来 —— 这是文档的正常形态，
 * 不是违规。所以剥注释是必需的，不是保险。
 *
 * ## 它怎么工作 / 边界
 *
 * 单趟扫描，维护「当前是否在字符串里」与「是否在块注释里」两个状态。
 * 字符串含 `'` `"` `` ` `` 三种；模板串里的 `${…}` 不单独解析
 * （本禁令的表达式不含 `${}`，近似足够）。
 *
 * **已知边界**：正则字面量里若含引号（如 `/["']/`）会让配对错位 ——
 * 方向是**多剥**（把后面的代码当注释），也就是可能**漏报**而不是误报。
 * 本仓当前没有这种字面量；真出现时这条断言会静默变松，
 * 而它自己那条「扫到 0 个文件」的 canary 抓不到这种情形。
 * 记在这里，不假装它完备。
 */
function stripTsComments(code) {
  let out = "";
  let i = 0;
  let quote = null;
  let inBlock = false;

  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];

    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i += 2;
      } else i++;
      continue;
    }
    if (quote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      // 行注释：吃到行尾（换行保留，免得把两行拼成一行）
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * @param {string[]} failures 收集到的违规。由 check.mjs 传进来 ——
 *   `failures` 是那个文件的局部变量，这里看不到，所以必须显式传。
 */
export async function assertNoUtcDaySlice(failures) {
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    const sub = await Promise.all(
      entries.filter((e) => e.isDirectory()).map((e) => walk(`${dir}/${e.name}`)),
    );
    const files = entries.filter((e) => !e.isDirectory() && /\.tsx?$/.test(e.name));
    return [...sub.flat(), ...files.map((e) => `${dir}/${e.name}`)];
  };

  const files = await walk(SRC_ROOT);
  if (files.length === 0) {
    failures.push(`业务日断言：${SRC_ROOT}/ 下一个 .ts/.tsx 都没读到，整条断言是假通过`);
    return;
  }

  let scanned = 0;
  for (const file of files) {
    const code = stripTsComments(await readFile(file, "utf8"));
    // 数「看到的文件」而不是「违规数」—— 同 smoke-hygiene 的 canary 教训：
    // 计在过滤之后就等于「仓库干净时计数为 0」，canary 会反过来报红。
    scanned++;
    if (!UTC_DAY_SLICE.test(code)) continue;

    const hits = code.match(new RegExp(UTC_DAY_SLICE.source, "g")) ?? [];
    failures.push(
      `${file} 有 ${hits.length} 处 \`toISOString().slice(0, 10)\` —— ` +
        `那是 **UTC 日**，而业务日语义的「今天」必须是**上海日**：\n` +
        `    上海时间 00:00–08:00 之间发生的动作会被记成前一天，且不报错。\n` +
        `    改用 src/shared/time/zh-cn.ts 的 businessDateKey()（MATT-69 / MATT-79 的先例）。`,
    );
  }

  if (scanned === 0) {
    failures.push("业务日断言：扫到 0 个文件 —— 规则或路径写歪了，本条是假通过");
  }
}
