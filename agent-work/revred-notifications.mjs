/**
 * 反向红工具（**多模式**）：把通知管线的九条口径逐条拆掉，看冒烟是不是真的在盯它。
 *
 * ## 用法（顺序不能反，本仓纪律：**没有反向红的冒烟等于没有冒烟**）
 *
 *   node agent-work/revred-notifications.mjs <mode>          # 注入
 *   node --env-file=.env agent-work/smoke-notifications.mjs  # ⇒ 必须红
 *   node agent-work/revred-notifications.mjs restore         # 还原
 *   node --env-file=.env agent-work/smoke-notifications.mjs  # ⇒ 必须绿
 *
 * 不带 mode 跑 `node agent-work/revred-notifications.mjs` 会列出全部模式与各自期望变红的断言。
 *
 * ## 九种模式（每条对应票面一条 AC）
 *
 * | mode | 注入的缺陷 | 期望变红的断言 |
 * |---|---|---|
 * | `creator-drop` | 规则 2 的 `receivers` 摘掉 `creator` | 上报人收到状态变更通知 |
 * | `creator-watch` | 顺手给创建人补一条 `user_watch(follow)` 行 | 不写 user_watch 行 |
 * | `dedupe-batch` | `dedupe_key` 里的 batch 换成随机数 | 2 条意图聚合成 1 条事件 / merge_count / 重放后事件数不变 |
 * | `timezone` | 通知文案的时间改成 `.utc()`（见该条目的长注释：删掉 `.tz()` 在本机是假绿） | 正文里的期限是上海时间 / 不出现 UTC 写法 |
 * | `scan-confirmed` | 扫描的 `is_time_confirmed` 闸门（纯函数 + SQL 两处）一起摘掉 | is_time_confirmed=false 的节点不提醒 |
 * | `archived-notify` | 归档宿主照样发通知（状态变更 + 评论两处） | 归档这一步本身不发通知 / 归档记录不写 outbox |
 * | `placeholder` | 通知中心把不可见的行当可见渲染 | 不可见降级占位 / 占位行标题 / 不发摘要字段 |
 * | `unread-all` | 未读计数不看可见性 | 未读计数按可见行计 |
 * | `outbox-early` | 评论的 outbox 行一写就当成已投递 | 业务事务只写 outbox / 上报人收到新评论通知 |
 *
 * ## 三条踩过的规矩
 *
 * ⚠ **还原一律用 `restore`，不要用 `git checkout`**（本仓工作树里常年有别的 agent 的
 *   **未提交**改动，`git checkout` 会把它们一起丢掉）。
 * ⚠ **备份路径必须带本工具的名字**：曾与别的 revred 工具撞过同一个 `.bak`，
 *   两边同时注入时一方把另一方的注入提前还原 ⇒ **一次假绿**。
 * ⚠ **已存在备份时拒绝注入**：否则第二次注入会把"已注入版"当成干净版备份下来，
 *   之后 restore 还原的是缺陷版（`revred-archive` 踩过这个）。
 *
 * 为什么用 Node 做替换而不是 PowerShell：PowerShell 的反引号是转义符，
 * `sql\`${...}\`` 这种串会被吃掉、替换静默不命中 —— 已经因此白跑三次。
 * 「反向红不生效」比「没有反向红」更危险：它给出一个绿的假证据。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

const F_PRESET = "src/shared/notification/preset-rules.ts";
const F_SVC = "src/app/lib/server/services/notifications.ts";
const F_DEDUPE = "src/shared/notification/dedupe.ts";
const F_TIME = "src/shared/time/zh-cn.ts";
const F_SCAN = "src/shared/notification/scan.ts";

/**
 * 一个条目 = 一处替换。**每个条目一个独立 key**，因为 `verify-anchors.mjs`
 * 每个块只抽一条 needle —— 多锚点的模式拆成多个条目，才能让预检把它们全查到。
 * `mode` 把条目归回同一个注入批次。
 */
const ANCHORS = {
  "creator-drop": {
    mode: "creator-drop",
    file: F_PRESET,
    tag: "creator-drop",
    needle: `  templateCode: "status_changed",
  receivers: ["follower", "creator"],`,
    replacement: `  templateCode: "status_changed",
  receivers: ["follower"],`,
  },
  "creator-watch": {
    mode: "creator-watch",
    file: F_SVC,
    tag: "creator-watch",
    needle: `  const facts = await loadHostFacts(tx, args.host, args.hostId);
  if (!facts) return { eventId: null, delivered: 0, merged: false };`,
    replacement: `  const facts = await loadHostFacts(tx, args.host, args.hostId);
  if (!facts) return { eventId: null, delivered: 0, merged: false };
  await tx.execute(sql\`insert into mn_user_watch (id, user_id, target_type, target_id, watch_type, created_at)
    values (\${BigInt(nextId())}, \${facts.createdBy ?? BigInt(actor.userId)}, \${args.host}, \${args.hostId}, 'follow', now())
    on conflict do nothing\`);`,
  },
  "dedupe-batch": {
    mode: "dedupe-batch",
    file: F_DEDUPE,
    tag: "dedupe-batch",
    needle: `    args.batchId,`,
    replacement: `    args.batchId + String(Math.random()),`,
  },
  "timezone": {
    mode: "timezone",
    file: F_TIME,
    tag: "timezone",
    /**
     * ⚠ 注入的是 **`.utc()`** 而不是"把 `.tz()` 删掉"。
     *
     * 本机（以及开发机）的**进程时区恰好是 Asia/Shanghai**，所以
     * `dayjs(iso).format(...)`（删掉 `.tz()` 的写法）在这台机器上**输出与正确结果一致**
     * ——那种注入会得到一次**假绿**（本轮实测踩到过）。
     * 它真正的暴露面是生产容器（Docker 默认 UTC），而 `.utc()` 正是那个条件下的等价写法，
     * 也是"会话钉 UTC"这句话最容易诱导出的实现。
     *
     * "忘了写时区"那条路径由 `src/shared/notification/notification.spec.ts` 的
     * 「进程时区为 UTC」用例盯着（它把 `process.env.TZ` 临时改成 UTC，让两种写法当场分开）。
     */
    needle: `d.tz(BUSINESS_TIMEZONE).format(NOTIFY_TIME_PATTERN)`,
    replacement: `d.utc().format(NOTIFY_TIME_PATTERN)`,
  },
  "scan-confirmed-pure": {
    mode: "scan-confirmed",
    file: F_SCAN,
    tag: "scan-confirmed-pure",
    needle: `  if (!node.isTimeConfirmed) return [];`,
    replacement: `  // 反向红：is_time_confirmed 闸门被摘掉`,
  },
  "scan-confirmed-sql": {
    mode: "scan-confirmed",
    file: F_SVC,
    tag: "scan-confirmed-sql",
    needle: `          eq(t.isTimeConfirmed, true),`,
    replacement: `          // 反向红：SQL 侧的 is_time_confirmed 闸门被摘掉`,
  },
  "archived-notify-status": {
    mode: "archived-notify",
    file: F_SVC,
    tag: "archived-notify-status",
    needle: `  if (args.isArchivedAfter) return { eventId: null, delivered: 0, merged: false };`,
    replacement: `  if (false) return { eventId: null, delivered: 0, merged: false };`,
  },
  "archived-notify-comment": {
    mode: "archived-notify",
    file: F_SVC,
    tag: "archived-notify-comment",
    needle: `  if (!facts || facts.isArchived) return false;`,
    replacement: `  if (!facts) return false;`,
  },
  "placeholder": {
    mode: "placeholder",
    file: F_SVC,
    tag: "placeholder",
    needle: `    const visible = (hostKind === "matter" ? visibleMatter : visibleRisk).has(String(r.hostId));`,
    replacement: `    const visible = true;`,
  },
  "unread-all": {
    mode: "unread-all",
    file: F_SVC,
    tag: "unread-all",
    needle: `        or(
          and(
            sql\`\${notificationEvent.targetType} like 'matter%'\`,`,
    replacement: `        or(
          sql\`true\`,
          and(
            sql\`\${notificationEvent.targetType} like 'matter%'\`,`,
  },
  "outbox-early": {
    mode: "outbox-early",
    file: F_SVC,
    tag: "outbox-early",
    needle: `  await tx.insert(eventOutbox).values({
    id: BigInt(nextId()),
    eventType: "comment_added",`,
    replacement: `  await tx.insert(eventOutbox).values({
    id: BigInt(nextId()),
    publishedAt: new Date().toISOString(),
    eventType: "comment_added",`,
  },
};

/** 脚本里写的是**转义过**的串（`\`` 与 `\$`），读回源码时要还原 */
function unescapeNeedle(s) {
  return s.replace(/\\`/g, "`").replace(/\\\$/g, "$");
}

const modes = [...new Set(Object.values(ANCHORS).map((a) => a.mode))];
const mode = process.argv[2] ?? "";

if (mode === "" || mode === "list") {
  console.log("可用模式（用法：node agent-work/revred-notifications.mjs <mode>）：\n");
  for (const m of modes) {
    const entries = Object.values(ANCHORS).filter((a) => a.mode === m);
    console.log(`  ${m}`);
    for (const e of entries) console.log(`      · ${e.file}  (${e.tag})`);
  }
  console.log("\n还原：node agent-work/revred-notifications.mjs restore   ← 别用 git checkout");
  process.exit(0);
}

const backupOf = (file) => `${file}.revred-notifications.bak`;

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
        `先跑 \`node agent-work/revred-notifications.mjs restore\`，再注入。`,
    );
    process.exit(2);
  }
}

// 先全部校验命中次数，一处不合格就整体不动（免得留下半注入状态）
const plan = [];
for (const e of entries) {
  const src = readFileSync(e.file, "utf8");
  const needle = unescapeNeedle(e.needle);
  const hits = src.split(needle).length - 1;
  if (hits !== 1) {
    console.error(
      `锚点 ${e.tag} 在 ${e.file} 命中 ${hits} 次（要恰好 1）—— 注入点失效，请对照当前实现改本脚本。\n` +
        `（先跑 \`node agent-work/verify-anchors.mjs\` 可以不用数据库就发现这一类腐化）`,
    );
    process.exit(2);
  }
  plan.push({ ...e, src, needle, at: src.indexOf(needle) });
}

for (const f of files) writeFileSync(backupOf(f), readFileSync(f, "utf8"), "utf8");

/**
 * ⚠ **按文件分组、组内降序应用** —— 不能逐条拿同一份快照去 `slice` 拼接。
 *
 * 原先的写法是每条都用规划阶段读到的 `p.src`：
 *
 *     for (const p of plan) writeFileSync(p.file, p.src.slice(0, p.at) + 替换 + p.src.slice(...));
 *
 * 于是**同一文件有 2 个锚点时，后一次写会把前一次的注入整段抹掉** —— 第二个锚点生效，
 * 第一个**看起来"已注入"其实没有**（脚本照样打印"已注入 xxx"）。
 *
 * 这个缺陷的后果不是"注入失败"，是**门禁撒谎**：`archived-notify` 的两个锚点同在
 * `services/notifications.ts`，实测只有评论那个生效，而它要钉的 AC 7 头号断言
 * 「归档这一步本身不发通知」**在有注入和无注入两种情况下都是绿的** ——
 * 也就是**从未被反向红钉过**。检查子代理手工注入才证明那条断言其实是灵敏的。
 *
 * 修法：① 一个文件只写一次（把该文件的所有替换都作用到同一个缓冲区上）；
 * ② 组内**按位置降序**应用 —— 从后往前改，前面锚点的偏移才不会失效；
 * ③ 每条都**在缓冲区里重新定位**，而不是复用规划阶段的偏移。
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
    buf = buf.slice(0, at) + unescapeNeedle(p.replacement) + buf.slice(at + p.needle.length);
    console.log(`已注入 ${p.tag} → ${file}`);
  }
  writeFileSync(file, buf, "utf8");
}
// 自查：每条替换都必须在盘上出现，否则"已注入"是假的（上面那个缺陷正是这么骗人的）
for (const p of plan) {
  const onDisk = readFileSync(p.file, "utf8");
  if (!onDisk.includes(unescapeNeedle(p.replacement))) {
    console.error(`⚠ ${p.tag} 的替换没出现在盘上 —— 注入无效，请查本脚本的分组逻辑`);
    process.exit(2);
  }
}
console.log(
  `\n模式 ${mode} 注入完成（${plan.length} 处）。\n` +
    `  跑冒烟：node --env-file=.env agent-work/smoke-notifications.mjs   ⇒ 必须红\n` +
    `  还原：  node agent-work/revred-notifications.mjs restore          ← 别用 git checkout（会丢未提交的改动）`,
);
