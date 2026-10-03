import { describe, expect, it } from "vitest";
import { needsChangeReason } from "./status-transition";

/**
 * 状态偏离判定（修订稿 §3.3 第 3 条）。
 *
 * 三条断言各自钉一种"写错也不会当场炸"的形态：
 *   1. 空推荐后继 = **不限制**（此时恒要原因，等于把配置表那列变成摆设，
 *      线上表现是"随便改个状态都要写说明"）；
 *   2. 进归档**恒要**原因，与当前态的后继列表无关（唯一出口是 `can_unarchive`）；
 *   3. 后继里含目标 = 走推荐路径，不要原因（判反了会把正常流转全拦下来）。
 */
const MATTER = { from: "in_progress", fromNextCodes: ["closed"], to: "closed" };

describe("needsChangeReason：什么时候必须填变更原因", () => {
  it("走推荐路径不要原因", () => {
    expect(needsChangeReason({ ...MATTER, toSemantics: "closed" })).toBe(false);
  });

  it("跳过推荐后继要原因（进行中直接归档）", () => {
    expect(
      needsChangeReason({
        from: "in_progress",
        fromNextCodes: ["closed"],
        to: "archived",
        toSemantics: "archived",
      }),
    ).toBe(true);
  });

  it("偏离但目标不是归档，同样要原因（待受理直接结案）", () => {
    expect(
      needsChangeReason({
        from: "pending",
        fromNextCodes: ["in_progress"],
        to: "closed",
        toSemantics: "closed",
      }),
    ).toBe(true);
  });

  it("没配推荐后继 = 不限制，不要原因", () => {
    expect(
      needsChangeReason({
        from: "mediation",
        fromNextCodes: [],
        to: "in_progress",
        toSemantics: "in_progress",
      }),
    ).toBe(false);
  });

  it("但进归档恒要，即使当前态没配后继", () => {
    expect(
      needsChangeReason({
        from: "mediation",
        fromNextCodes: [],
        to: "archived",
        toSemantics: "archived",
      }),
    ).toBe(true);
  });

  it("同态自己跳自己不在这里判（服务层先返回 unchanged）", () => {
    expect(
      needsChangeReason({
        from: "closed",
        fromNextCodes: ["archived"],
        to: "closed",
        toSemantics: "closed",
      }),
    ).toBe(false);
  });

  it("后继数组里混进 null 也不误判为命中", () => {
    expect(
      needsChangeReason({
        from: "pending",
        fromNextCodes: [null, "in_progress"],
        to: "closed",
        toSemantics: "closed",
      }),
    ).toBe(true);
  });
});
