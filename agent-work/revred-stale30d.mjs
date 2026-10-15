/**
 * 反向红工具（**多模式 + 自带跑批**）：把规则 4 这条链路上的每一处口径逐条拆掉，
 * 看冒烟是不是真的在盯它（MATT-61 / T4e）。
 *
 * ## 用法
 *
 *   node --env-file=.env agent-work/revred-stale30d.mjs list      # 列出全部模式与各自期望变红的断言
 *   node --env-file=.env agent-work/revred-stale30d.mjs all       # 逐模式：注入 → 跑门禁 → 记红 → 还原 → 复绿
 *   node --env-file=.env agent-work/revred-stale30d.mjs <mode>    # 只跑一个模式（注入后**停在那里**）
 *   node --env-file=.env agent-work/revred-stale30d.mjs restore   # 还原（**别用 git checkout**）
 *
 * 不带 mode 时只打印清单，不改任何文件。
 *
 * ## 四条踩过的规矩（从 `revred-rule9.mjs` 抄来的，代价都很大）
 *
 * ⚠ **还原一律用 `restore`，不要用 `git checkout`**：本仓工作树里常年有别的 agent 的
 *   **未提交**改动，`git checkout` 会把它们一起丢掉。
 * ⚠ **备份路径必须带本工具的名字**（`.revred-stale30d.bak`）：曾有两个 revred 工具撞同一个
 *   `.bak`，一方把另一方的注入提前还原 ⇒ **一次假绿**。
 * ⚠ **已存在备份时拒绝注入**：否则第二次注入会把"已注入版"当成干净版备份下来。
 * ⚠ **同一文件多个锚点时按文件分组、组内降序应用**，且每条都**在缓冲区里重新定位**。
 *
 * ## 键名为什么是 `needle` / `replacement`（不是 `find` / `replace`）
 *
 * `agent-work/verify-anchors.mjs` 会扫全部 `revred-*.mjs` 里的 `needle`，
 * 并断言它在目标文件里**恰好命中 1 次**。于是"被注入的源文件被人改了"这件事
 * 会在 `anchors:check` 上红，而不是等到某次反向红静默失效 ——
 * 用别的键名就进不了这张网（`revred-heartbeat.mjs` 那种 restore-only 工具
 * 因此被打印成"未解析出 needle"）。
 *
 * ## 为什么"复绿"要等一会儿再跑
 *
 * 冒烟打的是 **Next dev server**，它按需编译且有滞后：源文件还原后立刻再打一次，
 * 可能仍然跑在注入版上 ⇒ 一次假红（反过来也会假绿）。所以 `all` 在复绿前等 `SETTLE_MS`。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const F_SHARED = "src/shared/notification/stale-30d.ts";
const F_SVC = "src/app/lib/server/services/stale-reminder.ts";
const F_GATE = "src/app/lib/server/services/pump-gate.ts";

const SMOKE = "agent-work/smoke-stale30d.mjs";
const UNIT_SPEC = "src/app/lib/server/services/stale-reminder.spec.ts";

/** dev server 编译滞后：复绿前的等待（毫秒）。见文件头最后一段 */
const SETTLE_MS = 3500;

/**
 * 一个模式 = 一组注入（同一模式里的锚点会被**同时**摘掉）。
 *
 * `expectRed` 是**期望变红的断言名片段** —— 跑批时用它判断"红得对不对"，
 * 而不是"红了就算数"（红错地方等于没钉住）。
 */
const MODES = {
  "no-wiring": {
    why: "扫描器没被轮询点调用（最危险的形态：代码都在、就是没人跑）",
    expectRed: ["满 30 天 → 落了一条", "`last_run_at` 前进了"],
    anchors: [
      {
        file: F_GATE,
        tag: "no-wiring",
        needle: "  const stale = await scanStale30d();",
        replacement:
          "  // [revred:no-wiring] 注入\n  const stale = { ruleFound: false, enabled: false, scanned: 0, events: 0, merged: 0, skipped: [], dateKey: \"\" } as Awaited<ReturnType<typeof scanStale30d>>;",
      },
    ],
  },
  /**
   * ⚠ **这个模式跑单测门，不跑冒烟**（与 `revred-rule9.mjs` 的 `no-archived-gate` 同一条结论）。
   *
   * 归档有两层：SQL 粗筛（`services/stale-reminder.ts`）与纯函数闸门（`shared/notification/stale-30d.ts`）。
   * 它们是**刻意**分层的（粗筛管规模、纯函数管业务口径并产出可排障的原因），
   * 代价是单独摘掉任何一层都可能不红 —— 冒烟里那条"已归档的案件不触发"**只证明 SQL 层成立**：
   * 候选集里根本没有归档案件，纯函数那一层连被调用的机会都没有。
   * 所以这一层只能由**单测门**来守（它直接给纯函数喂 `isArchived: true`）。
   */
  "no-archived-gate": {
    gate: "unit",
    why: "归档闸门被摘：已归档的案件也会收到（终态被当成在办）",
    expectRed: ["已归档"],
    anchors: [
      {
        file: F_SHARED,
        tag: "no-archived-gate",
        needle: "  if (facts.isArchived)\n    return { due: false, reason: \"archived\"",
        replacement: "  if (false)\n    return { due: false, reason: \"archived\"",
      },
    ],
  },
  "no-cooldown": {
    why: "冷却期不生效：cron 每 5 分钟一条 ⇒ 提醒风暴",
    expectRed: ["冷却期内（距上一条 10 天 < 30）不再发"],
    anchors: [
      {
        file: F_SHARED,
        tag: "no-cooldown",
        needle: "    config.oncePerTarget &&\n    config.cooldownDays >= 1 &&",
        replacement: "    false &&\n    config.cooldownDays >= 1 &&",
      },
    ],
  },
  "receivers-all": {
    why: "收件人擅自扩到关注人：规则行里的 receivers 被绕过",
    expectRed: ["关注人收不到"],
    anchors: [
      {
        file: F_SVC,
        tag: "receivers-all",
        needle: "resolveRecipients(tx, \"matter\", c.id, facts, config.receivers)",
        replacement:
          "resolveRecipients(tx, \"matter\", c.id, facts, [\"owner\", \"follower\"] as typeof config.receivers)",
      },
    ],
  },
};

const backupOf = (file) => `${file}.revred-stale30d.bak`;

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
    // 每条都在**当前缓冲区**里重新定位（见文件头第 4 条）
    for (const a of anchors) {
      const at = text.indexOf(a.needle);
      if (at < 0) {
        console.log(`✖ 锚点找不到（模式 ${mode}）：${a.file} :: ${a.needle.slice(0, 60)}`);
        process.exit(1);
      }
      text = text.slice(0, at) + a.replacement + text.slice(at + a.needle.length);
    }
    writeFileSync(file, text);
    // "替换真的落盘了"的自查：注入版的磁盘内容不得再含锚点原文
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

function runSmoke() {
  const r = spawnSync(process.execPath, ["--env-file=.env", SMOKE], { encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/**
 * 跑一道门禁。
 *
 * 默认是冒烟（真 HTTP + 真库）；`gate: "unit"` 换成那条**直接喂事实给纯函数**的单测 ——
 * 有的口径（归档闸门）在冒烟里被更外一层挡着，只有单测能看到它（见 `no-archived-gate` 的注）。
 */
function runGate(mode) {
  const spec = MODES[mode];
  if (spec.gate === "unit") {
    const r = spawnSync(
      process.execPath,
      ["node_modules/vitest/vitest.mjs", "run", UNIT_SPEC],
      { encoding: "utf8" },
    );
    return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }
  return runSmoke();
}

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* 忙等：spawnSync 之外没有可用的 await sleep */
  }
}

const cmd = process.argv[2];
if (!cmd) {
  console.log("可用模式：");
  for (const [name, spec] of Object.entries(MODES)) {
    console.log(`  ${name.padEnd(18)} ${spec.why}`);
    console.log(`      期望变红：${spec.expectRed.join(" / ")}`);
  }
  process.exit(0);
}
if (cmd === "restore") {
  restoreAll();
  process.exit(0);
}

if (cmd === "list") {
  console.log("可用模式：");
  for (const [name, spec] of Object.entries(MODES)) {
    console.log(`  ${name.padEnd(18)} ${spec.why}`);
    console.log(`      期望变红：${spec.expectRed.join(" / ")}`);
  }
  process.exit(0);
}

const modes = cmd === "all" ? Object.keys(MODES) : [cmd];
if (!MODES[modes[0]]) {
  console.log(`✖ 不认识的模式：${cmd}`);
  process.exit(64);
}

let bad = 0;
for (const mode of modes) {
  const spec = MODES[mode];
  console.log(`\n════════ ${mode} ════════`);
  console.log(`拆掉什么：${spec.why}`);

  if (cmd === "all") {
    inject(mode);
    const red = runGate(mode);
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
    const green = runGate(mode);
    const okGreen = green.code === 0;
    console.log(okGreen ? "[ ok ] 还原后复绿" : `[FAIL] 还原后没复绿（exit=${green.code}）`);
    if (!okGreen) bad++;
  } else {
    inject(mode);
    console.log(`已注入并停在这里。跑门禁后手工 restore：`);
    console.log(`  node --env-file=.env agent-work/revred-stale30d.mjs restore`);
  }
}

if (cmd === "all") {
  console.log(`\n${bad ? `FAIL：${bad} 项没咬住` : "PASS：每个模式都红在该红的地方、并已复绿"}`);
  process.exit(bad ? 1 : 0);
}
