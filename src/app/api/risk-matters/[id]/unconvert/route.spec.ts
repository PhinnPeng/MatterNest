import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 撤销转案件的冻结答复，说的必须是「**规则**」而不是「出错了」（MATT-81 / ADR-0005）。
 *
 * ## 背景：这个端点对任何事项都只会回 422 `frozen`
 *
 * 「有 `mn_risk_matter_case` 关联行」⇒ 必然 `conversion_status = 1` ⇒ 冻结门先命中，
 * 于是撤销 100% 不可用。2026-10-14 裁定保留端点并给出理由；2026-10-16 裁定**接受现状**，
 * 只补一件小事：**不可撤销是规则，不是故障**要写进拒绝文案。
 *
 * ## 为什么钉的是"那句话本身"
 *
 * 点撤销的人不是"想改点什么"，是"想退回去"。共享那句 `RISK_FROZEN_MESSAGE` 在回答
 * 「哪些字段不能再改、要去案件上做」—— 放在这里读起来像权限不够或系统出错，
 * 用户会去查权限、找经办人代劳、再试一次（代劳的人拿到的还是同一句）。
 *
 * 所以这里钉三件事：① 走专用文案不是共享那句；② 专用文案点明了「规则 / 不是出错」并留了下一步；
 * ③ 仍然含「冻结」二字 —— `agent-work/smoke-convert.mjs` 靠这两个字把 `frozen` 与
 * 笼统的 `blocked` 分开（2026-10-14 裁定留下的可观测判据，改文案时别把它弄丢）。
 */
const route = readFileSync("src/app/api/risk-matters/[id]/unconvert/route.ts", "utf8");
const services = readFileSync("src/app/lib/server/services/risks.ts", "utf8");

/** 专用文案的正文（两段字符串拼起来，取到第一个分号为止 —— 文案里不写 `;`） */
const message =
  (/export const RISK_UNCONVERT_FROZEN_MESSAGE =([\s\S]*?);/.exec(services) ?? [])[1] ?? "";

describe("unconvert 的冻结答复：说「规则」，不说「出错了」", () => {
  it("走专用文案，而不是共享那句", () => {
    expect(
      route,
      "撤销没有走专用文案 —— 共享那句在这里像「权限不够 / 系统出错」，用户会去查权限、找经办人重试",
    ).toContain('return fail(422, "frozen", RISK_UNCONVERT_FROZEN_MESSAGE);');
    expect(
      route,
      "共享文案又回来了：它与「撤销的人想退回、不是想改点什么」不是同一个场景",
    ).not.toContain('return fail(422, "frozen", RISK_FROZEN_MESSAGE);');
  });

  it("专用文案点明「是规则，不是出错」，并留了下一步", () => {
    expect(message, "没写「规则」—— 用户会以为这是权限或系统故障").toContain("规则");
    expect(message, "没点明「不是出错」—— 这正是本票要补的那句话").toMatch(/不是出错/);
    expect(message, "只说了不能撤、没说接下来去哪 —— 用户会停在原地重试").toContain("案件上");
  });

  it("仍然含「冻结」二字（smoke 靠它把 frozen 与笼统的 blocked 分开）", () => {
    expect(message).toContain("冻结");
  });
});
