/**
 * 反向红工具（MATT-45 批量低风险动作）。
 *
 * 用法：`node agent-work/revred-batch.mjs <mode>` → 注入缺陷 → 跑 `smoke-batch.mjs` 看红
 *       `node agent-work/revred-batch.mjs restore` → 还原全部备份
 *
 * 五个模式，每个都对着一条**票面要求**，而不是"随便改一处看会不会红"：
 *
 *  · `silent-exclusion` —— 把"不可见的行静默排除"改成"记进 skipped"。
 *    期望红：**2 条** ——「L3 提交 [自己的, L1 的]：成功 1、跳过 0」与
 *    「不可见那条的 id 不出现在响应里的任何位置」。
 *    **为什么必须红**：这是本票最容易做错的地方。`skipped` 是给用户看的"没做成的原因"，
 *    而"看不见"不是一种原因——报出来就等于用 `skipped.length` 回答了
 *    "你提交的 id 里有几个存在但你看不见"（元规则 3 的探测面）。
 *
 *  · `tag-scope` —— 摘掉 `batchTagMatters` 预读里的 `scopedWhere`。
 *    期望红：**2 条** ——「L3 提交 [看不见的 mC, 自己的 mA]：成功 1、跳过 0」（会变成 2）
 *    与「看不见的那条标签没被写」。
 *    **为什么是标签而不是改状态**：改状态/归档还有第二道边界（`changeStatus` 自己那次
 *    `scopedWhere`），摘掉这里的读只会让不可见的行"读得到但写不动"，最终仍被静默丢掉——
 *    **照样全绿**。标签动作的这次读就是唯一边界，所以它才是能红的那个。
 *    这条同时说明：`loadBatchRows` 的注释里那句"这张表不是安全边界"是**验证过的**，
 *    不是谦辞。
 *
 *  · `tag-scope-risk` —— 事项侧同一处（`loadRiskBatchRows`）。
 *    期望红：**2 条**（事项侧那条不可见标签断言 + 成功条数）。
 *    **两侧各验一次不是重复**：它们是两处独立的读（同构但各自写），
 *    摘掉案件侧那次时事项侧照样绿——`revred-staff.mjs` 记过同一条教训。
 *
 *  · `no-unarchive-guard` —— 摘掉"撤销归档要 `can_unarchive`"那道逐行判定。
 *    期望红：**2 条** ——「L3（无 can_unarchive）撤销归档 → 跳过 privilege_required」
 *    与「被跳过时它还是归档态」。
 *    **为什么必须红**：归档是"几乎不可逆"的动作，`can_unarchive` 是它唯一的出口
 *    （权限草案 §2.1）。批量路径漏掉这道判定，等于给每个能看见归档行的人开了一条
 *    批量撤销归档的后门——而单条路径还守着，只有对比着看才发现。
 *
 *  · `no-reason` —— 把归档原因的 `min(1)` 换成 `default("")`。
 *    期望红：**1 条** ——「归档不带原因 → 400」会变成 200（逐行 reason_required 跳过）。
 *    **为什么必须红**：枚举表 §3.2 把 `ARCHIVED` 列为原因必填。放服务层兜（而不是 schema）
 *    的代价是"用户空着提交、拿回一份'跳过 2 条'的摘要"，而摘要里那两条的原因
 *    是"这一步必须填原因"——一条本来能在表单上拦住的错误，变成了要读摘要才知道的失败。
 *    用 `.default("")` 而不是 `.optional()`：后者的输出类型变成 `string | undefined`，
 *    会先在服务层调用处编译红——**编译红证明不了断言会红**（revred-staff 记过：
 *    编译失败时 dev server 继续发旧产物，冒烟会假绿）。
 *
 * ⚠ 还原后别立刻跑冒烟：`next dev` 热更新有窗口（revred-convert 那轮踩过）。
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

const F_MATTERS = "src/app/lib/server/services/matters.ts";
const F_RISKS = "src/app/lib/server/services/risks.ts";
const F_SCHEMA = "src/shared/schema/batch.ts";

/**
 * 每个模式一个备份：一次只注入一个缺陷，但还原要能一次收干净。
 *
 * ⚠ 后缀是 **`.revred-batch.bak`**，不是通用的 `.revred.bak`：本仓同时有多个
 * revred 脚本（`revred-archive.mjs` 等），而它们的还原是"读自己的备份路径写回 + 删掉它"。
 * 两边撞同一个路径时，**别人的 restore 会把我的注入提前还原掉**——现场表现是
 * "注入成功、冒烟却全绿"，也就是一次假绿（本轮真的撞上过一次：注入后 tsc 干净，
 * 紧接着 restore 报"没有备份可还原"）。路径唯一是让这件事不可能发生的唯一办法。
 */
const BAK = {
  [F_MATTERS]: `${F_MATTERS}.revred-batch.bak`,
  [F_RISKS]: `${F_RISKS}.revred-batch.bak`,
  [F_SCHEMA]: `${F_SCHEMA}.revred-batch.bak`,
};

const mode = process.argv[2];

if (mode === "restore" || process.argv[3] === "restore") {
  let n = 0;
  for (const [f, b] of Object.entries(BAK)) {
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
  "silent-exclusion": {
    file: F_MATTERS,
    needle: `    // 不可见 / 已软删 / 不存在：**什么都不说**（三者并进同一条，正是元规则 3 的口径）
    if (!row) continue;`,
    replacement: `    // 反向红：把"看不见"当成一种跳过原因报出去（正是本票要防的探测面）
    if (!row) {
      skipped.push(skipRow(id, "forbidden"));
      continue;
    }`,
    tag: "invisible-reported",
  },
  "tag-scope": {
    file: F_MATTERS,
    needle: `  const uniq = [...new Set(ids)].map((i) => BigInt(i));
  const rows = await db
    .select({
      id: matter.id,
      status: matter.status,
      isArchived: matter.isArchived,
      tagIds: matter.tagIds,
    })
    .from(matter)
    .where(scopedWhere("matter", actor, inArray(matter.id, uniq)));`,
    // `void actor;` 不是装饰：摘掉 `scopedWhere` 之后这个参数就没人读了，
    // `noUnusedParameters` 会把它变成**编译红**——而编译红证明不了断言会红
    // （dev server 编译失败时继续发旧产物，冒烟会假绿）。revred-staff 记过这一条。
    replacement: `  const uniq = [...new Set(ids)].map((i) => BigInt(i));
  // 反向红：摘掉标签动作唯一的可见性边界
  void actor;
  const rows = await db
    .select({
      id: matter.id,
      status: matter.status,
      isArchived: matter.isArchived,
      tagIds: matter.tagIds,
    })
    .from(matter)
    .where(inArray(matter.id, uniq));`,
    tag: "no-scope-on-tag",
  },
  "tag-scope-risk": {
    file: F_RISKS,
    needle: `  const uniq = [...new Set(ids)].map((i) => BigInt(i));
  const rows = await db
    .select({
      id: riskMatter.id,
      status: riskMatter.status,
      isArchived: riskMatter.isArchived,
      tagIds: riskMatter.tagIds,
    })
    .from(riskMatter)
    .where(scopedWhere("risk_matter", actor, inArray(riskMatter.id, uniq)));`,
    replacement: `  const uniq = [...new Set(ids)].map((i) => BigInt(i));
  // 反向红：摘掉事项侧标签动作唯一的可见性边界（void actor 同案件侧那条理由）
  void actor;
  const rows = await db
    .select({
      id: riskMatter.id,
      status: riskMatter.status,
      isArchived: riskMatter.isArchived,
      tagIds: riskMatter.tagIds,
    })
    .from(riskMatter)
    .where(inArray(riskMatter.id, uniq));`,
    tag: "no-scope-on-tag-risk",
  },
  "no-unarchive-guard": {
    file: F_MATTERS,
    needle: `    if (row.isArchived && target.semantics !== "archived" && !actor.privileges.canUnarchive) {`,
    replacement: `    // 反向红：摘掉"撤销归档要 can_unarchive"（批量成了绕过特权的后门）
    if (row.isArchived && target.semantics !== "archived" && !true) {`,
    tag: "no-unarchive-guard",
  },
  "no-reason": {
    file: F_SCHEMA,
    needle: `    reason: z.string().trim().min(1, "归档必须填原因").max(500, "原因别超过 500 字"),`,
    replacement: `    // 反向红：归档原因改成选填（.default 而不是 .optional，避免先在调用处编译红）
    reason: z.string().trim().max(500, "原因别超过 500 字").default(""),`,
    tag: "archive-without-reason",
  },
};

const spec = NEEDLES[mode];
if (!spec) {
  console.error(
    "用法：node agent-work/revred-batch.mjs <silent-exclusion|tag-scope|tag-scope-risk|no-unarchive-guard|no-reason> [restore]",
  );
  process.exit(2);
}

const src = readFileSync(spec.file, "utf8");
const hits = src.split(spec.needle).length - 1;
if (hits !== 1) {
  console.error(`锚点命中 ${hits} 次（要恰好 1 次）—— 拒绝注入，避免拆错地方`);
  process.exit(2);
}
writeFileSync(BAK[spec.file], src, "utf8");
writeFileSync(spec.file, src.replace(spec.needle, spec.replacement), "utf8");
console.log(`已注入缺陷 [${spec.tag}] 到 ${spec.file}`);
