import { describe, expect, it } from "vitest";
import { resolveClosingDate } from "./matters";
import { businessDateKey } from "@/shared/time/zh-cn";

/**
 * `closing_date` 的取值口径（MATT-69）。
 *
 * ## 为什么不测 `changeStatus` 本体
 *
 * 它一进去就连库、开事务，而 `pnpm verify` 的口径是离线可跑
 * （与 `risks.spec.ts` 里"为什么不测 `convertToCase` 本体"同一条理由）。
 * 所以判定被抽成 `resolveClosingDate`：逻辑与抽出来之前逐字相同，
 * 签名把"现在"作为**入参**——下面这些断言因此可以在不碰机器时钟的前提下钉住具体瞬时。
 *（改全局时钟的用例会与并行用例互相污染，而且一旦漏了 `useRealTimers` 就是一片假红。）
 *
 * ## 这一列错起来为什么是静默的
 *
 * `closing_date` 是 `date` 列、业务日语义的（"结案那天是哪天"），
 * 详情页「结案日期」与导出里都把它当纸面事实读。写成 UTC 日切片之后：
 * **上海 00:00–08:00 结案的案件落成前一天**，而用户当天点的就是"结案"——
 * 界面上没有任何东西提示它错了，差一天这件事只有对账才看得见。
 * 连带：规则 9 的 14 天原点取自这一列 ⇒ 那批案件提前一天收到"材料不全"提醒。
 */

/**
 * 夹具用的那个瞬时：`2026-10-13T17:30:00Z` = **上海 2026-10-14 01:30**。
 *
 * 选它是因为 UTC 与上海在这一刻**分属两天**（UTC 还是 13 号，上海已经 14 号了）。
 * 上海 08:00 之前提交都落在这个窗口里——用户体感是"凌晨补了个结案"。
 */
const SHANGHAI_LATE_NIGHT = "2026-10-13T17:30:00.000Z";

describe("结案日期取的是业务日（上海），不是 UTC 日", () => {
  it("先确认夹具本身有效：这个瞬时在 UTC 与上海确实不是同一天", () => {
    // 断言失败的话，下面那条红就没有意义了——它可能只是被一个"恰好同天"的夹具骗过去的。
    expect(SHANGHAI_LATE_NIGHT.slice(0, 10)).toBe("2026-10-13");
    expect(businessDateKey(SHANGHAI_LATE_NIGHT)).toBe("2026-10-14");
  });

  it("**上海凌晨 1:30 结案 ⇒ 结案日期是上海那一天**（UTC 切片会写成 10-13）", () => {
    const d = resolveClosingDate("closed", null, SHANGHAI_LATE_NIGHT);
    expect(d).toBe("2026-10-14");
  });

  it("反过来也钉住：白天的同一时刻，两种口径同值（防「这列其实无所谓」的自我宽慰）", () => {
    // 上海 10:30 ⇒ UTC 同为 10-13，两种算法一致；这一条让上面那条的"差异"有对照。
    expect(resolveClosingDate("closed", null, "2026-10-13T02:30:00.000Z")).toBe("2026-10-13");
  });

  it("上海 08:00 边界之上（08:00 整）已与 UTC 同日，边界之下才是分界点", () => {
    // 00:00 上海 = 前一天 16:00Z；08:00 上海 = 当天 00:00Z。这条钉住分界的**时刻**，
    // 而不是"大概是晚上"。
    expect(resolveClosingDate("closed", null, "2026-10-13T16:00:00.000Z")).toBe("2026-10-14");
    expect(resolveClosingDate("closed", null, "2026-10-14T00:00:00.000Z")).toBe("2026-10-14");
  });

  it("已有的结案日期不覆盖（重复进入 closed 仍是第一次那一天）", () => {
    expect(resolveClosingDate("closed", "2026-09-01", SHANGHAI_LATE_NIGHT)).toBe("2026-09-01");
  });
});

describe("其余两个分支不受影响（MATT-42 踩过的坑不许回来）", () => {
  it("归档语义**保留**结案日期（`closed → archived` 命中它）", () => {
    expect(resolveClosingDate("archived", "2026-09-01", SHANGHAI_LATE_NIGHT)).toBe("2026-09-01");
  });

  it("离开 closed 且不是归档 ⇒ 清空", () => {
    expect(resolveClosingDate("in_progress", "2026-09-01", SHANGHAI_LATE_NIGHT)).toBeNull();
    expect(resolveClosingDate("custom", "2026-09-01", SHANGHAI_LATE_NIGHT)).toBeNull();
  });
});
