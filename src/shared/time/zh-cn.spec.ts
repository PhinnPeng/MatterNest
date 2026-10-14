import dayjs from "dayjs";
import "dayjs/locale/zh-cn.js";
import { describe, expect, it } from "vitest";
import {
  DATE_COMPACT_PATTERN,
  DATE_DISPLAY_PATTERN,
  DEADLINE_COUNTDOWN_PATTERN,
  businessDateKey,
} from "./zh-cn";

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

/**
 * `businessDateKey` 自己的证据测试（2026-10-15，MATT-79）。
 *
 * ## 为什么它必须独立存在
 *
 * 此前这个 helper **一条断言都没有** —— 全仓对它的保护只来自三处调用点
 * 各自的注释。于是「业务日取成 UTC 日」这个错在**两个**地方各犯了一次：
 * 案件侧的 `closing_date`（MATT-69）与事项侧的 `discover_date`（MATT-79），
 * 两处同形、同因、同一个 helper。
 *
 * 调用点的测试护不住这件事：它证明的是「这一处写对了」，
 * 而 helper 自己的测试证明的是「这么写是对的」。后者才是别的调用点能依赖的东西。
 *
 * ## 形状照抄 `notification.spec.ts:149`
 *
 * **先把进程时区钉成 UTC，再断言**，而且**先断言反面**：
 * 少了前半句，这条用例在「TZ 没生效」时也会绿 —— 那是另一种空转。
 * 本仓对空转的门禁有真实戒心（`enum-check` 有五道「扫描器不是空转」的断言）。
 */
describe("businessDateKey：业务日必须是上海日，不是 UTC 日", () => {
  it("进程时区为 UTC 时仍给上海那一天（漏写 .tz() 会在这里红）", () => {
    const saved = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      // 这个瞬时 UTC 与上海**分属两天**：UTC 是 14 日 22:30，上海已是 15 日 06:30。
      // 用同一天的样本，这条用例分辨不出对错。
      const iso = "2026-10-14T22:30:00.000Z";

      // 前半句是**探针**：证明这个条件下两种写法真的分开了，否则后半句是空转
      expect(iso.slice(0, 10), "样本没有跨日 —— 这条用例会变成空转").toBe("2026-10-14");

      expect(businessDateKey(iso)).toBe("2026-10-15");
      expect(businessDateKey(new Date(iso))).toBe("2026-10-15");
    } finally {
      process.env.TZ = saved;
    }
  });

  it("上海 00:00–08:00 之间的瞬时归到**当天**，不是前一天", () => {
    // 上海 2026-10-15 01:30 = UTC 2026-10-14 17:30 —— 这正是那个窗口
    expect(businessDateKey("2026-10-14T17:30:00.000Z")).toBe("2026-10-15");
    // 边界：上海 08:00 整（= UTC 00:00）与 UTC 同日，是窗口的上沿
    expect(businessDateKey("2026-10-15T00:00:00.000Z")).toBe("2026-10-15");
    // 窗口下沿：上海 00:00 整（= UTC 前一天 16:00）
    expect(businessDateKey("2026-10-14T16:00:00.000Z")).toBe("2026-10-15");
  });
});
