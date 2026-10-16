/**
 * 反向红工具（**多模式 + 自带跑批**）：把 @提及**渲染侧**（MATT-68 / T4b2）的每一条口径
 * 逐条拆掉，看 `probe-mention-render.mjs` 是不是真的在盯它。
 *
 * ## 用法
 *
 *   node agent-work/revred-mention-render.mjs list      # 列出模式与各自期望变红的断言
 *   node agent-work/revred-mention-render.mjs all       # 逐模式：注入 → 跑探针 → 记红 → 还原 → 复绿
 *   node agent-work/revred-mention-render.mjs <mode>    # 只跑一个模式（注入后**停在那里**）
 *   node agent-work/revred-mention-render.mjs restore   # 还原（**别用 git checkout**）
 *
 * 不带 mode 时只打印清单，不改任何文件。
 *
 * ## 四条踩过的规矩（从 `revred-stale30d.mjs` 抄来的，代价都很大）
 *
 * ⚠ **还原一律用 `restore`，不要用 `git checkout`**：工作树里常年有别人的**未提交**改动。
 * ⚠ **备份路径必须带本工具的名字**（`.revred-mention-render.bak`）：撞 `.bak` 会造成一次假绿。
 * ⚠ **已存在备份时拒绝注入**：否则第二次注入会把"已注入版"当成干净版备份下来。
 * ⚠ **注入必须"仍能编译"**：反向红要的是**断言红**，编译红只能证明"代码被改坏了"。
 *   所以每条替换都不产生未使用的 import / 局部变量（`noUnusedLocals` 开着）。
 *
 * ## 为什么每个模式**只有一条锚点**
 *
 * `agent-work/verify-anchors.mjs` 按"顶层 2 空格缩进的对象条目"切块，**每块只抽第一条 needle**。
 * 一个模式里放两条锚点，第二条就进不了 `anchors:check` 那张网（"被注入的源文件被人改了"
 * 会在跑反向红那一刻才炸）——所以拆成 `parts-off-matter` / `parts-off-risk` 两个模式。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const F_MATTERS = "src/app/lib/server/services/matters.ts";
const F_RISKS = "src/app/lib/server/services/risks.ts";
const F_COMMENT_MENTIONS = "src/app/lib/server/services/comment-mentions.ts";
const F_COMMENT_BODY = "src/shared/notification/comment-body.ts";

const PROBE = "agent-work/probe-mention-render.mjs";

/** dev server 编译滞后：复绿前的等待（毫秒）。见 `revred-stale30d.mjs` 文件头最后一段 */
const SETTLE_MS = 3500;

/**
 * 一个模式 = 一处注入。
 *
 * `expectRed` 是**期望变红的断言名片段** —— 判"红得对不对"，而不是"红了就算数"。
 */
const MODES = {
  "parts-off-matter": {
    why: "案件侧不产分段（DTO 里 parts 恒为空）—— 前端退回纯文本",
    expectRed: [
      "① 案件侧：真提及的 parts 里有一段 mention",
      "① 案件页：真提及画成了 chip",
    ],
    anchors: [
      {
        file: F_MATTERS,
        tag: "parts-off-matter",
        needle: `      parts: commentParts.get(String(c.id)) ?? [],`,
        replacement: `      parts: (commentParts.get(String(c.id)) ?? []).slice(0, 0),`,
      },
    ],
  },
  "parts-off-risk": {
    why: "事项侧不产分段（DTO 里 parts 恒为空）—— 前端退回纯文本",
    expectRed: [
      "① 事项侧：真提及的 parts 有一段 mention",
      "① 事项页：真提及画成了 chip",
    ],
    anchors: [
      {
        file: F_RISKS,
        tag: "parts-off-risk",
        needle: `      parts: commentParts.get(String(c.id)) ?? [],`,
        replacement: `      parts: (commentParts.get(String(c.id)) ?? []).slice(0, 0),`,
      },
    ],
  },
  "roster-all": {
    why: "读取侧拿**这批评论里出现过的全部被点名者**当候选人（= 重解析，而不是按本条的 mention_ids）",
    expectRed: [
      "② 事项侧：编辑出来的 @ 在 parts 里是纯文本",
      "② 事项页：编辑出来的 @ 没有 chip",
      "② 案件页：停用之后发的评论里",
    ],
    anchors: [
      {
        file: F_COMMENT_MENTIONS,
        tag: "roster-all",
        needle: `    const mentioned = c.mentionIds.map(String).flatMap((id) => {
      const u = byId.get(id);
      return u ? [u] : [];
    });`,
        replacement: `    // [revred:roster-all] 反向红：候选人换成"这批评论里出现过的全部被点名者"
    const mentioned = roster.map((u) => byId.get(u.id) ?? u);`,
      },
    ],
  },
  "muted-off": {
    why: "停用判定失效：被点名者的状态按「在名册里」算，而不是按 `active` —— 停用的人也画正常高亮",
    expectRed: [
      "③ 案件页：chip 的降级状态是 inactive",
      "③ 事项页：降级 chip 悬停后有",
    ],
    anchors: [
      {
        file: F_COMMENT_BODY,
        tag: "muted-off",
        needle: `      status: span.ids.every((id) => byId.get(id)?.active === true) ? "active" : "inactive",`,
        replacement: `      status: span.ids.every((id) => byId.has(id)) ? "active" : "inactive",`,
      },
    ],
  },
};

const backupOf = (file) => `${file}.revred-mention-render.bak`;

function inject(mode) {
  const spec = MODES[mode];
  const byFile = new Map();
  for (const a of spec.anchors) {
    if (!byFile.has(a.file)) byFile.set(a.file, []);
    byFile.get(a.file).push(a);
  }
  for (const [file, anchors] of byFile) {
    const bak = backupOf(file);
    if (existsSync(bak)) {
      console.log(`✖ 拒绝注入：${bak} 已存在（先跑 restore）`);
      process.exit(1);
    }
    writeFileSync(bak, readFileSync(file));
    let text = readFileSync(file, "utf8");
    for (const a of anchors) {
      const at = text.indexOf(a.needle);
      if (at < 0) {
        console.log(`✖ 锚点找不到（模式 ${mode}）：${a.file} :: ${a.needle.slice(0, 60)}`);
        process.exit(1);
      }
      text = text.slice(0, at) + a.replacement + text.slice(at + a.needle.length);
    }
    writeFileSync(file, text);
    const written = readFileSync(file, "utf8");
    if (anchors.some((a) => written.includes(a.needle))) {
      console.log(`✖ 注入没落盘（模式 ${mode}）：${file}`);
      process.exit(1);
    }
  }
  console.log(`已注入：${mode}`);
}

function restore(mode) {
  const spec = MODES[mode];
  const files = [...new Set(spec.anchors.map((a) => a.file))];
  for (const file of files) {
    const bak = backupOf(file);
    if (!existsSync(bak)) continue;
    writeFileSync(file, readFileSync(bak));
    unlinkSync(bak);
    console.log(`已还原：${file}`);
  }
}

function restoreAll() {
  for (const mode of Object.keys(MODES)) restore(mode);
}

/** 跑探针（真浏览器 + 真库）。退出码非 0 = 红 */
function runGate() {
  const r = spawnSync(process.execPath, ["--env-file=.env", PROBE], {
    encoding: "utf8",
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* 忙等：spawnSync 之外没有可用的 await sleep */
  }
}

function printModes() {
  console.log("可用模式：");
  for (const [name, spec] of Object.entries(MODES)) {
    console.log(`  ${name.padEnd(20)} ${spec.why}`);
    console.log(`      期望变红：${spec.expectRed.join(" / ")}`);
  }
}

const cmd = process.argv[2];
if (!cmd || cmd === "list") {
  printModes();
  process.exit(0);
}
if (cmd === "restore") {
  restoreAll();
  process.exit(0);
}

const modes = cmd === "all" ? Object.keys(MODES) : [cmd];
if (!MODES[modes[0]]) {
  console.log(`✖ 不认识的模式：${cmd}`);
  printModes();
  process.exit(64);
}

let bad = 0;
for (const mode of modes) {
  const spec = MODES[mode];
  console.log(`\n════════ ${mode} ════════`);
  console.log(`拆掉什么：${spec.why}`);

  if (cmd === "all") {
    inject(mode);
    const red = runGate();
    // 判"红得对不对"：非零退出码 + 期望变红的那几条断言名都能在输出里找到。
    // 只看出退出码会把"红在别处"读成成功 —— 那正是"没钉住"最常见的伪装。
    const hits = spec.expectRed.filter((frag) => red.out.includes(frag));
    const okRed = red.code !== 0 && hits.length === spec.expectRed.length;
    console.log(
      okRed
        ? `[ ok ] 注入后确实红了，且红的是预期那几条（exit=${red.code}）：${hits.join(" / ")}`
        : `[FAIL] 反向红没咬住（exit=${red.code}）：期望 ${spec.expectRed.join(" / ")}，命中 ${hits.join(" / ") || "（无）"}`,
    );
    if (!okRed) bad++;
    restore(mode);
    sleep(SETTLE_MS);
    const green = runGate();
    const okGreen = green.code === 0;
    console.log(okGreen ? "[ ok ] 还原后复绿" : `[FAIL] 还原后没复绿（exit=${green.code}）`);
    if (!okGreen) bad++;
  } else {
    inject(mode);
    console.log(`已注入并停在这里。跑探针后手工 restore：`);
    console.log(`  node agent-work/revred-mention-render.mjs restore`);
  }
}

if (cmd === "all") {
  console.log(`\n${bad ? `FAIL：${bad} 项没咬住` : "PASS：每个模式都红在该红的地方、并已复绿"}`);
  process.exit(bad ? 1 : 0);
}
