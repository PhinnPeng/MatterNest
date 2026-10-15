/**
 * 漂移探测器：板上「票的状态」与仓库「代码的事实」之间的落差（MATT-1 目的地第 2 条）。
 *
 * ## 它防的是什么
 *
 * 板上曾长期挂着 9 张**已交付却没关**的票，且都带 `ready-for-agent`。
 * 而 **MATT-52「消掉做完了但没关」早已 Done** —— 说明这是**反复出现的失效形态**，
 * 一次性对账治不了。真正的治法是让落差**变得可见**，而不是指望有人记得对账。
 *
 * 后果不只是看板脏：一张已交付的票仍挂 `ready-for-agent`（= 规格齐全、可交给 agent），
 * **下一个 agent 会把它重做一遍**。
 *
 * ## 为什么「票侧」由外面喂进来
 *
 * 本仓明令 Paca 只经 MCP，REST 兜底路径已删除且**不应重建**
 * （`docs/agents/issue-tracker.md`：删它的直接原因是一个按标题 upsert 的脚本
 * 静默覆盖了 32 张卡的描述）。所以本工具**读不到票状态**。
 *
 * ⇒ 分工：**git 侧工具自己读**，**票侧由 agent 经 MCP 取来、作为快照文件喂进来**。
 * 它与 `db-check` / `lint-guard` 同形：**只读 + 打印，没有一个会改数据**，
 * 所以不需要任何写权限，任何人可跑。
 *
 * ## 为什么只分两段
 *
 * 两种漂移的**处置方向相反**：「未见带票号的提交」要排期，「做完没关」要关票。
 * 混在一张清单里，读者就得逐条自己判断属于哪种。
 *
 * ## ⚠ 曾有过第三段「可能只是收尾提交」，**已废止**
 *
 * 原设计：按「末次提交距今 ≥14 天」把近期的摘出去，理由是「票关掉之后仍有收尾
 * 提交，那一刻红是挡路」。
 *
 * 2026-10-15 真跑全板证伪：14 张已交付未关的票（当天交付）全被塞进第三段，
 * 而「做完没关」那段是 **0** —— 阈值恰好把要找的用例藏了起来。
 *
 * 根因是推理里的一个错：我以为「关票后的收尾提交」需要靠阈值来吸收，但代码里
 * `Done` 的票在循环开头就 `continue` 掉了 —— **那种噪音根本到不了分级**。
 * 阈值解决的是一个不存在的问题，代价是把真问题盖住。
 *
 * 现在只剩一条判据：**非 Done 且有带票号的提交 = 漂移**，没有例外。
 * 「末次提交多久」降级为显示列，只帮读者排优先级。
 *
 * ## canary（两维）
 *
 * 本仓对「扫到 0 处 ⇒ 看起来全绿」有真实戒心（禁令⑧/⑨/⑩ 各一条）。所以：
 *   · 票侧快照为空        ⇒ `ok=false`
 *   · git 侧一个 MATT 提交都没有 ⇒ `ok=false`
 *   · **快照里出现 git 没有的票** ⇒ `ok=false`（快照与仓库对不上，
 *     此刻任何结论都不可信，而工具自己看不出来）
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DAY = 86400000;

/**
 * 曾是「≥14 天才算做完没关」的阈值，**已废止**（见 gradeBoard 里的注释）。
 *
 * 保留这个名字只为让旧命令行不炸；它不再参与任何判定。
 */
export const STALE_DAYS = 14;

const DONE = "Done";

/**
 * 分级。纯函数，不碰文件系统也不碰 git —— 判据的全部价值在这里，可离线测。
 *
 * @param board  `{capturedAt, tickets: {"MATT-9": {status, title}}}`
 * @param commits `{"MATT-9": {lastCommitAt: ISO, count: number}}`
 * @returns `{notStarted, doneNotClosed, commitsNotInBoard, ok, reasons}`
 */
export function gradeBoard(board, commits, { now = Date.now() } = {}) {
  const tickets = board?.tickets ?? {};
  const notStarted = [];
  const doneNotClosed = [];

  for (const [ticket, info] of Object.entries(tickets)) {
    if (info.status === DONE) continue; // 关掉之后仍有提交是正常的
    const c = commits[ticket];
    if (!c) {
      notStarted.push({ ticket, status: info.status, title: info.title ?? "" });
      continue;
    }
    // ⚠ 这里**没有**按「末次提交多久」分档（2026-10-15 真数据推翻的）。
    //   原裁定是「≥14 天才算做完没关，更近的算收尾提交」—— 真跑全板时它把
    //   **恰好要报的那些票**（当天交付、当天没关）全塞进了「收尾」那一段。
    //   根因：以为「关票后的收尾提交」会造成噪音，但 `Done` 的票在循环开头就被
    //   `continue` 掉了 —— 那种噪音根本到不了分级。阈值解决的是一个不存在的问题。
    //   ageDays 保留为**显示列**（帮读者排优先级），不参与判定。
    doneNotClosed.push({
      ticket,
      status: info.status,
      title: info.title ?? "",
      lastCommitAt: c.lastCommitAt,
      ageDays: Math.floor((now - Date.parse(c.lastCommitAt)) / DAY),
      commitCount: c.count ?? 1,
    });
  }

  const commitsNotInBoard = Object.keys(commits)
    .filter((t) => !(t in tickets))
    .map((ticket) => ({ ticket, lastCommitAt: commits[ticket].lastCommitAt }));

  const reasons = [];
  if (Object.keys(tickets).length === 0) reasons.push("票侧快照为空 —— 无法判定");
  if (Object.keys(commits).length === 0)
    reasons.push("git 侧一个 MATT 提交都没有 —— 快照或日志有问题");
  if (commitsNotInBoard.length > 0) {
    reasons.push(
      `有 ${commitsNotInBoard.length} 张票出现在提交里却不在快照中（${commitsNotInBoard
        .map((x) => x.ticket)
        .join(" / ")}）—— 快照不完整，此刻任何结论都不可信`,
    );
  }

  return {
    notStarted,
    doneNotClosed,
    commitsNotInBoard,
    ok: reasons.length === 0,
    reasons,
  };
}

/**
 * git 侧：每张被提交信息提过的票，它的**末次**提交时间与次数。
 *
 * `--grep` 走的是提交信息，所以「代码事实」的口径是「有人在这张票上写过 commit」——
 * 它抓不到「改了代码但没在信息里写票号」，那是另一类缺口（也抓不到票被谁改了）。
 */
/**
 * git 侧：每张被**整条提交信息**提过的票，它的末次提交时间与次数。
 *
 * ## ⚠ 必须读 `%B`（含正文），不能只读 `%s`（标题行）
 *
 * `--grep` 搜的是**整条**消息，而只解析 `%s` 的话，「票号只写在正文里」的提交
 * 会被 grep 命中却提取不出来 ⇒ 那张票被判成「未见带票号的提交」。
 * 本仓实测踩过：6 张已交付的票全落进那一段，而 `--grep` 明明能找到它们。
 *
 * 正文是多行的，所以**记录**与**字段**要用两个不同分隔符：
 * 记录 `%x1e`（RS）、字段 `%x1f`（US）。
 *
 * ## ⚠ 时间取 `%cd`（提交者日期），不是 `%ad`（作者日期）
 *
 * 因为 `git log` 的排序依据就是提交者日期 —— 「倒序第一条即末次」这个推理
 * 只在同一个基准上成立。两者在 rebase / cherry-pick 之后会分叉，取错了会让
 * 「末次提交距今」偏向一条实际更早的提交，而它是读者排优先级的依据。
 */
export function readCommits(repoRoot = ".") {
  const out = spawnSync(
    "git",
    ["log", "--all", "--pretty=format:%cd%x1f%B%x1e", "--date=iso-strict", "--grep=MATT-"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (out.status !== 0) throw new Error(`git log 失败：${out.stderr?.trim() ?? "未知"}`);

  const byTicket = new Map();
  for (const rec of (out.stdout ?? "").split("\x1e")) {
    const rec_ = rec.replace(/^\r?\n/, "");
    if (!rec_.trim()) continue;
    const sep = rec_.indexOf("\x1f");
    if (sep < 0) continue;
    const at = rec_.slice(0, sep);
    const message = rec_.slice(sep + 1);
    if (!at || !message) continue;
    const firstLine = message.split("\n")[0].slice(0, 90);
    // `git log` 是倒序（最新在前）⇒ 先到的就是**末次**，之后只累加次数
    for (const ticket of new Set(message.match(/MATT-\d+/g) ?? [])) {
      const cur = byTicket.get(ticket);
      if (!cur) byTicket.set(ticket, { lastCommitAt: at, count: 1, subject: firstLine });
      else cur.count += 1;
    }
  }
  return Object.fromEntries(byTicket);
}

function readBoard(path) {
  // ⚠ 去掉 BOM：Windows 上 `Set-Content -Encoding UTF8` 会写 BOM，
  // 而 `JSON.parse` 见到 U+FEFF 直接抛「Unexpected token」。
  // 快照是**别人**（agent）生成的文件 —— 读它的那一侧必须比写它的那一侧宽容。
  const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

/* ── 入口 ──────────────────────────────────────────────────────────────── */

/**
 * 只有被**直接执行**时才跑 CLI。
 *
 * ⚠ 这不是形式：没有它时，`import { gradeBoard } from "./board-drift.mjs"`
 * 会在 import 期执行下面的 `process.exit(2)`，把 vitest 整个带崩
 * （"process.exit unexpectedly called"）。库不该在导入时改变进程状态。
 */
const isEntry =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (!isEntry) {
  // 被 import 时安静退出，什么都不做
} else {
  main();
}

function main() {
  const argv = process.argv.slice(2);
  const argOf = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };

  const boardPath = argOf("--board");
  if (!boardPath) {
    console.error(
      "用法：node tools/board-drift.mjs --board <快照.json> [--stale-days N] [--commits <提交.json>]\n" +
        '  快照由 agent 经 Paca MCP 取得后写成 {capturedAt, tickets:{"MATT-9":{status,title}}}；\n' +
        "  git 侧本工具自己读。全程只读，不写任何数据。",
    );
    process.exit(2);
    return;
  }

  let board;
  try {
    board = readBoard(boardPath);
  } catch (e) {
    console.error(`[FAIL] 读不到票侧快照 ${boardPath}：${e.message}`);
    process.exit(1);
    return;
  }

  // `--commits` 让 git 侧也可注入：默认读本仓 git history，注入时读一份 JSON。
  // 存在的理由不只是可测 —— 「比两个时点的板」也需要它（快照取自不同时间，提交列表固定）。
  let commits;
  try {
    commits = argOf("--commits") ? readBoard(argOf("--commits")) : readCommits();
  } catch (e) {
    console.error(`[FAIL] 读不到提交侧输入：${e.message}`);
    process.exit(1);
    return;
  }
  const result = gradeBoard(board, commits);

  // ⚠ 三段的行形状不同：第三段没有 status，第四段两者都没有。
  //   打印层必须对缺失字段容错 —— 否则「快照不完整」那一段自己先崩，
  //   而它恰恰是最该被看见的那一段。
  const cell = (v, w) => String(v ?? "").padEnd(w);
  const line = (t) =>
    `  ${cell(t.ticket, 12)} ${cell(t.status, 12)} ${t.title ?? ""}` +
    (t.ageDays === undefined ? "" : `   末次提交 ${t.ageDays} 天前`).trimEnd();

  console.log("板账漂移（只读诊断；处置动作一律由人做）");
  console.log(`  票侧快照：${boardPath}（取于 ${board.capturedAt ?? "未标注"}）`);
  console.log("  判据：非 Done 且有带票号的提交 ⇒ 漂移（无时间阈值）\n");

  const section = (title, rows, note) => {
    console.log(`▸ ${title}（${rows.length}）`);
    if (note) console.log(`  ${note}`);
    for (const t of rows) console.log(line(t));
    console.log("");
  };

  section(
    "未见带票号的提交（非 Done）",
    result.notStarted,
    "⚠ 这是**下界**：git 侧只能看见「提交信息里写了 MATT-nx」的提交，" +
      "所以「有提交、但票号没写进去」的票也落在这里。**处置前先排除这一种**，" +
      "否则会把已经做完的票拿去排期。确认没有漏写票号，再按「排期 / 判范围外后关闭」处置。",
  );
  section(
    "做完没关（非 Done，且有带票号的提交）",
    result.doneNotClosed,
    `处置：核对 AC 后关票；AC 无法独立复现的，在评论里写明「AC 未独立复现」`,
  );
  if (result.commitsNotInBoard.length > 0) {
    section("快照不包含的票（git 里有提交）", result.commitsNotInBoard, "处置：重取快照后重跑");
  }

  if (!result.ok) {
    console.error("[FAIL] canary 不通过 —— 本次输出不可当作结论：");
    for (const r of result.reasons) console.error(`  · ${r}`);
    process.exit(1);
    return;
  }

  const total = result.notStarted.length + result.doneNotClosed.length;
  console.log(total === 0 ? "没有漂移。" : `合计漂移 ${total} 张。`);
}
