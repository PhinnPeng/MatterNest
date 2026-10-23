import { describe, expect, it } from "vitest";

import { initialRemindDays, NODE_REMIND_DEFAULT } from "./node-reminder";

/**
 * 新增节点时的提醒档位（2026-10-23 用户规则）：
 * 「若时间节点是 n 天内，默认已触发规则，仅触发 n 为 1 的规则」。
 */
const NOW = new Date("2026-10-23T09:00:00.000Z");

describe("initialRemindDays", () => {
  it("超过窗口的节点吃全档 7 / 3 / 1", () => {
    expect(initialRemindDays("2026-11-10T09:00:00.000Z", NOW)).toEqual([...NODE_REMIND_DEFAULT]);
  });

  it("窗口内（含边界）只留最近一档", () => {
    expect(initialRemindDays("2026-10-26T09:00:00.000Z", NOW)).toEqual([1]); // 3 天后
    expect(initialRemindDays("2026-10-30T09:00:00.000Z", NOW)).toEqual([1]); // 7 天后（边界）
  });

  it("已过期也只留最近一档（不补发 7/3 的历史）", () => {
    expect(initialRemindDays("2026-10-20T09:00:00.000Z", NOW)).toEqual([1]);
  });

  it("没有时间：档位原样保留，等填时间时再收", () => {
    expect(initialRemindDays(null, NOW)).toEqual([...NODE_REMIND_DEFAULT]);
    expect(initialRemindDays(null, NOW, [3, 1])).toEqual([3, 1]);
  });

  it("配置里没有 1 天档：留最小的那一档，不硬塞 1", () => {
    expect(initialRemindDays("2026-10-26T09:00:00.000Z", NOW, [3, 2])).toEqual([2]);
  });

  it("配置为空：不提醒（这是配置的明确表达，不是漏填）", () => {
    expect(initialRemindDays("2026-10-26T09:00:00.000Z", NOW, [])).toEqual([]);
  });
});
