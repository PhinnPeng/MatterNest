import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { decideStatusChange, type StatusChangeFacts } from "./status-change";

/**
 * 状态变更的**判决**：顺序 + 三档审计动作。
 *
 * ## 为什么测这个函数而不是 `changeHostStatus`
 *
 * `changeHostStatus` 一进去就连库、开事务，而 `pnpm verify` 的口径是**离线可跑**。
 * 判决被单独抽出来正是为了这一条：事实喂进去、结论拿出来，不需要库。
 * （与 `matters.spec.ts` 为什么只测 `resolveClosingDate` 同一个理由。）
 *
 * ## 这一组替代了什么
 *
 * `risks.spec.ts` 过去把 `risks.ts` **当源码字符串读**，用"冻结门出现在 `ownsAttribution(`
 * 之前"来钉顺序。那条断言在 2026-10-24 之后不再成立（门搬到了这里），而它本来就只是
 * 顺序的**近似**：它读得到位置，读不到"被跳过会怎样"。下面每一条都直接问结论。
 */

const 正常: StatusChangeFacts = {
  visible: true,
  frozen: false,
  isArchived: false,
  ownerAllowed: true,
  from: "in_progress",
  to: "closed",
  targetSemantics: "closed",
  // 顺着推荐路径走：`closed` 就在 `in_progress` 的 next 里
  fromNextCodes: ["closed"],
  hasReason: false,
};

describe("decideStatusChange：顺序", () => {
  it("不可见 → not_found（哪怕同时冻结、同时越权 —— 元规则 3 不给探测者信号）", () => {
    expect(
      decideStatusChange({
        ...正常,
        visible: false,
        frozen: true,
        ownerAllowed: false,
        isArchived: true,
      }),
    ).toEqual({ ok: false, why: "not_found" });
  });

  it('冻结排在归属**之前**：冻结的事项说"因为已冻结"，不说"你不是经办人"', () => {
    expect(decideStatusChange({ ...正常, frozen: true, ownerAllowed: false })).toEqual({
      ok: false,
      why: "frozen",
    });
  });

  it('冻结也排在"没变"之前：状态没变不构成放行冻结的理由', () => {
    expect(decideStatusChange({ ...正常, frozen: true, from: "closed", to: "closed" })).toEqual({
      ok: false,
      why: "frozen",
    });
  });

  it('归属排在"没变"之前', () => {
    expect(decideStatusChange({ ...正常, ownerAllowed: false, to: "in_progress" })).toEqual({
      ok: false,
      why: "forbidden",
    });
  });

  it("目标与现状相同 → unchanged（正常结局，不是错）", () => {
    expect(decideStatusChange({ ...正常, to: "in_progress" })).toEqual({
      ok: false,
      why: "unchanged",
    });
  });

  it('目标状态查不到 → not_found（与"这条不存在"同话术）', () => {
    expect(decideStatusChange({ ...正常, to: "nope", targetSemantics: null })).toEqual({
      ok: false,
      why: "not_found",
    });
  });

  it('原因判定排在最后：越权的人先听到"你不是经办人"，而不是"请填原因"', () => {
    expect(
      decideStatusChange({
        ...正常,
        ownerAllowed: false,
        to: "archived",
        targetSemantics: "archived",
        hasReason: false,
      }),
    ).toEqual({ ok: false, why: "forbidden" });
  });
});

describe("decideStatusChange：什么时候必须填原因", () => {
  it("顺着推荐路径 → 不要原因", () => {
    expect(decideStatusChange(正常)).toMatchObject({ ok: true });
  });

  it("偏离推荐路径 → 要原因", () => {
    expect(
      decideStatusChange({
        ...正常,
        from: "in_progress",
        to: "archived",
        targetSemantics: "archived",
        fromNextCodes: ["closed"],
      }),
    ).toEqual({ ok: false, why: "reason_required" });
  });

  it("进归档**恒要**原因，哪怕它就在推荐路径上（`needsChangeReason` 的第一条）", () => {
    expect(
      decideStatusChange({
        ...正常,
        to: "archived",
        targetSemantics: "archived",
        fromNextCodes: ["archived"],
      }),
    ).toEqual({ ok: false, why: "reason_required" });
  });

  it('撤销归档恒要原因 —— 不受"是否偏离推荐路径"影响（MATT-60 补的那个空洞）', () => {
    // 顺着推荐路径撤归档（`archived` 的 next 里恰好有目标）在过去一个原因都不要，
    // 而它需要特权、几乎不可逆。这一条就是那个洞的可执行形式。
    expect(
      decideStatusChange({
        ...正常,
        from: "archived",
        to: "in_progress",
        isArchived: true,
        targetSemantics: "in_progress",
        fromNextCodes: ["in_progress"],
        hasReason: false,
      }),
    ).toEqual({ ok: false, why: "reason_required" });
  });

  it("撤销归档带了原因 → 放行", () => {
    expect(
      decideStatusChange({
        ...正常,
        from: "archived",
        to: "in_progress",
        isArchived: true,
        targetSemantics: "in_progress",
        hasReason: true,
      }),
    ).toMatchObject({ ok: true, unarchiving: true });
  });
});

describe("三档审计动作", () => {
  it("进归档 → ARCHIVED", () => {
    expect(
      decideStatusChange({
        ...正常,
        to: "archived",
        targetSemantics: "archived",
        hasReason: true,
      }),
    ).toMatchObject({ ok: true, archiving: true, unarchiving: false, action: "ARCHIVED" });
  });

  it('撤销归档 → UNARCHIVED（不是 STATUS_CHANGED —— 否则审计按动作名筛不出"谁撤的"）', () => {
    expect(
      decideStatusChange({
        ...正常,
        from: "archived",
        to: "closed",
        isArchived: true,
        targetSemantics: "closed",
        hasReason: true,
      }),
    ).toMatchObject({ ok: true, archiving: false, unarchiving: true, action: "UNARCHIVED" });
  });

  it("普通流转 → STATUS_CHANGED", () => {
    expect(decideStatusChange(正常)).toMatchObject({ action: "STATUS_CHANGED" });
  });
});

describe("策略表：两个宿主只差在这一个文件里", () => {
  const policySrc = readFileSync("src/app/lib/server/services/host-status-policy.ts", "utf8");

  it("事项侧接的是 isRiskFrozen，案件侧恒 false（冻结是事项的属性，ADR-0005）", () => {
    // 这条接替了退役的 `revred-unarchive` 模式 `risk-side-missed`（那次模拟「只改一侧」）。
    // 两侧现在共用一段实现，缺口不可能再出在"漏改另一侧"，只可能出在策略表写错。
    expect(policySrc).toContain("frozen: (row) => isRiskFrozen(row.conversionStatus)");
    expect(policySrc).toContain("frozen: () => false");
  });

  it("事项侧没有结案日期、也没有归档就绪（不要兜空判定）", () => {
    expect(policySrc).toContain("closingDate: () => null");
    expect(policySrc).toContain("readiness: async () => null");
  });

  it("结案自动归档只挂在案件侧，事项侧是空实现", () => {
    expect(policySrc).toContain("await applyCloseAutoArchive(tx,");
    const risk = policySrc.slice(policySrc.indexOf("const riskMatterPolicy"));
    expect(risk, "事项侧接了自动归档 —— 那会越过 ADR/rule-admin 的「对事项显式跳过」").toContain(
      "async afterStatusWritten() {}",
    );
  });
});

describe("模块本身：宿主只当参数", () => {
  const src = readFileSync("src/app/lib/server/services/status-change.ts", "utf8");

  it("模块里没有按宿主分支 —— 差异全在 host-status-policy", () => {
    // 这条守的是 Q2 的裁定：写成 `if (host === ...)` 会让这个文件长成第二个
    // `exportHostFile`，且下一个宿主会继承一门它不该有的冻结门。
    expect(src).not.toMatch(/host\s*===\s*["']matter["']/);
    expect(src).not.toMatch(/host\s*===\s*["']risk_matter["']/);
  });

  it("判决是纯的：`decideStatusChange` 里不出现库与事务", () => {
    const start = src.indexOf("export function decideStatusChange");
    const end = src.indexOf("\nexport async function changeHostStatus");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    for (const forbidden of ["getDb(", "transaction(", "logActivity(", "notifyStatusChanged("]) {
      expect(body, `判决里出现了 ${forbidden} —— 它就不再是测试面了`).not.toContain(forbidden);
    }
  });

  it("解析器没空转：改款/服务仍在原处（否则上面两条恒真）", () => {
    expect(src).toContain("export function decideStatusChange");
    expect(src).toContain("export async function changeHostStatus");
    expect(src).toContain("reason_required");
  });
});
