import { describe, expect, it } from "vitest";
import type { NotifyReceiver } from "@/shared/enums/automation";
import {
  decideNotifyRule,
  ruleCoversHost,
  statusChangedHits,
  type NotifyRuleRow,
} from "./rule-gate";

/**
 * 规则开关判定的**行为测试**。
 *
 * ## 这一档与 `rule-config.spec.ts` 那一档的分工
 *
 * 那边钉的是"读规则行这一层有没有把 `isEnabled` 带出来"（源码口径）；
 * 这边钉的是"拿到行之后**怎么判**"（行为）。两者缺一不可：读出来了但判反了，
 * 源码断言照样绿 —— 而那正是"开关是装饰"的第二形态。
 *
 * ## 为什么这一档能离线跑
 *
 * 判的那一半**不碰库**（纯函数），所以 `pnpm verify` 里跑得动。取数那一半
 * （`loadRuleByCode` / `loadEnabledRules`）写错会当场报错，不会静默 ——
 * 这是本仓把"判"与"取"分开的一贯理由（`judgeArchiveReminder`、`pickDueReminders` 同形）。
 *
 * ## 反向红（2026-10-18 实测，逐条）
 *
 * | 注入 | 期望 |
 * |---|---|
 * | `decideNotifyRule` 里删掉 `if (!rule.isEnabled)` 那一行 | 红 |
 * | `rule === null` 时改成 `fire: true` | 红 |
 * | `receiversOf` 里删掉已知档位过滤（照收未知值） | 红 |
 * | `statusChangedHits` 里"没写 status_code"改成不命中 | 红 |
 * | `ruleCoversHost` 里 `all` 改成只认具体值 | 红 |
 *
 * 全部实测过；还原后本节全绿。
 */

/** 造一条规则行。默认启用 —— 每个用例只写它关心的那一格 */
function row(over: Partial<NotifyRuleRow> = {}): NotifyRuleRow {
  return { isEnabled: true, actionConfig: {}, ...over };
}

describe("decideNotifyRule：读不到行 / 停用 ⇒ 不发", () => {
  it("**行缺失 ⇒ 不发**，理由与'停用'分开报（fail-closed）", () => {
    // 回落成"照发"会让"有人删了行"与"规则被停用"得到两种相反的结果
    expect(decideNotifyRule(null, ["owner"])).toEqual({ fire: false, why: "rule_missing" });
  });

  it("**停用 ⇒ 不发** —— 这一条就是 F5-10「可停用」的落点", () => {
    expect(decideNotifyRule(row({ isEnabled: false }), ["owner"])).toEqual({
      fire: false,
      why: "rule_disabled",
    });
  });

  it("启用 ⇒ 发", () => {
    const d = decideNotifyRule(row(), ["follower", "creator"]);
    expect(d.fire).toBe(true);
  });
});

describe("decideNotifyRule：收件人从规则行读（「可调参」的兑现方式）", () => {
  it("行里写了 `receivers` ⇒ **以行里的为准**，覆盖兜底", () => {
    const d = decideNotifyRule(row({ actionConfig: { receivers: ["owner"] } }), [
      "follower",
      "creator",
    ]);
    // 若这里回落到兜底，"可调参"就是假的
    expect(d).toEqual({ fire: true, receivers: ["owner"] });
  });

  it("行里**没有** `receivers` ⇒ 用兜底（规则 7 的形态：动作是 archive，没有通知侧可派生）", () => {
    const fallback: readonly NotifyReceiver[] = ["owner", "follower", "creator"];
    const d = decideNotifyRule(row({ actionConfig: {} }), fallback);
    expect(d).toEqual({ fire: true, receivers: fallback });
  });

  it("**含未知档位 ⇒ 过滤掉，不是照收**（照收会让通知静默消失）", () => {
    const d = decideNotifyRule(
      row({ actionConfig: { receivers: ["owner", "bogus", "follower"] } }),
      ["creator"],
    );
    // 未知值若被照收，它会一路走到 resolveRecipients 变成永远解析不出人的档位
    expect(d).toEqual({ fire: true, receivers: ["owner", "follower"] });
  });

  it("**全是不认识的值 / 空数组 ⇒ 回落兜底**，不退化成'谁也不发'", () => {
    // `receivers: []` 是"配坏了"；"谁也不发"的意思由 `isEnabled=false` 表达
    const fallback: readonly NotifyReceiver[] = ["owner"];
    expect(decideNotifyRule(row({ actionConfig: { receivers: [] } }), fallback)).toEqual({
      fire: true,
      receivers: fallback,
    });
    expect(
      decideNotifyRule(row({ actionConfig: { receivers: ["nope", "also_nope"] } }), fallback),
    ).toEqual({ fire: true, receivers: fallback });
  });

  it("`receivers` 不是数组（配成了字符串）⇒ 回落，不抛", () => {
    // 这条链路在业务事务里跑，抛错会把一次正常的状态变更整笔回滚
    expect(decideNotifyRule(row({ actionConfig: { receivers: "owner" } }), ["follower"])).toEqual({
      fire: true,
      receivers: ["follower"],
    });
  });

  it("`actionConfig` 整个缺了（不是对象）⇒ 回落，不炸", () => {
    const d = decideNotifyRule(
      { isEnabled: true, actionConfig: undefined as unknown as Record<string, unknown> },
      ["owner"],
    );
    expect(d).toEqual({ fire: true, receivers: ["owner"] });
  });
});

describe("statusChangedHits：规则 1 / 3 的触发命中", () => {
  it("`status_code` **没写** ⇒ 任意状态变更都命中（规则 2 的形态）", () => {
    // 判成不命中会让规则 2 永不触发 —— 而它是"件件有回音"的主回路
    expect(statusChangedHits("status_changed", {}, "closed")).toBe(true);
    expect(statusChangedHits("status_changed", { status_code: "" }, "closed")).toBe(true);
  });

  it("`status_code` 写了 ⇒ 只有恰好相等才命中（规则 1 / 3 的形态）", () => {
    expect(statusChangedHits("status_changed", { status_code: "closed" }, "closed")).toBe(true);
    expect(statusChangedHits("status_changed", { status_code: "closed" }, "in_progress")).toBe(
      false,
    );
  });

  it("**不是 `status_changed` 就不命中**（分发器只认这一种触发）", () => {
    // 规则 4/9 是 time_no_progress、规则 5/6 是 node_*、规则 7/8 是 event_occurred，
    // 都不该被状态变更唤起
    for (const t of [
      "time_no_progress",
      "node_before_start",
      "node_before_end",
      "event_occurred",
    ]) {
      expect(statusChangedHits(t, {}, "closed")).toBe(false);
    }
  });
});

describe("ruleCoversHost：`all` 是「两条宿主线都吃」", () => {
  it("`all` ⇒ 两个宿主都覆盖", () => {
    expect(ruleCoversHost("all", "matter")).toBe(true);
    expect(ruleCoversHost("all", "risk_matter")).toBe(true);
  });

  it("具体值只覆盖自己（规则 3/4/9 是 `matter`；规则 7 是 `risk_matter`）", () => {
    expect(ruleCoversHost("matter", "matter")).toBe(true);
    expect(ruleCoversHost("matter", "risk_matter")).toBe(false);
    expect(ruleCoversHost("risk_matter", "risk_matter")).toBe(true);
    expect(ruleCoversHost("risk_matter", "matter")).toBe(false);
  });
});
