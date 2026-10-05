import { describe, expect, it } from "vitest";
import { canAddParticipant, ownsAttribution } from "./guards";

/**
 * 归属护栏（权限草案 §2.2）的单测盯的是**唯一那个反向**：
 * 「能看见」不等于「能改归属」。
 *
 * 这一类断言必须钉住的具体事故：L2/L3 的协办人把案子状态推走、甚至把负责人改成自己。
 * 所以"同一个人、同一条案件、换个 staff_role 判定就不同"要逐个跑一遍，
 * 不能只看"三种范围各一条"就以为覆盖到了。
 */
describe("guards/ownsAttribution：护栏 1 的主体判定", () => {
  const OWNER = "103";

  it("负责人本人可以改（L3 也行 —— 这是护栏 1 的第一句）", () => {
    expect(ownsAttribution({ userId: OWNER, dataScope: "owned" }, OWNER)).toBe(true);
  });

  it("L1 全局范围可以改别人的案子", () => {
    expect(ownsAttribution({ userId: "102", dataScope: "all" }, OWNER)).toBe(true);
  });

  it("L2 协办**不可以**改状态 —— 这条就是 §2.2 存在的理由", () => {
    expect(ownsAttribution({ userId: "104", dataScope: "participating" }, OWNER)).toBe(false);
  });

  it("L3 且非承办（只靠 created_by 看见）也不可以", () => {
    expect(ownsAttribution({ userId: "105", dataScope: "owned" }, OWNER)).toBe(false);
  });

  it("未知范围值按最窄处理，不 fallthrough 到 L1", () => {
    expect(
      ownsAttribution({ userId: "104", dataScope: "whatever" as "owned" }, BigInt(OWNER)),
    ).toBe(false);
  });

  it("`is_admin` 放行 —— 否则逃生口只看得到、动不了，等于没有", () => {
    expect(ownsAttribution({ userId: "105", dataScope: "owned", isAdmin: true }, OWNER)).toBe(true);
  });

  it("bigint 与 string 混用仍然相等（漏转的失败形态是负责人自己也改不动）", () => {
    expect(ownsAttribution({ userId: OWNER, dataScope: "owned" }, BigInt(OWNER))).toBe(true);
  });
});

describe("guards/canAddParticipant：§4.1 可见用户集收窄", () => {
  it("停用账号一律加不进来（先看 is_enabled 再看共现）", () => {
    expect(
      canAddParticipant({ userId: "103", dataScope: "all" }, "106", {
        targetEnabled: false,
        coOccurred: true,
      }),
    ).toBe(false);
  });

  it("L1 可以加全公司任何启用用户", () => {
    expect(canAddParticipant({ userId: "103", dataScope: "all" }, "105")).toBe(true);
  });

  it("L2/L3 只能加共现过的同事 —— 没共现就是加不进来", () => {
    const me = { userId: "103", dataScope: "owned" } as const;
    expect(canAddParticipant(me, "107", { coOccurred: false })).toBe(false);
    expect(canAddParticipant(me, "107", { coOccurred: true })).toBe(true);
  });

  it("把自己加进来永远允许（新入职自己先进自己的案子）", () => {
    expect(canAddParticipant({ userId: "104", dataScope: "owned" }, "104")).toBe(true);
  });
});
