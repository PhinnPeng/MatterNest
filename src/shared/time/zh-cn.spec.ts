import { format } from "date-fns";
import { describe, expect, it } from "vitest";
import {
  APP_LOCALE,
  DATE_COMPACT_PATTERN,
  DATE_DISPLAY_PATTERN,
  DEADLINE_COUNTDOWN_PATTERN,
} from "./zh-cn";

/**
 * 中文 locale 的证据测试（N1 的最后一项）。
 * 用**跨零点的绝对时刻**做样本，顺带把"会话/时区"这类漂移固定住：
 * 这里只断言格式化结果，不做时区换算——换算口径由 `shared/time` 的期限计算测试负责。
 */
const SAMPLE = new Date("2026-09-27T02:00:00+08:00");

describe("中文日期口径（date-fns zhCN）", () => {
  it("locale code 是 zh-CN", () => {
    expect(APP_LOCALE.code).toBe("zh-CN");
  });

  it("月份与星期出中文（日历表头用的就是这两条）", () => {
    expect(format(SAMPLE, "LLLL yyyy", { locale: APP_LOCALE })).toBe("九月 2026");
    expect(format(SAMPLE, "EEE", { locale: APP_LOCALE })).toBe("周日");
  });

  it("展示口径出中文年月日，紧凑口径保持 ISO 形状", () => {
    expect(format(SAMPLE, DATE_DISPLAY_PATTERN, { locale: APP_LOCALE })).toBe("2026年9月27日");
    expect(format(SAMPLE, DATE_COMPACT_PATTERN, { locale: APP_LOCALE })).toBe("2026-09-27");
    expect(format(SAMPLE, DEADLINE_COUNTDOWN_PATTERN, { locale: APP_LOCALE })).toMatch(
      /^2026年9月2\d日 \d\d:\d\d$/,
    );
  });

  it("⚠ date-fns 预设 P 不是中文习惯，所以展示禁止用 P（本条是防回退的锁）", () => {
    expect(format(SAMPLE, "P", { locale: APP_LOCALE })).not.toContain("年");
  });
});
