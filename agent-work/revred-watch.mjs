/**
 * 反向红工具（MATT-63 收藏 ⭐）—— **多模式**，三种，覆盖本票的三个风险面。
 *
 * 用法：
 *   node agent-work/revred-watch.mjs <visibility-gate|create-follow|create-follow-risk>
 *   node --env-file=.env agent-work/smoke-watch.mjs      # ⇒ 必须红（红的条数见下）
 *   node agent-work/revred-watch.mjs restore
 *   node --env-file=.env agent-work/smoke-watch.mjs      # ⇒ 必须绿
 *
 * | mode | 注入的缺陷 | 期望变红的断言 |
 * |---|---|---|
 * | `visibility-gate` | `hostVisible` **恒返回 true** | 看不见的记录也收藏得动 ⇒ 2 条 |
 * | `create-follow` | 摘掉**案件侧创建路径**的 `syncFollowWatch` | 案件侧创建期 follow 行 1 条 |
 * | `create-follow-risk` | 摘掉**事项侧创建路径**的 `syncFollowWatch` | 创建期 follow 行 1 条 |
 *
 * ## 为什么加后两个（2026-10-17 复审补）
 *
 * 初版只有 `visibility-gate`，而票面的完成判据里也写着「加关注人时同步写
 * `user_watch(watch_type='follow')`」。实现却只给 `addMatterStaff`/`addRiskFollowers`
 * 补了同步，**创建路径（IQ-5/IQ-14 的 `followerIds`）漏了**——而初版冒烟只打
 * `POST /staff/followers`，所以整批断言全绿。**没有反向红的冒烟等于没有冒烟**：
 * 那一半从来没被钉过，正是这一条把它暴露出来的。
 *
 * ## 为什么"恒真"而不是删掉调用
 *
 * 删掉 `hostVisible` 会让 `actor` 参数悬空，tsc 当场报错——**红的是编译不是断言**，
 * 那是假证据（`revred-followers.mjs` 头注记过同一个教训）。同理，创建路径那两处
 * 只摘 `syncFollowWatch` 调用而**不摘 import**：两个文件都还有别的调用点
 * （`addMatterStaff` / `addRiskFollowers`），所以 import 仍被引用，编译干净。
 *
 * 认**缺陷**的签名：判据查注入标记**在不在**（照 `revred-t1.mjs` 的教训：
 * 判据要认缺陷的样貌，不是正确代码的样貌）。
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

const F_WATCH = "src/app/lib/server/services/watch.ts";
const F_MATTER = "src/app/lib/server/services/matters.ts";
const F_RISK = "src/app/lib/server/services/risks.ts";

const FILES = [F_WATCH, F_MATTER, F_RISK];
/** ⚠ 备份名带本工具与文件双重标识：曾与别的 revred 工具撞过同一个 `.bak`，
 *  两边同时注入时一方把另一方的注入提前还原 ⇒ **一次假绿**（`revred-import.mjs` 头注）。 */
const bakOf = (f) => `${f}.revred-watch.bak`;

const mode = process.argv[2];

if (mode === "restore" || process.argv[3] === "restore") {
  let n = 0;
  for (const f of FILES) {
    const b = bakOf(f);
    if (existsSync(b)) {
      writeFileSync(f, readFileSync(b, "utf8"), "utf8");
      unlinkSync(b);
      n++;
    }
  }
  console.log(n ? `已还原 ${n} 个文件` : "没有备份可还原");
  process.exit(0);
}

const NEEDLES = {
  "visibility-gate": {
    file: F_WATCH,
    tag: "watch-visibility-gate",
    /**
     * ⚠ 锚点必须唯一。只框住 `return Boolean(row);` 那一行连同它上面查询的最后一行
     * `.limit(1);`，而**不动**函数签名与注释（改签名会让编译红成别的样子）。
     *
     * ⚠ `void row;` 不是摆设：`noUnusedLocals: true` 下，把 `Boolean(row)` 换成 `true`
     * 会让 `row` 变成未使用局部量 ⇒ **TS6133 编译红**。编译红证明不了断言会红
     * （dev server 继续发旧产物，冒烟反而**假绿**），正是本工具头注警告的形态。
     * 本工具初版就漏了这一行，2026-10-17 复审对着 `tsc` 实测才发现。
     */
    needle: `    .where(scopedWhere(host, actor, eq(t.id, BigInt(hostId))))
    .limit(1);
  return Boolean(row);`,
    replacement: `    .where(scopedWhere(host, actor, eq(t.id, BigInt(hostId))))
    .limit(1);
  void row; // 反向红：让 row 仍被引用，红的是断言不是编译（noUnusedLocals）
  return true; // 反向红：可见性门恒放行 ⇒ 看不见也能收藏`,
  },
  "create-follow": {
    file: F_MATTER,
    tag: "no-create-follow",
    needle: `    await syncFollowWatch(tx, { host: "matter", hostId: id, userIds: followers, action: "add" });`,
    replacement: `    // 反向红：摘掉案件侧创建期的关注同步（名单写了、关注行没写）`,
  },
  "create-follow-risk": {
    file: F_RISK,
    tag: "no-create-follow-risk",
    needle: `    await syncFollowWatch(tx, {
      host: "risk_matter",
      hostId: id,
      userIds: followers,
      action: "add",
    });`,
    replacement: `    // 反向红：摘掉事项侧创建期的关注同步（名单写了、关注行没写）`,
  },
};

const spec = NEEDLES[mode];
if (!spec) {
  console.error(
    "用法：node agent-work/revred-watch.mjs <visibility-gate|create-follow|create-follow-risk> [restore]",
  );
  console.error(`可用模式：${Object.keys(NEEDLES).join(" | ")}`);
  process.exit(2);
}

const src = readFileSync(spec.file, "utf8");
const hits = src.split(spec.needle).length - 1;
if (hits !== 1) {
  console.error(`锚点命中 ${hits} 次（要恰好 1 次）—— 拒绝注入，避免拆错地方`);
  console.error(`  文件：${spec.file}`);
  process.exit(2);
}
const out = src.replace(spec.needle, spec.replacement);
if (out === src) {
  console.error("替换没有产生变化——拒绝写入");
  process.exit(2);
}

writeFileSync(bakOf(spec.file), src, "utf8");
writeFileSync(spec.file, out, "utf8");
console.log(`已注入缺陷 [${spec.tag}] 到 ${spec.file}，备份 ${bakOf(spec.file)}`);
