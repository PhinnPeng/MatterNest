import { describe, expect, it } from "vitest";
import { SEMANTICS_RULES, STATUS_SEMANTICS } from "@/shared/enums/status";
import { referencingRules, semanticsSlotConflict, type RuleRef } from "./config";

/**
 * 三条硬约束的**纯判定**（`status-config.ts` 头注要求"要在服务层先判"）。
 *
 * ## 为什么只测纯函数，不测库
 *
 * 本仓没有离线可跑的库（`pnpm verify` 不许连真库，见票面验证纪律）。而三条约束真正
 * 容易写错的地方**不在"查库"那一半**，在"拿到别的行的语义之后怎么判"那一半：
 * `exactly-one` / `at-most-one` / `at-least-one` / `any` 四种上界，只有前两种有顶。
 * 把这一半抽成纯函数，就能在不连库的情况下把它钉死 —— 查库那一半（`semanticsOfHost`）
 * 只是把库里的行喂进来，写错会当场 23505，不会静默。
 *
 * ## 这一组断言的存在理由（真会写错的地方）
 *
 * 初版很容易写成"只要宿主里已经有一个 `closed` 就拒"——于是**改自己的语义**也被拒
 * （把 `pending` 从 `open` 换成... 不，`open` 也是 exactly-one）。
 * `exceptId` 参数就是为这条准备的：判槽位要**排除自己**，否则"把当前行改成它自己已经是的语义"
 * 会被误判成冲突。下面的第一条断言就钉它。
 */

describe("semanticsSlotConflict：只判有上界的语义", () => {
  it("exactly-one（open / archived）：宿主里已有同语义 → 冲突", () => {
    expect(semanticsSlotConflict("open", ["in_progress", "custom"])).toBe(false);
    expect(semanticsSlotConflict("open", ["open", "custom"])).toBe(true);
    expect(semanticsSlotConflict("archived", ["archived"])).toBe(true);
  });

  it("at-most-one（closed）：宿主里已有 → 冲突；这正对 ux_status_closed", () => {
    expect(semanticsSlotConflict("closed", ["open", "in_progress"])).toBe(false);
    expect(semanticsSlotConflict("closed", ["closed"])).toBe(true);
  });

  it("**at-least-one（in_progress）与 any（custom）没有上界** —— 多条并存合法", () => {
    // 这是最容易写错的一条：把 in_progress 也当成"每宿主一个"会拒掉合法的第二个进行中态，
    // 而 `SEMANTICS_RULES` 明写它是 `at-least-one`（下界，不是上界）。
    expect(SEMANTICS_RULES.in_progress.perHost).toBe("at-least-one");
    expect(semanticsSlotConflict("in_progress", ["in_progress", "in_progress"])).toBe(false);
    expect(SEMANTICS_RULES.custom.perHost).toBe("any");
    expect(semanticsSlotConflict("custom", ["custom", "custom", "custom"])).toBe(false);
  });

  it("判定跟着 SEMANTICS_RULES 走，不是服务里另抄一份 1/1/1", () => {
    // 遍历值域：有上界的语义在"已存在"时都该冲突，无上界的都不该。
    for (const s of STATUS_SEMANTICS) {
      const bound = SEMANTICS_RULES[s].perHost;
      const hasUpperBound = bound === "exactly-one" || bound === "at-most-one";
      expect(semanticsSlotConflict(s, [s]), `${s} 的判定与 SEMANTICS_RULES.${bound} 不一致`).toBe(
        hasUpperBound,
      );
    }
  });
});

describe("referencingRules：停用一个被规则引用的状态要能被点出来", () => {
  const rules: RuleRef[] = [
    { code: "preset_01_close_auto_archive", hostType: "all", statusCode: "closed" },
    { code: "preset_03_in_progress_create_node", hostType: "matter", statusCode: "in_progress" },
    { code: "preset_09_archive_incomplete_notify", hostType: "matter", statusCode: "closed" },
    { code: "preset_02_status_changed_notify", hostType: "all", statusCode: null },
  ];

  it("命中宿主相同或 `all` 的规则（规则表 host_type 有三个值，多一个 all）", () => {
    expect(referencingRules("closed", "matter", rules).sort()).toEqual([
      "preset_01_close_auto_archive",
      "preset_09_archive_incomplete_notify",
    ]);
    // 事项侧：只有 all 的那条命中（规则 3/9 是 matter 专属）
    expect(referencingRules("closed", "risk_matter", rules)).toEqual([
      "preset_01_close_auto_archive",
    ]);
    expect(referencingRules("in_progress", "matter", rules)).toEqual([
      "preset_03_in_progress_create_node",
    ]);
    // 事项侧不认案件专属规则 3 —— 否则停用事项的 in_progress 会被它误挡
    expect(referencingRules("in_progress", "risk_matter", rules)).toEqual([]);
  });

  it("没有 `status_code` 的规则（任意状态变更）不算引用", () => {
    // 规则 2 的 trigger_config 是空对象 = 任意状态变更；它不该让**任何**状态码变得不可停用，
    // 否则"任意状态变更"这条规则会把每一个状态都锁死。
    expect(rules.some((r) => r.statusCode === null)).toBe(true);
    expect(referencingRules("pending", "matter", rules)).toEqual([]);
  });
});
