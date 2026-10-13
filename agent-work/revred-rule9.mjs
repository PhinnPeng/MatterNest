/**
 * 反向红工具（**多模式 + 自带跑批**）：把规则 9 这条链路上的每一处口径逐条拆掉，
 * 看冒烟/单测是不是真的在盯它（MATT-43 / T5b）。
 *
 * ## 用法
 *
 *   node --env-file=.env agent-work/revred-rule9.mjs list      # 列出全部模式与各自期望变红的断言
 *   node --env-file=.env agent-work/revred-rule9.mjs all       # 逐模式：注入 → 跑门禁 → 记红 → 还原 → 复绿
 *   node --env-file=.env agent-work/revred-rule9.mjs <mode>    # 只跑一个模式（注入后**停在那里**）
 *   node --env-file=.env agent-work/revred-rule9.mjs restore   # 还原（**别用 git checkout**）
 *
 * 不带 mode 时只打印清单，不改任何文件。
 *
 * ## 四条踩过的规矩（代价都很大，所以写在这里）
 *
 * ⚠ **还原一律用 `restore`，不要用 `git checkout`**：本仓工作树里常年有别的 agent 的
 *   **未提交**改动（本轮就有 MATT-44 与 MATT-58 两条流在改文件），`git checkout` 会把它们一起丢掉。
 * ⚠ **备份路径必须带本工具的名字**（`.revred-rule9.bak`）：曾有两个 revred 工具撞同一个 `.bak`，
 *   一方把另一方的注入提前还原 ⇒ **一次假绿**。
 * ⚠ **已存在备份时拒绝注入**：否则第二次注入会把"已注入版"当成干净版备份下来。
 * ⚠ **同一文件多个锚点时按文件分组、组内降序应用**，且每条都**在缓冲区里重新定位**：
 *   `revred-notifications` 的第一版逐条拿同一份快照切片，于是同一文件有 2 个锚点时
 *   后一次写会把前一次抹掉，而脚本照样打印"已注入"——**一条断言从未被钉过**。
 *   本工具另有"替换真的落盘了"的自查。
 *
 * ## 两层闸门：为什么有的模式要摘两处
 *
 * 规则 9 的候选集有两层过滤：**SQL 粗筛**（`services/archive-reminder.ts`）与
 * **纯函数判定**（`shared/notification/archive-reminder.ts`）。它们是刻意分层的
 * （粗筛管规模，纯函数管业务口径），代价是**单独摘掉任何一层都可能不红**：
 * 另一层还挡着。第一轮跑批就撞到两次（`no-status-gate` 全绿、`no-archived-gate` 全绿），
 * 所以模式里要么写两个锚点（状态闸门），要么换到"那一层是唯一闸门"的门禁上去
 * （归档守卫 → 单测）。
 *
 * ## 为什么"复绿"要等一会儿再跑
 *
 * 冒烟打的是 **Next dev server**，它按需编译且**有滞后**：源文件还原后立刻再打一次，
 * 可能仍然跑在注入版上 ⇒ 一次假红（反过来也会假绿）。第一轮跑批 12 个模式里有 7 个
 * "没复绿"，全都是这个原因（手工复跑立刻就好）。所以 `all` 在复绿前等 `SETTLE_MS`，
 * 并对**最新一次**编译做一次探活（打一个只读且不触发扫描的接口），最多重试 2 次。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const F_SHARED = "src/shared/notification/archive-reminder.ts";
const F_SVC = "src/app/lib/server/services/archive-reminder.ts";
const F_TEMPLATE = "src/shared/notification/template.ts";
const F_ROUTE = "src/app/api/notifications/route.ts";
const F_SEED = "src/app/lib/server/db/seed/0006_automation_rules.sql";
const F_MIGRATION = "src/app/lib/server/db/migrations/0012_automation_rule.sql";

const SMOKE = "agent-work/smoke-rule9.mjs";
const SEED_SPEC = "src/app/lib/server/db/preset-rules.seed.spec.ts";
const UNIT_SPEC = "src/app/lib/server/services/archive-reminder.spec.ts";

/** dev server 编译滞后：复绿前的等待（毫秒）。见文件头最后一段 */
const SETTLE_MS = 3500;
const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";

/**
 * 一个模式 = 一组注入（同一模式里的锚点会被**同时**摘掉）。
 *
 * `gate` 说明跑哪个门禁；`expectRed` 是**期望变红的断言名片段**——
 * 跑批时用它判断"红得对不对"，而不是"红了就算数"（红错地方等于没钉住）。
 */
const MODES = {
  "no-wiring": {
    gate: "smoke",
    why: "扫描器没被轮询点调用（最危险的形态：代码都在、就是没人跑）",
    expectRed: ["满 14 天 → 落了一条"],
    anchors: [
      {
        file: F_ROUTE,
        tag: "no-wiring",
        needle: `    await pumpNotifications();
    await scanArchiveIncomplete();`,
        replacement: `    await pumpNotifications();`,
      },
    ],
  },
  "no-days-gate": {
    gate: "smoke",
    why: "14 天的日界闸门被摘掉（13 天也发）",
    expectRed: ["结案 13 天不发"],
    anchors: [
      {
        file: F_SHARED,
        tag: "no-days-gate",
        needle: `  if (daysClosed === null || daysClosed < config.days)`,
        replacement: `  if (false)`,
      },
    ],
  },
  "no-cooldown": {
    gate: "smoke",
    why: "冷却期闸门被摘掉（once_per_target 形同虚设）",
    expectRed: ["上一条是 1 天前发的"],
    anchors: [
      {
        file: F_SHARED,
        tag: "no-cooldown",
        needle: `  if (
    config.oncePerTarget &&
    config.cooldownDays >= 1 &&
    daysSinceLastNotify !== null &&
    daysSinceLastNotify < config.cooldownDays
  ) {`,
        replacement: `  if (false) {`,
      },
    ],
  },
  "no-status-gate": {
    gate: "smoke",
    why: "状态闸门被摘掉（`status_code:\"closed\"` 失效：进行中的案件也催材料）",
    expectRed: ["未结案不发"],
    // 两层一起摘：SQL 粗筛 + 纯函数判定。只摘一层时另一层还挡着（见文件头）
    anchors: [
      {
        file: F_SVC,
        tag: "no-status-gate-sql",
        needle: `        eq(matter.status, config.statusCode),\n`,
        replacement: ``,
      },
      {
        file: F_SHARED,
        tag: "no-status-gate-pure",
        needle: `  if (facts.status !== config.statusCode)
    return { due: false, reason: "not_closed", daysClosed: null, daysSinceLastNotify };`,
        replacement: `  // 反向红：状态闸门被摘掉`,
      },
    ],
  },
  "no-archived-gate": {
    /**
     * ⚠ **这个模式的门禁是单测，不是冒烟**——第一轮跑批时它"注入后全绿"，
     * 原因值得记下来：
     *
     * 归档那条路在冒烟里有**两层**同时在挡：`is_archived = false`（SQL 粗筛）与
     * `status = 'closed'`（`changeStatus` 把 status 与 is_archived 一起改，所以
     * `is_archived = true ⟹ status = 'archived'`）。也就是说"归档后不发"这条断言
     * **无论纯函数里的 `isArchived` 闸门在不在都会绿** —— 它钉的是状态过滤，不是这道守卫。
     *
     * 所以这道守卫的反向红落在单测上：`archive-reminder.spec.ts` 直接断言
     * `{isArchived:true} ⇒ reason === "archived"`，摘掉后 `reason` 变成 `no_missing`。
     * 它是**守卫**（将来若出现"只置 is_archived 不改 status"的写入路径，它才成为唯一闸门），
     * 今天它冗余——写清楚比删掉好：删掉就没人记得这里曾经有两层。
     */
    gate: "spec",
    spec: UNIT_SPEC,
    why: "归档是终态这道守卫被摘掉（单测盯它；冒烟那一层由状态过滤承担）",
    expectRed: ["已归档不发"],
    anchors: [
      {
        file: F_SHARED,
        tag: "no-archived-gate",
        needle: `  if (facts.isArchived)`,
        replacement: `  if (false)`,
      },
    ],
  },
  "no-missing-gate": {
    gate: "smoke",
    why: "缺项闸门被摘掉（材料齐备也催）",
    expectRed: ["材料齐备 ⇒ 不发"],
    anchors: [
      {
        file: F_SHARED,
        tag: "no-missing-gate",
        needle: `  if (facts.missing.length === 0)`,
        replacement: `  if (false)`,
      },
    ],
  },
  "no-enabled-gate": {
    gate: "smoke",
    why: "规则的启停开关被摘掉（停用后照样发）",
    expectRed: ["停用后不再产生提醒"],
    anchors: [
      {
        file: F_SVC,
        tag: "no-enabled-gate",
        needle: `  if (!rule.isEnabled) return { ...empty, ruleFound: true, enabled: false };`,
        replacement: `  // 反向红：停用闸门被摘掉`,
      },
    ],
  },
  "receivers-all": {
    gate: "smoke",
    why: "收件人从「仅经办人」放宽到「关注人 + 创建人」",
    expectRed: ["关注人没有收到"],
    anchors: [
      {
        file: F_SVC,
        tag: "receivers-all",
        needle: `    receivers: (receivers.length > 0
      ? receivers
      : RULE_ARCHIVE_INCOMPLETE_NOTIFY.receivers) as readonly NotifyReceiver[],`,
        replacement: `    receivers: ["owner", "follower", "creator"] as readonly NotifyReceiver[],`,
      },
    ],
  },
  "missing-code-raw": {
    gate: "smoke",
    why: "缺项码映射写错（正文里渲染不出中文缺项）",
    expectRed: ["正文是 B5 定稿第 8 条的文案"],
    anchors: [
      {
        file: F_TEMPLATE,
        tag: "missing-code-raw",
        needle: `  openNodes: "pending_nodes",`,
        replacement: `  openNodes: "open_nodes",`,
      },
    ],
  },
  "no-last-run": {
    gate: "smoke",
    why: "扫描器不再留「我跑过」的痕迹（零事件与没跑过重新变得不可分）",
    expectRed: ["这一次真的前进了"],
    anchors: [
      {
        file: F_SVC,
        tag: "no-last-run",
        needle: `  await db
    .update(automationRule)
    .set({ lastRunAt: now.toISOString(), updatedAt: now.toISOString() })
    .where(eq(automationRule.id, rule.id));`,
        replacement: `  // 反向红：last_run_at 不再写`,
      },
    ],
  },
  "seed-host-all": {
    gate: "spec",
    spec: SEED_SPEC,
    why: "规则 3 的宿主被改回 all（IQ-9/Q37 的收窄回退）",
    expectRed: ["规则 3/4 的宿主收窄"],
    anchors: [
      {
        file: F_SEED,
        tag: "seed-host-all",
        needle: `  (8003, 'preset_03_in_progress_create_node', '进入进行中创建节点', 'matter', 'status_changed', 'matter',`,
        replacement: `  (8003, 'preset_03_in_progress_create_node', '进入进行中创建节点', 'all', 'status_changed', 'matter',`,
      },
    ],
  },
  "seed-scope-typo": {
    gate: "spec",
    spec: SEED_SPEC,
    why: "seed 里的 scope_key 手抄错一位（唯一约束静默失效）",
    expectRed: ["scope_key` 逐条等于"],
    anchors: [
      {
        file: F_SEED,
        tag: "seed-scope-typo",
        needle: `   '9hviq69mu3cd', 10, true, true, 101)`,
        replacement: `   '9hviq69mu3ce', 10, true, true, 101)`,
      },
    ],
  },
  "db-index-drop": {
    gate: "smoke",
    db: "drop-index",
    why: "把 partial unique index 从库里删掉（触发域唯一性不再由 DB 保证）",
    expectRed: ["同域同动作的启用规则插不进去"],
    anchors: [],
  },
};

const unescapeNeedle = (s) => s.replace(/\\`/g, "`").replace(/\\\$/g, "$");
const backupOf = (file) => `${file}.revred-rule9.bak`;
const allFiles = () => [...new Set(Object.values(MODES).flatMap((m) => m.anchors.map((a) => a.file)))];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mode = process.argv[2] ?? "";

/* ────────────────────────────────────────────────────────────────────────────
 * 跑门禁 + 抽红
 * ──────────────────────────────────────────────────────────────────────────── */

/** 从门禁输出里抽"红的断言名"（冒烟是 `[FAIL] x`，vitest 是 `× x`） */
function redsOf(output) {
  const out = [];
  for (const line of output.split(/\r?\n/)) {
    const smoke = /^\[FAIL\]\s+(.*?)(?:\s+—.*)?$/.exec(line);
    if (smoke) out.push(smoke[1]);
    const vitest = /^\s*×\s+(.*?)(?:\s+\d+ms)?$/.exec(line);
    if (vitest) out.push(vitest[1]);
  }
  return out;
}

function runGate(gate, spec) {
  const args =
    gate === "smoke"
      ? ["--env-file=.env", SMOKE]
      : ["node_modules/vitest/vitest.mjs", "run", spec ?? SEED_SPEC];
  const r = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  return { code: r.status, output, reds: redsOf(output) };
}

/**
 * 等 dev server 把**当前源码**编译出来。
 *
 * 探针打 `/api/meta`（只读、不触发扫描、不写库）：它回到任何状态码都算"服务活着"，
 * 但**不保证**模块图已经换新。所以真正的判据是"复绿门禁自己跑绿"，
 * 这里只负责给编译留出时间，并把探针结果打出来（连不上时一眼能看见隧道抖了）。
 */
async function waitForDevServer() {
  await sleep(SETTLE_MS);
  try {
    const res = await fetch(`${BASE}/api/meta`, { method: "GET" });
    return res.status;
  } catch (e) {
    return `探针失败：${e?.message ?? e}`;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 注入 / 还原
 * ──────────────────────────────────────────────────────────────────────────── */

function inject(m) {
  // 先把所有锚点校验一遍，一处不合格就整体不动（免得留下半注入状态）
  const plan = [];
  for (const a of m.anchors) {
    const src = readFileSync(a.file, "utf8");
    const needle = unescapeNeedle(a.needle);
    const hits = src.split(needle).length - 1;
    if (hits !== 1) {
      console.error(
        `锚点 ${a.tag} 在 ${a.file} 命中 ${hits} 次（要恰好 1）—— 注入点失效，请对照当前实现改本脚本。`,
      );
      process.exit(2);
    }
    plan.push({ ...a, needle, at: src.indexOf(needle) });
  }
  // 备份（每个文件一次）
  for (const file of [...new Set(plan.map((p) => p.file))]) {
    const bak = backupOf(file);
    if (existsSync(bak)) {
      console.error(`已存在备份 ${bak} —— 上一次注入还没还原。先跑 restore，再注入。`);
      process.exit(2);
    }
    writeFileSync(bak, readFileSync(file, "utf8"), "utf8");
  }
  // 按文件分组、组内**降序**应用；每条都在缓冲区里重新定位
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
      buf = buf.slice(0, at) + unescapeNeedle(p.replacement) + buf.slice(at + p.needle.length);
      console.log(`  已注入 ${p.tag} → ${file}`);
    }
    writeFileSync(file, buf, "utf8");
  }
  // 自查：每条替换都必须在盘上出现，否则"已注入"是假的
  for (const p of plan) {
    if (!readFileSync(p.file, "utf8").includes(unescapeNeedle(p.replacement))) {
      console.error(`⚠ ${p.tag} 的替换没出现在盘上 —— 注入无效，请查本脚本的分组逻辑`);
      process.exit(2);
    }
  }
}

function restoreFiles() {
  let restored = 0;
  for (const file of allFiles()) {
    const bak = backupOf(file);
    if (!existsSync(bak)) continue;
    writeFileSync(file, readFileSync(bak, "utf8"), "utf8");
    unlinkSync(bak);
    console.log(`  已还原 ${file}（来自备份），并删除备份`);
    restored++;
  }
  return restored;
}

/* ── DB 模式：索引的删与建（定义从迁移文件里读，不手抄） ─────────────────── */

const INDEX_NAME = "ux_mn_automation_rule_enabled_action";

async function withDb(fn) {
  const { default: postgres } = await import("postgres");
  const sql = postgres({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    user: process.env.PGUSER,
    database: process.env.PGDATABASE,
    password: process.env.PGPASSWORD,
    max: 1,
    onnotice: () => {},
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function indexDdlFromMigration() {
  const raw = readFileSync(F_MIGRATION, "utf8");
  const stmt = raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .find((s) => s.includes(`CREATE UNIQUE INDEX IF NOT EXISTS "${INDEX_NAME}"`));
  if (!stmt) throw new Error(`迁移里找不到 ${INDEX_NAME} 的 DDL`);
  return stmt;
}

const indexPresent = () =>
  withDb(async (sql) => {
    const [row] = await sql`
      select count(*)::int as n from pg_indexes
       where schemaname = 'public' and indexname = ${INDEX_NAME}`;
    return row.n > 0;
  });

const dropIndex = () =>
  withDb(async (sql) => {
    await sql.unsafe(`DROP INDEX IF EXISTS "${INDEX_NAME}"`);
    console.log(`  已删除 ${INDEX_NAME}`);
  });

const recreateIndex = () =>
  withDb(async (sql) => {
    await sql.unsafe(indexDdlFromMigration());
    const [row] = await sql`
      select indexdef from pg_indexes
       where schemaname = 'public' and indexname = ${INDEX_NAME}`;
    if (!row) throw new Error(`${INDEX_NAME} 重建失败`);
    console.log(`  已重建 ${INDEX_NAME}：${row.indexdef}`);
  });

/**
 * **清扫注入产生的通知事件**（注入会真的发通知，`restore` 不会把它们收回去）。
 *
 * ## 为什么这是必需的，而不是"顺手打扫"
 *
 * 有几个模式是**故意把闸门摘掉**的，而闸门一摘，扫描器就会给**不属于本票夹具**的记录
 * 也发提醒：`no-status-gate` 一跑，demo 库里那五条案件全收到了一条 `archive_incomplete`
 * （实测：`host_id` 7001–7005，payload 写着 `["closing_date","pending_nodes"]`，
 * 而它们当时是 `in_progress`）。马桶冲不掉的后果不是"脏"，是**误导**：
 * 下一个人打开通知中心会看到四条不该存在的提醒，并据此怀疑规则 9 的判定。
 *
 * 判据用**时间窗**（模式开始的时刻）而不是 `host_id` 白名单：白名单要人去维护，
 * 而窗只依赖"这一轮注入从什么时候开始"。投递行由 `event_id` 的 cascade 连带删。
 */
async function sweepArtifacts(since) {
  const rows = await withDb(async (sql) => {
    return sql`
      delete from mn_notification_event
       where event_type = 'archive_incomplete' and created_at >= ${since.toISOString()}
      returning id`;
  });
  if (rows.length) console.log(`  清扫注入产生的 ${rows.length} 条 archive_incomplete 事件（时间窗内）`);
  return rows.length;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 入口
 * ──────────────────────────────────────────────────────────────────────────── */

if (mode === "" || mode === "list") {
  console.log("可用模式（用法：node --env-file=.env agent-work/revred-rule9.mjs <mode|all>）：\n");
  for (const [name, m] of Object.entries(MODES)) {
    console.log(`  ${name}  [gate=${m.gate}${m.db ? " db=" + m.db : ""}]`);
    console.log(`      ${m.why}`);
    console.log(`      期望变红：${m.expectRed.join(" / ")}`);
  }
  console.log("\n还原：node --env-file=.env agent-work/revred-rule9.mjs restore   ← 别用 git checkout");
  process.exit(0);
}

if (mode === "restore") {
  const restored = restoreFiles();
  if (!(await indexPresent())) await recreateIndex();
  /**
   * 手工流程（注入 → 跑门禁 → restore）也顺手清扫注入副产物。
   *
   * 窗口取 **30 分钟**：足够覆盖一次"注入 → 跑冒烟 → 还原"（约一分钟），
   * 又不至于碰到别人的东西。合法的提醒被误删也不会永久丢失——
   * 下一次 `GET /api/notifications` 会把仍然该发的那条重新落下来（同业务日同一个 `dedupe_key`）。
   */
  await sweepArtifacts(new Date(Date.now() - 30 * 60 * 1000));
  if (restored === 0) {
    console.error("没有备份可还原 —— 要么本来就没注入，要么备份被别的工具删了");
    process.exit(2);
  }
  process.exit(0);
}

if (mode !== "all" && !MODES[mode]) {
  console.error(`未知模式 ${mode}。可用：all / restore / ${Object.keys(MODES).join(" / ")}`);
  process.exit(2);
}

if (mode !== "all") {
  const m = MODES[mode];
  if (m.db === "drop-index") await dropIndex();
  else inject(m);
  console.log(
    `\n模式 ${mode} 注入完成。\n` +
      `  跑门禁：${m.gate === "smoke" ? `node --env-file=.env ${SMOKE}` : `npx vitest run ${m.spec}`}\n` +
      `  还原：  node --env-file=.env agent-work/revred-rule9.mjs restore`,
  );
  process.exit(0);
}

/* ── all：逐模式跑批 ─────────────────────────────────────────────────────── */
console.log(`\n先确认**注入前是绿的**（否则后面的"红"没有意义）…`);
const baseline = runGate("smoke");
const baselineSpec = runGate("spec", SEED_SPEC);
if (baseline.code !== 0 || baselineSpec.code !== 0) {
  console.error(
    `注入前的基线不是绿的：冒烟 exit=${baseline.code}（红 ${baseline.reds.length} 条）` +
      ` · seed 单测 exit=${baselineSpec.code}（红 ${baselineSpec.reds.length} 条）\n` +
      `先把基线修绿再来做反向红 —— 否则分不清"注入造成的红"与"本来就红"。`,
  );
  process.exit(2);
}
console.log(`基线绿：冒烟 0 红 · seed 单测 0 红\n`);

/** 跑批起点：用它做"注入副产物"的时间窗判据（见 `sweepArtifacts`） */
const batchStart = new Date();

const rows = [];
let bad = 0;
for (const [name, m] of Object.entries(MODES)) {
  console.log(`\n════ ${name} ════\n  ${m.why}`);
  const modeStart = new Date();
  if (m.db === "drop-index") await dropIndex();
  else inject(m);

  const red = runGate(m.gate, m.spec);
  const matched = m.expectRed.filter((needle) => red.reds.some((r) => r.includes(needle)));
  const verdict = red.code !== 0 && matched.length === m.expectRed.length ? "OK" : "**不合格**";
  if (verdict !== "OK") bad++;
  console.log(
    `  注入后：exit=${red.code} 红 ${red.reds.length} 条 · 期望命中 ${matched.length}/${m.expectRed.length} ${verdict}`,
  );
  for (const r of red.reds.slice(0, 6)) console.log(`      · ${r}`);
  if (red.reds.length > 6) console.log(`      …另有 ${red.reds.length - 6} 条`);
  if (verdict !== "OK" && red.code === 0) {
    console.log(`      ⚠ 注入后门禁**全绿** —— 这个模式没有被任何断言盯住`);
    console.log(red.output.split(/\r?\n/).slice(-8).join("\n"));
  }

  // 还原 → 清扫注入的副产物 → 等编译 → 复绿（最多两次；仍红就是真不合格）
  if (m.db === "drop-index") await recreateIndex();
  else restoreFiles();
  await sweepArtifacts(modeStart);
  let green = { code: 1, reds: ["(未跑)"] };
  let attempts = 0;
  for (; attempts < 2; attempts++) {
    if (m.gate === "smoke") console.log(`  等 dev server 编译（探针 ${await waitForDevServer()}）…`);
    green = runGate(m.gate, m.spec);
    if (green.code === 0) break;
  }
  const greenOk = green.code === 0;
  if (!greenOk) bad++;
  console.log(
    `  还原后：exit=${green.code} ${greenOk ? `复绿 OK（第 ${attempts + 1} 次）` : `**没复绿**（${green.reds.length} 条红）`}`,
  );
  if (!greenOk) for (const r of green.reds.slice(0, 4)) console.log(`      · ${r}`);
  rows.push({ name, redCount: red.reds.length, matched, verdict, greenOk, attempts: attempts + 1 });
}

console.log(`\n════ 汇总 ════`);
console.log("| 模式 | 红的条数 | 期望断言命中 | 还原后复绿 |");console.log("|---|---|---|---|");
for (const r of rows)
  console.log(
    `| ${r.name} | ${r.redCount} | ${r.matched.length > 0 ? r.matched.join("、") : "**0**"} | ${r.greenOk ? `✓（第 ${r.attempts} 次）` : "✗"} |`,
  );
console.log(
  bad === 0
    ? `\n✅ 全部 ${rows.length} 个模式都"注入即红、还原即绿"`
    : `\n❌ 有 ${bad} 处不合格（红不出来 / 红错地方 / 没复绿）`,
);
// 兜底再扫一遍整轮窗口：某个模式的清扫可能被后续的并发扫描补回来
await sweepArtifacts(batchStart);
process.exit(bad === 0 ? 0 : 1);
