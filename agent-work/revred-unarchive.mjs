/**
 * 反向红工具（**多模式**）：拆掉 MATT-60 的两处口径，看 `smoke-unarchive.mjs`
 * 是不是真的在盯它。
 *
 * ## 用法
 *
 *   node --env-file=.env agent-work/revred-unarchive.mjs list      # 列出全部模式
 *   node --env-file=.env agent-work/revred-unarchive.mjs all       # 逐模式：注入 → 跑 → 记红 → 还原 → 复绿
 *   node --env-file=.env agent-work/revred-unarchive.mjs <mode>    # 只跑一个模式（注入后停在那里）
 *   node --env-file=.env agent-work/revred-unarchive.mjs restore   # 还原（**别用 git checkout**）
 *
 * ## 规矩（与其它 revred 工具相同，不重复展开）
 *
 * ⚠ 还原一律用 `restore`；备份带本工具名（`.revred-unarchive.bak`）；
 * 已存在备份时拒绝注入；键名用 `needle` / `replacement` 才能进 `verify-anchors.mjs` 的锚点网。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const F_MATTERS = "src/app/lib/server/services/matters.ts";
const F_RISKS = "src/app/lib/server/services/risks.ts";
const SMOKE = "agent-work/smoke-unarchive.mjs";
const SETTLE_MS = 3500;

const MODES = {
  /** 恒必填那一条：把 `unarchiving ||` 换成 `false ||` ⇒ 撤销归档不填原因也能过 */
  "no-unarchive-reason": {
    why: "撤销归档的「原因恒必填」退化成只按偏离推荐路径判（顺着推荐路径撤归档就一个原因都不要）",
    expectRed: ["撤销归档不填原因 → 422"],
    anchors: [
      {
        file: F_MATTERS,
        tag: "no-unarchive-reason",
        needle: "    (unarchiving ||\n      needsChangeReason({",
        replacement: "    (false ||\n      needsChangeReason({",
      },
    ],
  },
  /** 三档动作名退回两档 ⇒ 审计链里按动作名筛不出「谁撤了归档」 */
  "action-two-tier": {
    why: "动作名退回 `archiving ? \"ARCHIVED\" : \"STATUS_CHANGED\"` 两档（撤销归档又被记成 STATUS_CHANGED）",
    expectRed: ["按动作名筛得出 `UNARCHIVED`"],
    anchors: [
      {
        file: F_MATTERS,
        tag: "action-two-tier",
        needle:
          '      action: archiving ? "ARCHIVED" : unarchiving ? "UNARCHIVED" : "STATUS_CHANGED",',
        replacement: '      action: archiving ? "ARCHIVED" : "STATUS_CHANGED",',
      },
    ],
  },
  /** 事项侧那一处漏改：案件侧修好、事项侧还按两档 ⇒ 镜像缺口（历史形态） */
  "risk-side-missed": {
    why: "只改案件侧漏了事项侧：`risks.ts` 还按两档写（两处镜像只改一处）",
    expectRed: ["事项侧同样落 `UNARCHIVED`"],
    anchors: [
      {
        file: F_RISKS,
        tag: "risk-side-missed",
        needle:
          '      action: archiving ? "ARCHIVED" : unarchiving ? "UNARCHIVED" : "STATUS_CHANGED",',
        replacement: '      action: archiving ? "ARCHIVED" : "STATUS_CHANGED",',
      },
    ],
  },
};

const backupOf = (file) => `${file}.revred-unarchive.bak`;

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
        console.log(`✖ 锚点找不到（模式 ${mode}）：${a.file} :: ${a.needle.slice(0, 70)}`);
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
  for (const a of MODES[mode].anchors) {
    const bak = backupOf(a.file);
    if (!existsSync(bak)) continue;
    writeFileSync(a.file, readFileSync(bak));
    unlinkSync(bak);
    console.log(`已还原：${a.file}`);
  }
}

function restoreAll() {
  for (const mode of Object.keys(MODES)) restore(mode);
}

function runSmoke() {
  const r = spawnSync(process.execPath, ["--env-file=.env", SMOKE], { encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* 忙等 */
  }
}

const cmd = process.argv[2];
if (cmd === "list" || !cmd) {
  console.log("可用模式：");
  for (const [name, spec] of Object.entries(MODES)) {
    console.log(`  ${name.padEnd(22)} ${spec.why}`);
    console.log(`      期望变红：${spec.expectRed.join(" / ")}`);
  }
  process.exit(0);
}
if (cmd === "restore") {
  restoreAll();
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
    /**
     * ⚠ **注入后必须先等 dev server 编译完再跑**，否则拿到的是旧版代码 ⇒ 假绿。
     *
     * 第一次跑批 `action-two-tier` 就这样失败过一次：注入确实落盘了、单独跑冒烟也确实红了
     * （3 条 FAIL），但跑批里 exit=0 —— 因为紧接在 `spawnSync` 后面的那次编译还没到位。
     * `SETTLE_MS` 与 `revred-stale30d.mjs` 同值，理由见那个文件的文件头最后一段。
     */
    sleep(SETTLE_MS);
    const red = runSmoke();
    const hits = spec.expectRed.filter((frag) => red.out.includes(frag));
    // 判定"红得对不对"：非零退出码 + 期望变红的断言名都在输出里。
    // 允许**额外**红几条（同一处变异常牵连下游断言），但期望的每一条都必须红。
    const okRed = red.code !== 0 && hits.length === spec.expectRed.length;
    console.log(
      okRed
        ? `[ ok ] 注入后确实红了，且红的是预期那几条（exit=${red.code}）：${hits.join(" / ")}`
        : `[FAIL] 反向红没咬住（exit=${red.code}）：期望 ${spec.expectRed.join(" / ")}，命中 ${hits.join(" / ") || "（无）"}`,
    );
    if (!okRed) bad++;
    restore(mode);
    sleep(SETTLE_MS);
    const green = runSmoke();
    const okGreen = green.code === 0;
    console.log(okGreen ? "[ ok ] 还原后复绿" : `[FAIL] 还原后没复绿（exit=${green.code}）`);
    if (!okGreen) bad++;
  } else {
    inject(mode);
    console.log(`已注入并停在这里。跑门禁后手工 restore：`);
    console.log(`  node --env-file=.env agent-work/revred-unarchive.mjs restore`);
  }
}

if (cmd === "all") {
  console.log(`\n${bad ? `FAIL：${bad} 项没咬住` : "PASS：每个模式都红在该红的地方、并已复绿"}`);
  process.exit(bad ? 1 : 0);
}
