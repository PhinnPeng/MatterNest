/**
 * 反向红工具（MATT-49 选人面与写路径）。
 *
 * 用法：node agent-work/revred-staff.mjs <narrow|create-guard> [restore]
 *
 *  · `narrow` —— 摘掉 `addMatterStaff` 里"被加者必须落在可见用户集内"那道判定。
 *    期望红：**恰好 1 条** —— `不在可见集内的人 → 422 not_selectable`（会变成 200）。
 *    **为什么必须红这条**：票面把「收窄落在写路径，不只在下拉」写成了硬要求，而这条
 *    正是它。只收窄下拉是装饰——任何看得见这条案件的人，直接 POST 一个任意 userId
 *    就能绕过，那等于 §4.1 的收窄根本没生效。而界面上完全看不出来：下拉里没有他，
 *    请求里可以有他。
 *
 *  · `create-guard` —— 摘掉**案件侧**创建路径的 `assertAssignable`。
 *    期望红：**1 条** —— `建案时指定停用账号为负责人 → 422`（会变成 201）。
 *    **为什么必须红**：创建表单走的是 IQ-14 的创建期例外（放开到全体在册用户），
 *    所以它**没有共现收窄**——"在册可用"就成了这条路上唯一的门。没有下拉能约束一个
 *    直接构造的 POST，判定必须在服务层真的跑一遍。
 *
 *  · `create-guard-risk` —— 摘掉**事项侧**创建路径的同一次调用。
 *    期望红：**1 条** —— `建事项时指定软删账号为负责人 → 422`。
 *    两侧各验一次不是重复：它们是**两处独立的调用**（`assertAssignable` 是共享判定，
 *    但"有没有人调它"是每侧各自的事）。摘掉案件侧那次时事项侧那条照样绿，
 *    正好证明了这一点——否则"两侧都守住了"只能靠读代码相信。
 *
 * ## 一个**被删掉**的模式：`assignable`（写给后来的人）
 *
 * 它原先指向 `addMatterStaff` 里单独的 `findUnassignable` 调用，但**它红不了**：
 * 那条路上的 `listSelectableUsers` 本身就带"在册可用"三条件，摘掉那个调用之后
 * 三条"不得被指派"断言照样绿。第一次跑出来是编译红（TS6133 未使用导入），
 * 修成可编译之后仍然全绿——**那不是测试写得不好，是那个调用冗余**。
 * 于是它被删了（见 `matters.ts` 门 4 的注释），反向红改指创建路径。
 * 教训：反向红"红不了"有时是在告诉你**这段代码本来就没人依赖**，别急着改测试。
 *
 * ⚠ 还原后别立刻跑冒烟：`next dev` 热更新有窗口（revred-convert 那轮踩过）。
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

const F = "src/app/lib/server/services/matters.ts";
const F_RISK = "src/app/lib/server/services/risks.ts";
const BAK = `${F}.revred.bak`;
const BAK_RISK = `${F_RISK}.revred.bak`;
const mode = process.argv[2];

if (mode === "restore" || process.argv[3] === "restore") {
  let n = 0;
  for (const [f, b] of [
    [F, BAK],
    [F_RISK, BAK_RISK],
  ]) {
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
  narrow: {
    file: F,
    needle: `  const allowed = new Set(selectable.map((u) => u.id));
  const outside = userIds.filter((u) => !allowed.has(u));`,
    replacement: `  // 反向红：摘掉"被加者必须落在可见用户集内"（只收窄下拉的形态）
  const allowed = new Set(selectable.map((u) => u.id));
  void allowed;
  const outside: string[] = [];`,
    tag: "no-narrowing",
  },
  "create-guard": {
    // ⚠ `void assertAssignable;` 让 import 仍被引用 —— 否则 TS6133 会把红变成**编译红**，
    //   而编译红证明不了断言会红：编译失败时 dev server 继续发旧产物，冒烟会**假绿**。
    //   （本轮实测过一次：assignable 模式第一次跑就是编译红 + 28/0 全绿。）
    file: F,
    needle: `  await assertAssignable([String(owner)]);`,
    replacement: `  // 反向红：摘掉创建路径的"被指派者必须在册可用"
  void assertAssignable;`,
    tag: "no-create-guard",
  },
  "create-guard-risk": {
    file: F_RISK,
    needle: `  await assertAssignable([owner === null ? null : String(owner)]);`,
    replacement: `  // 反向红：摘掉事项侧创建路径的"被指派者必须在册可用"
  void assertAssignable;`,
    tag: "no-create-guard-risk",
  },
};

const spec = NEEDLES[mode];
if (!spec) {
  console.error(
    "用法：node agent-work/revred-staff.mjs <narrow|create-guard|create-guard-risk> [restore]",
  );
  process.exit(2);
}

const target = spec.file ?? F;
const bak = target === F ? BAK : BAK_RISK;
const src = readFileSync(target, "utf8");
const hits = src.split(spec.needle).length - 1;
if (hits !== 1) {
  console.error(`锚点命中 ${hits} 次（要恰好 1 次）—— 拒绝注入，避免拆错地方`);
  process.exit(2);
}
writeFileSync(bak, src, "utf8");
writeFileSync(target, src.replace(spec.needle, spec.replacement), "utf8");
console.log(`已注入缺陷 [${spec.tag}] 到 ${target}`);
