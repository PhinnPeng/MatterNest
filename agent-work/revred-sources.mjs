/**
 * 反向红工具（**多模式**）：拆掉 MATT-65 的三处口径，看 `smoke-sources.mjs`
 * 是不是真的在盯它。
 *
 * ## 用法
 *
 *   node --env-file=.env agent-work/revred-sources.mjs list
 *   node --env-file=.env agent-work/revred-sources.mjs all       # 注入 → 跑 → 记红 → 还原 → 复绿
 *   node --env-file=.env agent-work/revred-sources.mjs <mode>
 *   node --env-file=.env agent-work/revred-sources.mjs restore   # 还原（**别用 git checkout**）
 *
 * ⚠ 规矩同其它 revred 工具：还原用 `restore`；备份带本工具名；已有备份拒绝注入；
 * 键名用 `needle` / `replacement` 才能进锚点网。
 * ⚠ **注入后必须等 dev server 编译完再跑**（`SETTLE_MS`）—— 否则拿到旧版代码 ⇒ 假绿。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const F_SVC = "src/app/lib/server/services/matters.ts";
const SMOKE = "agent-work/smoke-sources.mjs";
const SETTLE_MS = 3500;

const MODES = {
  /**
   * 摘掉范围谓词 ⇒ 不可见的来源也会被列出来（**事项侧那个反查的已知缺口**）。
   * 这一模式同时打两组断言："看不见 ⇒ 占位"与"响应体不含来源字段"。
   */
  "no-scope": {
    why: "反查不带范围谓词（事项侧 `risks.ts:996-1009` 那个已知缺口：看得见案件、看不见来源时，来源照样被列出来）",
    expectRed: ["他看不见来源事项"],
    anchors: [
      {
        file: F_SVC,
        tag: "no-scope",
        needle:
          '          scopedWhere("risk_matter", actor, eq(riskMatter.id, l.riskMatterId)),\n          sql`NOT ${riskMatter.isDeleted}`,',
        replacement:
          '          eq(riskMatter.id, l.riskMatterId),\n          sql`NOT ${riskMatter.isDeleted}`,',
      },
    ],
  },
  /** 泄露面：不渲染占位、也不隐藏字段 ⇒ 来源整条出现在响应体里 */
  "leak-fields": {
    why: "占位计数恒 0（前端画不出占位），同时来源事项整条留在响应体里",
    expectRed: ["响应体里没有来源事项的编号"],
    anchors: [
      {
        file: F_SVC,
        tag: "leak-fields",
        needle:
          "    return { sourceRisks: visible, sourceRisksHidden: total - visible.length };",
        replacement:
          "    return { sourceRisks: visible, sourceRisksHidden: 0 };",
      },
    ],
  },
  /** 只做单向：反查函数直接返回空 ⇒ 正向链路断 */
  "no-reverse": {
    why: "反查函数直接返回空数组（同一条链只做事项→案件一个方向，本票要补的就是另一个方向）",
    expectRed: ["案件侧能反查到来源事项"],
    anchors: [
      {
        file: F_SVC,
        tag: "no-reverse",
        needle: "  if (links.length === 0) return [];",
        replacement: "  if (links.length >= 0) return [];",
      },
    ],
  },
};

const backupOf = (file) => `${file}.revred-sources.bak`;

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
    console.log(`  ${name.padEnd(16)} ${spec.why}`);
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
    sleep(SETTLE_MS);
    const red = runSmoke();
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
    const green = runSmoke();
    const okGreen = green.code === 0;
    console.log(okGreen ? "[ ok ] 还原后复绿" : `[FAIL] 还原后没复绿（exit=${green.code}）`);
    if (!okGreen) bad++;
  } else {
    inject(mode);
    console.log(`已注入并停在这里。跑门禁后手工 restore：`);
    console.log(`  node --env-file=.env agent-work/revred-sources.mjs restore`);
  }
}

if (cmd === "all") {
  console.log(`\n${bad ? `FAIL：${bad} 项没咬住` : "PASS：每个模式都红在该红的地方、并已复绿"}`);
  process.exit(bad ? 1 : 0);
}
