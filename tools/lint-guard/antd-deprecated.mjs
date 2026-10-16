/**
 * 禁令⑫ antd 已废弃 API（2026-10-16）。
 *
 * ## 防的是什么
 *
 * `antd@6.6.5` 里两处 API 已标废弃，运行时在 console 打出 warning：
 *
 *   · `<List>` —— `The \`List\` component is deprecated and will be removed in the next major
 *     version. If you're using version 6.6.0 or later, please use \`Listy\` instead.`
 *     （`antd/es/list/index.js:197`，同时 `displayName` 被改成 `Deprecated.List`）
 *   · `<Space direction=…>` —— 改名 `orientation`（`antd/es/space/index.js:94`，
 *     `[['direction','orientation'], ['split','separator']]` 纯改名，值域不变）
 *
 * 2026-10-16 那轮浏览器走查实测到的**为什么不能拖**：Next 的 dev overlay 把 antd 的
 * warning 计成 console error，于是页面右下角常驻一个 "Open issues overlay" 徽标；
 * 点开它会直接给源码 `file:line`。徽标一直在，就等于把「有新错误」这条信号弄哑了
 * —— 真出错时没人会再去看它。
 *
 * ## 为什么是源码断言，而不是加进 `SCOPES` 的 eslint 规则
 *
 * 两条都表达得出（`no-restricted-syntax` 用 `JSXOpeningElement[name.name='List']` /
 * `JSXAttribute[name.name='direction']` 即可）。选源码断言的理由是本条**不是一条边界**
 * 而是一笔**过渡期欠账的记账单**：antd 真正移除 `List` 之后本禁令就该退役，
 * 而不是像禁令①⑦⑥⑤ 那样长期挂在 config 上。挂在 `check.mjs` 里多一条：
 *
 *   · 不必为它再养两个 fixture（`SCOPES` 的六道断言要求「违规按数被拦 / 合法不误伤」，
 *     而「合法不误伤」在这里本来就只是「不写这两样东西」）；
 *   · 与 ⑧⑨⑩⑪ 同款，理由、误伤面、抓不到什么写在一个文件里，读的人不用去 config 里拼。
 *
 * ## 三个匹配式（**匹配前剥注释**，见 `strip-comments.mjs`）
 *
 *   · `<List(?=[\s/>])` —— 前瞻排除 `<Listy`；`<List` 后面换行在 JSX 里是常态，
 *     所以 `\s` 而不是空格。`<List.Item` 由下一条管，不在这里重复报。
 *   · `<List\.Item\b` —— 首标签形态。`</List.Item>` 天然不匹配
 *     （它 `<` 后面是 `/`），所以报出来的每一条都对应**一个要改的标签**。
 *   · `\bdirection\s*=` —— 当前 13 处**全是** `<Space>`。
 *
 * ## 误伤面（说清代价后接受，与副标题纪律同款）
 *
 * `\bdirection\s*=` 只认属性形态，但**不认它挂在谁身上**：
 *
 *   · 将来别的组件也有一个叫 `direction` 的 prop，会被误报一次；
 *   · `const { direction = "ltr" } = props` 这种解构默认值也会被误报
 *     （`\b` 挡不住 `{ direction =`，两者前面都是空白）。
 *
 * 两处都是**误报**（红得没有道理，看一眼就明白），而漏报的代价是徽标重新常驻。
 * 本禁令选严。
 *
 * ## 抓不到什么（别高估它）
 *
 *   · `React.createElement(List, props)` —— 本仓不用这种写法；
 *   · 别名/间接引用：`const L = List;` 之后再用 `L`；
 *   · `List` 之外的废弃 API：本禁令只记这两笔账，别指望它兜住 antd 6.6 的全套改名
 *     （`Space` 的 `split` → `separator` 就是同批的另一笔，本仓 0 处用法，故未纳入）；
 *   · JSX 文本里写出来的 `<List>`（比如一段说明文字）会被当成用法 —— 方向也是误报。
 *
 * ## 迁移完之后的 canary 问题
 *
 * 绿了以后 src 里 **0 命中就是正确状态**，于是「仓库干净」与「正则被我改死了」
 * 在结果上完全同形。所以这里备了自检：每个匹配式先在一段**必然命中**的字面量上
 * 跑一次。它抓不到语义，但能挡住「正则空掉 / 写歪」这类静默失效。
 */
import { readdir, readFile } from "node:fs/promises";

import { stripTsComments } from "./strip-comments.mjs";

/** 只扫应用源码；`agent-work/` 是探针（禁令⑪ 管它们），不产生门禁价值 */
const SRC_ROOT = "src";

/** 三个形态 + 各自的改法。`re` 不带 `g`：带了之后 `test()` 会记 `lastIndex`，自检就不可重入 */
const DEPRECATED = [
  {
    name: "<List>",
    re: /<List(?=[\s/>])/,
    fix:
      "antd 6.6.5 起改用 `Listy`（顶层导出）：`items` / `rowKey` / `itemRender(item, index)`；" +
      "空态从 `locale.emptyText` 改成自己条件渲染 `Empty` / `StateBlock`；`header` 换成列表上方的 div；" +
      '`actions` 移进 `itemRender` 里用 `Flex justify="space-between"` 自己排',
  },
  {
    name: "<List.Item>",
    re: /<List\.Item\b/,
    fix: "`Listy` 没有 `List.Item`：每行内容就是 `itemRender` 的返回值",
  },
  {
    name: "Space direction=",
    re: /\bdirection\s*=/,
    fix: "`Space` 的 `direction` 已改名 `orientation`（纯改名，值域不变）",
  },
];

/** 自检样本 —— 每个形态各一行，必然命中（见文件头「迁移完之后的 canary 问题」） */
const SELF_CHECK = [
  "<List dataSource={[]} renderItem={(x) => x} />",
  "<List.Item>内容</List.Item>",
  '<Space direction="vertical" size={2} />',
].join("\n");

/** @returns {{ count: number, lines: number[] }} 命中次数，以及去重后的行号 */
function hitsOn(code, re) {
  const lines = [...code.matchAll(new RegExp(re.source, "g"))].map(
    (m) => code.slice(0, m.index).split("\n").length,
  );
  return { count: lines.length, lines: [...new Set(lines)] };
}

/**
 * @param {string[]} failures 收集到的违规。由 check.mjs 传进来 ——
 *   `failures` 是那个文件的局部变量，这里看不到，所以必须显式传。
 */
export async function assertNoAntdDeprecated(failures) {
  for (const { name, re } of DEPRECATED) {
    if (!re.test(SELF_CHECK)) {
      failures.push(
        `antd 废弃 API：匹配式 ${name} 连自检样本都匹配不上 —— 正则写歪了，` +
          "本条断言此刻在「永远绿」的状态（迁移后 src 里 0 命中是正常的，看不出区别）",
      );
    }
  }

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
    failures.push(`antd 废弃 API：${SRC_ROOT}/ 下一个 .ts/.tsx 都没读到，整条断言是假通过`);
    return;
  }

  for (const file of files) {
    const code = stripTsComments(await readFile(file, "utf8"));
    for (const { name, re, fix } of DEPRECATED) {
      const { count, lines } = hitsOn(code, re);
      if (count === 0) continue;
      failures.push(
        `${file} 有 ${count} 处 \`${name}\`（行 ${lines.join(" ")}）—— ${fix}。` +
          "dev overlay 把 antd 的 warning 计成 console error，不修就会一直亮着「Open issues」徽标",
      );
    }
  }
}
