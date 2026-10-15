/**
 * 反向红工具（**多模式**）：拆掉 MATT-62 的三处口径，看 `smoke-delete.mjs`
 * 是不是真的在盯它。
 *
 * ## 用法
 *
 *   node --env-file=.env agent-work/revred-delete.mjs list
 *   node --env-file=.env agent-work/revred-delete.mjs all       # 注入 → 跑 → 记红 → 还原 → 复绿
 *   node --env-file=.env agent-work/revred-delete.mjs <mode>
 *   node --env-file=.env agent-work/revred-delete.mjs restore   # 还原（**别用 git checkout**）
 *
 * ⚠ 规矩同其它 revred 工具：还原用 `restore`；备份带本工具名；已有备份拒绝注入；
 * 键名用 `needle` / `replacement` 才能进锚点网。
 * ⚠ **注入后必须等 dev server 编译完再跑**（`SETTLE_MS`）—— 否则拿到旧版代码 ⇒ 假绿
 *   （`revred-unarchive.mjs` 第一次跑批就这么栽过一次）。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const F_SVC = "src/app/lib/server/services/matters.ts";
const F_ROUTE = "src/app/api/matters/[id]/route.ts";
const SMOKE = "agent-work/smoke-delete.mjs";
const SETTLE_MS = 3500;

const MODES = {
  /**
   * ⚠ 这一版注入**只删不 update**（不再保留后面的 update）。
   * 第一版是"delete + 保留 update"，结果 `logActivity` 写 `matter_id = 已删 id`
   * 撞 FK RESTRICT ⇒ 500，而冒烟在断言阶段就挂住、`revred` 的 `spawnSync` 一起挂
   * （跑批只打出一行 `════════ hard-delete ════════` 再无下文）。
   * 教训：**注入要让链路"坏得可观察"，而不是"坏得挂住"** ——
   * 挂住的形态与"扫描器没跑"在输出里长得一样，正是本仓最讨厌的那种红。
   */
  "hard-delete": {
    why: "把软删换成硬删（`delete` 代替 `update ... set is_deleted`）",
    expectRed: ["库里那行还在（is_deleted=true，不是硬删）"],
    anchors: [
      {
        file: F_SVC,
        tag: "hard-delete",
        needle:
          "    await tx\n      .update(matter)\n      .set({\n        isDeleted: true,\n        deletedAt: now,\n        updatedBy: BigInt(actor.userId),\n        updatedAt: now,\n      })\n      .where(eq(matter.id, BigInt(id)));",
        replacement:
          "    await tx.delete(matter).where(eq(matter.id, BigInt(id)));\n    await logActivity(tx, actor, {\n      matterId: null,\n      targetType: \"matter\",\n      targetId: BigInt(id),\n      action: \"MATTER_DELETED\",\n    });\n    return;",
      },
    ],
  },
  /** 不写审计：删了但查不出是谁删的 */
  "no-audit": {
    why: "摘掉 `MATTER_DELETED` 审计（删了却查不出是谁删的）",
    expectRed: ["落了 `MATTER_DELETED` 审计"],
    anchors: [
      {
        file: F_SVC,
        tag: "no-audit",
        needle: "      action: \"MATTER_DELETED\",",
        replacement: "      action: \"STATUS_CHANGED\",",
      },
    ],
  },
  /** 403 代替 404：等于向探测者确认"这个 id 存在"（元规则 3） */
  "forbidden-not-404": {
    why: "不可见时给 403 而不是 404（403 确认案号存在）",
    expectRed: ["看不见 ⇒ 404"],
    anchors: [
      {
        file: F_ROUTE,
        tag: "forbidden-not-404",
        needle: "    if (r.why === \"not_found\") return notFound();\n    return attributionRequired();",
        replacement:
          "    if (r.why === \"not_found\") return fail(403, \"forbidden\", \"看不见或不存在\");\n    return attributionRequired();",
      },
    ],
  },
};

const backupOf = (file) => `${file}.revred-delete.bak`;

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
    console.log(`  ${name.padEnd(20)} ${spec.why}`);
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
    console.log(`  node --env-file=.env agent-work/revred-delete.mjs restore`);
  }
}

if (cmd === "all") {
  console.log(`\n${bad ? `FAIL：${bad} 项没咬住` : "PASS：每个模式都红在该红的地方、并已复绿"}`);
  process.exit(bad ? 1 : 0);
}
