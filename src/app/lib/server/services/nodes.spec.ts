import { describe, expect, it } from "vitest";
import { NODE_REMIND_DEFAULT, planPresetNodes, type PresetNodeTypeRow } from "./nodes";

/** 造一条节点类型配置，只关心 P1 用得上的那几列 */
function typeRow(
  over: Partial<PresetNodeTypeRow> & { id: bigint; name: string },
): PresetNodeTypeRow {
  return {
    code: over.name,
    timeType: "point",
    presetOnCreate: true,
    isEnabled: true,
    defaultRemindDays: [7, 3, 1],
    sortOrder: 0,
    ...over,
  };
}

/**
 * P1 预设节点生成（修订稿 §4）。四件事都是"跑一次才看得出来"的形态，所以逐条钉：
 *   · 顺序取 `sort_order` 而**不是传入顺序** —— 服务层那边有 `ORDER BY`，
 *     但这一层的判定也必须成立，否则哪天有人去掉 `ORDER BY` 就直接乱序；
 *   · `preset_on_create=false` 与 `is_enabled=false` 都不生成（后者漏判会把运营
 *     停用的类型继续塞进新案卷，而配置页上看不见它）；
 *   · 写入序号从 1 连续（详情页时间线按它排，留空洞会歪）；
 *   · 提醒天数只在配置为空时才回落到 `{7,3,1}`。
 */
describe("planPresetNodes：建案时生成哪些默认节点", () => {
  it("按 sort_order 排，不按传入顺序", () => {
    const planned = planPresetNodes([
      typeRow({ id: 3n, name: "开庭", sortOrder: 3 }),
      typeRow({ id: 1n, name: "立案", sortOrder: 1 }),
      typeRow({ id: 2n, name: "举证", sortOrder: 2, timeType: "range" }),
    ]);
    // 断言整体形状而不是逐条下标：`noUncheckedIndexedAccess` 下 `planned[1]` 是 `| undefined`，
    // 逐条下标的写法要么撒 `!` 要么把"少了元素"这种失败伪装成类型噪音
    expect(planned.map((p) => [p.nodeTypeId, p.name, p.timeType, p.sortOrder])).toEqual([
      [1n, "立案", "point", 1],
      [2n, "举证", "range", 2],
      [3n, "开庭", "point", 3],
    ]);
  });

  it("preset_on_create=false 不生成（判决属 P2 规则模板）", () => {
    const planned = planPresetNodes([
      typeRow({ id: 1n, name: "立案" }),
      typeRow({ id: 4n, name: "判决", presetOnCreate: false }),
    ]);
    expect(planned.map((p) => p.name)).toEqual(["立案"]);
  });

  it("停用的类型不生成，即使它勾了预设", () => {
    expect(
      planPresetNodes([
        typeRow({ id: 1n, name: "立案" }),
        typeRow({ id: 2n, name: "举证", isEnabled: false }),
      ]).map((p) => p.name),
    ).toEqual(["立案"]);
  });

  it("提醒天数：配置给了就听配置的，为空才回落 {7,3,1}", () => {
    const planned = planPresetNodes([
      typeRow({ id: 4n, name: "判决", defaultRemindDays: [3, 1] }),
      typeRow({ id: 5n, name: "无配置", defaultRemindDays: [] }),
    ]);
    expect(planned.map((p) => p.remindDays)).toEqual([[3, 1], [...NODE_REMIND_DEFAULT]]);
    // 回落值必须是**拷贝**：直接把常量数组塞进 N 行节点，调用方一改就把默认值改了。
    // 这里用"改一份再看常量"来证，而不是比对象身份 —— 身份比较在 TS 眼里是
    // `number[]` 与 `readonly [7,3,1]` 两个无交集的类型，写成断言才能过编译，那是假代码。
    planned.find((p) => p.name === "无配置")?.remindDays.push(99);
    expect([...NODE_REMIND_DEFAULT]).toEqual([7, 3, 1]);
  });

  it("全部不勾选时给空数组，而不是造一条假节点", () => {
    expect(planPresetNodes([typeRow({ id: 1n, name: "立案", presetOnCreate: false })])).toEqual([]);
  });
});
