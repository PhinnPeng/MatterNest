import dayjs from "dayjs";
import "dayjs/locale/zh-cn.js";
import { describe, expect, it } from "vitest";
import { DATE_COMPACT_PATTERN, DATE_DISPLAY_PATTERN, DEADLINE_COUNTDOWN_PATTERN } from "./zh-cn";

/**
 * 中文日期口径的证据测试。
 *
 * 样本仍用**跨零点的绝对时刻**（`+08:00` 的 02:00），这样一旦有人把格式化改成按 UTC 解释，
 * 日期就会从 27 掉到 26，本文件当场红。
 *
 * 断言的是**产出串**而不是"用了哪个库"：本次从 date-fns 换到 dayjs（antd 只认 dayjs），
 * 口径一个字都不能变——所以这几条正好是换库的安全网。
 */
dayjs.locale("zh-cn");

const SAMPLE = dayjs("2026-09-27T02:00:00+08:00");

describe("中文日期口径（dayjs zh-cn）", () => {
  it("月份出中文（日历表头用的就是这条）", () => {
    expect(SAMPLE.format("MMMM YYYY")).toBe("九月 2026");
  });

  /**
   * 这条不是测功能，是**钉住一个踩过的坑**：dayjs 核心不认 `EEE`，
   * 原样吐 "EEE"。所以 `zh-cn.ts` 里不提供星期 pattern（曾照 date-fns 的习惯写了一个）。
   * 断言写成"格式串仍然吐字面量"，哪天有人升级 dayjs 让 `EEE` 生效了，这里会红，
   * 提示可以重新考虑要不要把星期文案收回 shared。
   * ⚠ 这里**不 import node:fs 去读源码文件**——`src/shared` 受禁令① 管，
   *    lint 当场拦了（这条是被门禁教出来的，不是事后想起来的）。
   */
  it("dayjs 不认 EEE，因此不在 shared 里放星期 pattern", () => {
    expect(SAMPLE.format("EEE")).toBe("EEE");
  });

  it("展示口径出中文年月日，紧凑口径保持 ISO 形状", () => {
    expect(SAMPLE.format(DATE_DISPLAY_PATTERN)).toBe("2026年9月27日");
    expect(SAMPLE.format(DATE_COMPACT_PATTERN)).toBe("2026-09-27");
    expect(SAMPLE.format(DEADLINE_COUNTDOWN_PATTERN)).toMatch(/^2026年9月2\d日 \d\d:\d\d$/);
  });

  it("⚠ 禁止用日期库的预设短格式当展示口径（date-fns 的 `P` → `26-09-27`，dayjs 的 `L` 同理）", () => {
    expect(SAMPLE.format("L")).not.toContain("年");
    expect(SAMPLE.format("LL")).not.toContain("年");
  });
});
