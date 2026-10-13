/**
 * 反向红工具（**多模式**）：把 @提及（MATT-58 / T4b）的每一条口径逐条拆掉，
 * 看 `smoke-notifications.mjs` 的 ⑧ 段是不是真的在盯它。
 *
 * ## 用法（顺序不能反，本仓纪律：**没有反向红的冒烟等于没有冒烟**）
 *
 *   node agent-work/revred-mention.mjs <mode>                # 注入
 *   node --env-file=.env agent-work/smoke-notifications.mjs   # ⇒ 必须红
 *   node agent-work/revred-mention.mjs restore                # 还原
 *   node --env-file=.env agent-work/smoke-notifications.mjs   # ⇒ 必须绿
 *
 * 不带 mode 跑会列出全部模式与各自期望变红的断言。
 *
 * ## 七种模式（每条对应票面一条 AC）
 *
 * | mode | 注入的缺陷 | 期望变红的断言 |
 * |---|---|---|
 * | `mention-drop` | `intentsOfOutboxRow` 不再产出 mention 意图 | ⑧ 段从「库里多出一条 mention 事件」起整段红 |
 * | `mention-recipients` | mention 的收件人档位**加上 `creator`**（"顺手多推一个"） | 收件人是被 @ 的那个人 / 投递行只有被 @ 的那一个人 |
 * | `mention-quoted` | payload 不再带 `{quoted}`（模板占位符失去真实来源） | **`{quoted}` 有真实来源** |
 * | `mention-placeholder` | 被 @ 的不可见者退回 `void` 静默剔除 | 不可见降级占位 / 占位标题 / 不发摘要字段 |
 * | `mention-parse-off` | 解析层起点错位（从 `@` 本身开始比名字） | **@ 在库里的形态** + ⑧ 段整段红 |
 * | `mention-ids-store` | 评论行不落 `mention_ids`（只活在通知里） | **@ 在库里的形态** / 多个 @ 按出现顺序落库 |
 * | `merge-rule1` | `new_comment` 不再减掉被 @ 的人（§7.2 合并规则 1 的减法摘掉） | ⑧-5 的两条「**恰好 1 条**」+ 「那 1 条是 mention」 |
 *
 * ## 三条踩过的规矩（照抄 `revred-notifications.mjs`，不是抄格式，是抄教训）
 *
 * ⚠ **还原一律用 `restore`，不要用 `git checkout`**（本仓工作树里常年有别的 agent 的
 *   **未提交**改动，`git checkout` 会把它们一起丢掉）。
 * ⚠ **备份路径必须带本工具的名字**（`.revred-mention.bak`）：曾与别的 revred 工具撞过
 *   同一个 `.bak`，两边同时注入时一方把另一方的注入提前还原 ⇒ **一次假绿**。
 * ⚠ **已存在备份时拒绝注入**：否则第二次注入会把"已注入版"当成干净版备份下来，
 *   之后 restore 还原的是缺陷版。
 * ⚠ **同一文件多锚点时按文件分组、组内降序应用**（`revred-notifications.mjs` 栽在这里：
 *   第二个锚点把第一个的注入整段抹掉，而脚本照样打印"已注入"，导致一条断言**从未被钉过**）。
 *
 * ## 注入为什么都写成"仍能编译"的形状
 *
 * 反向红要的是**断言红**，不是编译红/崩溃红——编译红只能证明"代码被改坏了"，
 * 证明不了"冒烟在盯这条口径"。所以每条替换都保证：
 *   · 不产生未使用的 import / 局部变量（`tsconfig` 开了 `noUnusedLocals`）；
 *   · 不产生恒真恒假的字面条件（`if (false)` 那种形状会被 eslint 盯上）；
 *   · 只改语义，不改类型。
 *
 * 为什么用 Node 做替换而不是 PowerShell：PowerShell 的反引号是转义符，
 * `sql\`${...}\`` 这种串会被吃掉、替换静默不命中 —— 已经因此白跑三次。
 * 「反向红不生效」比「没有反向红」更危险：它给出一个绿的假证据。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

const F_SVC = "src/app/lib/server/services/notifications.ts";
const F_MENTION = "src/shared/notification/mention.ts";
const F_RISKS = "src/app/lib/server/services/risks.ts";

/**
 * 一个条目 = 一处替换。**每个条目一个独立 key**（`verify-anchors.mjs` 每个块只抽一条
 * needle，多锚点的模式拆成多个条目才能让预检把它们全查到）。
 * `mode` 把条目归回同一个注入批次。
 */
const ANCHORS = {
  "mention-drop": {
    mode: "mention-drop",
    file: F_SVC,
    tag: "mention-drop",
    /**
     * 写成 `length < 0` 而不是 `if (false)`：后者会让 `mentionIds` 变成
     * "声明了但没读"的局部变量，`noUnusedLocals` 当场报错 ⇒ 那是**编译红**，
     * 而编译红证明不了冒烟在盯这条口径。`length < 0` 恒不成立、可编译、语义等价于"不产出"。
     */
    needle: `    if (mentionIds.length > 0) {`,
    replacement: `    if (mentionIds.length < 0) {`,
  },
  "mention-recipients": {
    mode: "mention-recipients",
    file: F_SVC,
    tag: "mention-recipients",
    /**
     * 注入的是"顺手把创建人也推一份"——票面 AC 明写收件人**不是**创建人，
     * 而这是最容易写出来的错法（规则 2/8 的 `creator` 改道就在隔壁）。
     * 保留 `CUSTOM_RECEIVER_KEY` 的引用是为了不产生未使用的 import（见文件头）。
     */
    needle: `        receivers: [CUSTOM_RECEIVER_KEY],
        customUserIds: mentionIds,`,
    replacement: `        receivers: [CUSTOM_RECEIVER_KEY, "creator"],
        customUserIds: mentionIds,`,
  },
  "mention-quoted": {
    mode: "mention-quoted",
    file: F_SVC,
    tag: "mention-quoted",
    needle: `      quoted: String(p["quoted"] ?? ""),`,
    replacement: `      quoted: "",`,
  },
  "mention-placeholder": {
    mode: "mention-placeholder",
    file: F_SVC,
    tag: "mention-placeholder",
    needle: `        invisibleAsPlaceholder: true,`,
    replacement: `        invisibleAsPlaceholder: false,`,
  },
  "mention-parse-off": {
    mode: "mention-parse-off",
    file: F_MENTION,
    tag: "mention-parse-off",
    /**
     * 起点错位一格（从 `@` 本身开始比名字）——一个真实的 off-by-one：
     * 名字永远比不中，于是 `mention_ids` 恒为空。
     */
    needle: `      if (body.startsWith(c.displayName, at + MENTION_PREFIX.length)) {`,
    replacement: `      if (body.startsWith(c.displayName, at)) {`,
  },
  "mention-ids-store": {
    mode: "mention-ids-store",
    file: F_RISKS,
    tag: "mention-ids-store",
    /**
     * 评论行不落 `mention_ids`，@ 只活在通知链路里。
     * 这是最容易被当成"反正通知发了就行"的一处——而列注写的是
     * 「通知链路将来靠它展开」，也就是它本来就是**事实**的存放处。
     */
    needle: `      mentionIds: mentionIds.map(BigInt),`,
    replacement: `      mentionIds: [],`,
  },
  "merge-rule1": {
    mode: "merge-rule1",
    file: F_SVC,
    tag: "merge-rule1",
    /**
     * §7.2 合并规则 1 的减法被摘掉：`new_comment` 又把被 @ 的人算回收件人，
     * 于是"既是关注人又被 @"的同事收到两条（广播 + 点名）。
     *
     * 注入形状是**整行删掉换成一句注释**，不是 `if (false)`：
     * 减法在这里是一个对象字面量的字段，删掉它不产生未使用的 import / 局部变量
     * （`mentionIds` 后面还要用于 `mention` 意图），所以能编译 —— 反向红要的是断言红。
     */
    needle: `        excludeUserIds: mentionIds,`,
    replacement: `        // 反向红：§7.2 合并规则 1 的减法被摘掉（被 @ 的关注人又会收到广播）`,
  },
};

const modes = [...new Set(Object.values(ANCHORS).map((a) => a.mode))];
const mode = process.argv[2] ?? "";

if (mode === "" || mode === "list") {
  console.log("可用模式（用法：node agent-work/revred-mention.mjs <mode>）：\n");
  for (const m of modes) {
    const entries = Object.values(ANCHORS).filter((a) => a.mode === m);
    console.log(`  ${m}`);
    for (const e of entries) console.log(`      · ${e.file}  (${e.tag})`);
  }
  console.log("\n还原：node agent-work/revred-mention.mjs restore   ← 别用 git checkout");
  process.exit(0);
}

const backupOf = (file) => `${file}.revred-mention.bak`;

if (mode === "restore") {
  let restored = 0;
  for (const file of new Set(Object.values(ANCHORS).map((a) => a.file))) {
    const bak = backupOf(file);
    if (!existsSync(bak)) continue;
    writeFileSync(file, readFileSync(bak, "utf8"), "utf8");
    unlinkSync(bak);
    console.log(`已还原 ${file}（来自备份），并删除备份`);
    restored++;
  }
  if (restored === 0) {
    console.error("没有备份可还原 —— 要么本来就没注入，要么备份被别的工具删了");
    process.exit(2);
  }
  process.exit(0);
}

if (!modes.includes(mode)) {
  console.error(`未知模式 ${mode}。可用：${modes.join(" / ")}`);
  process.exit(2);
}

const entries = Object.values(ANCHORS).filter((a) => a.mode === mode);
const files = [...new Set(entries.map((e) => e.file))];

// 已存在备份 ⇒ 上一次注入还没还原。再注入会把"已注入版"备份成"干净版"。
for (const f of files) {
  if (existsSync(backupOf(f))) {
    console.error(
      `已存在备份 ${backupOf(f)} —— 上一次注入还没还原。\n` +
        `先跑 \`node agent-work/revred-mention.mjs restore\`，再注入。`,
    );
    process.exit(2);
  }
}

// 先全部校验命中次数，一处不合格就整体不动（免得留下半注入状态）
const plan = [];
for (const e of entries) {
  const src = readFileSync(e.file, "utf8");
  const hits = src.split(e.needle).length - 1;
  if (hits !== 1) {
    console.error(
      `锚点 ${e.tag} 在 ${e.file} 命中 ${hits} 次（要恰好 1）—— 注入点失效，请对照当前实现改本脚本。\n` +
        `（先跑 \`node agent-work/verify-anchors.mjs\` 可以不用数据库就发现这一类腐化）`,
    );
    process.exit(2);
  }
  plan.push({ ...e, src, at: src.indexOf(e.needle) });
}

for (const f of files) writeFileSync(backupOf(f), readFileSync(f, "utf8"), "utf8");

/**
 * ⚠ **按文件分组、组内降序应用** —— 不能逐条拿同一份快照去 `slice` 拼接。
 * 详见 `revred-notifications.mjs` 同名注释（那里记着这个缺陷让一条 AC 头号断言
 * "从未被反向红钉过"的完整经过）。
 */
const byFile = new Map();
for (const p of plan) {
  if (!byFile.has(p.file)) byFile.set(p.file, []);
  byFile.get(p.file).push(p);
}
for (const [file, items] of byFile) {
  let buf = readFileSync(file, "utf8");
  for (const p of [...items].sort((a, b) => b.at - a.at)) {
    const at = buf.indexOf(p.needle);
    if (at < 0) {
      console.error(`注入 ${p.tag} 时在缓冲区里找不到锚点 —— 中止（备份还在，用 restore 还原）`);
      process.exit(2);
    }
    buf = buf.slice(0, at) + p.replacement + buf.slice(at + p.needle.length);
    console.log(`已注入 ${p.tag} → ${file}`);
  }
  writeFileSync(file, buf, "utf8");
}
// 自查：每条替换都必须在盘上出现，否则"已注入"是假的
for (const p of plan) {
  const onDisk = readFileSync(p.file, "utf8");
  if (!onDisk.includes(p.replacement)) {
    console.error(`⚠ ${p.tag} 的替换没出现在盘上 —— 注入无效，请查本脚本的分组逻辑`);
    process.exit(2);
  }
}
console.log(
  `\n模式 ${mode} 注入完成（${plan.length} 处）。\n` +
    `  跑冒烟：node --env-file=.env agent-work/smoke-notifications.mjs   ⇒ 必须红\n` +
    `  还原：  node agent-work/revred-mention.mjs restore                ← 别用 git checkout（会丢未提交的改动）`,
);
