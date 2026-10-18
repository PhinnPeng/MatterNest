import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { hasExecutor, RULES_WITHOUT_EXECUTOR } from "./rule-admin";

/**
 * `rule-admin` 这一层的契约（P12 / F5-10，2026-10-18）。
 *
 * ## 为什么只钉这几条
 *
 * 本仓没有离线可跑的库（`pnpm verify` 不许连真库），所以 `listRules` / `updateRule`
 * 的库那一半写不出离线断言。而这一层**真正会静默出错**的地方是三件**源码口径**：
 *
 *   1. **没有执行体的规则名单**要与 probe 的结论一致 —— 名单错了，页面会把一个
 *      假开关画出来（正是本轮在消灭的形态）；
 *   2. **更新入参的字段集**必须窄（F5-10「不可改 trigger」要在**类型层**不可表达，
 *      而不是"传了也忽略"）；
 *   3. **`no_executor` 那道拒绝必须真的在**，且 `isEnabled: true` 时先于其他判断。
 *
 * 行为那一半（真的改一条规则、真的撞 409）由冒烟与真库验证承担。
 */
const SRC = readFileSync("src/app/lib/server/services/rule-admin.ts", "utf8");
const countOf = (needle: string) => SRC.split(needle).length - 1;

describe("没有执行体的规则名单", () => {
  it("**恰好两条**：规则 1（结案自动归档）与规则 3（进入进行中创建节点）", () => {
    // 与 `agent-work/probe-rule-executors.mjs` 的结论一致（2026-10-18：
    // 7 有效 / 0 装饰 / 2 无执行体）。执行体补上之后这里要同批改。
    expect([...RULES_WITHOUT_EXECUTOR]).toEqual([
      "preset_01_close_auto_archive",
      "preset_03_in_progress_create_node",
    ]);
  });

  it("`hasExecutor` 对名单内为 false、名单外为 true", () => {
    expect(hasExecutor("preset_01_close_auto_archive")).toBe(false);
    expect(hasExecutor("preset_03_in_progress_create_node")).toBe(false);
    expect(hasExecutor("preset_02_status_changed_notify")).toBe(true);
    expect(hasExecutor("preset_04_stale_30d_notify")).toBe(true);
  });

  it("名单与 probe 脚本用的是同一组 code（两处漂移会让页面与核对报告各说一套）", () => {
    const probe = readFileSync("agent-work/probe-rule-executors.mjs", "utf8");
    for (const code of RULES_WITHOUT_EXECUTOR) {
      expect(probe).toContain(code);
    }
  });
});

describe("F5-10 的三条边界落在哪一层", () => {
  it("更新入参**只有** `isEnabled` 与 `receivers`（改 trigger 在类型层不可表达）", () => {
    // 入参类型写在 `updateRule` 的签名里：`{ isEnabled?: boolean; receivers?: readonly string[] }`
    expect(SRC).toContain("input: { isEnabled?: boolean; receivers?: readonly string[] }");
  });

  it("**没有创建入口**（F5-8/F5-9 一期移出）：不导出 create*", () => {
    expect(SRC).not.toMatch(/export async function create/i);
  });

  it("**没有删除入口**（`is_system` 不可删）", () => {
    expect(SRC).not.toMatch(/export async function delete/i);
  });

  it("`no_executor` 拒绝发生在 `isEnabled === true` 上，且早于写库", () => {
    const at = SRC.indexOf("if (input.isEnabled === true && !hasExecutor(code))");
    expect(at, "找不到 no_executor 的判据 —— 假开关就会放行").toBeGreaterThan(0);
    const setAt = SRC.indexOf("await db\n    .update(automationRule)");
    expect(setAt).toBeGreaterThan(at);
  });

  it("收件人对非 notify 的规则拒绝（规则 7 的收件人是副作用，没有可调项）", () => {
    expect(SRC).toContain('input.receivers !== undefined && cur.actionType !== "notify"');
  });

  it("空收件人数组被拒（空 = 谁也不发，那应该用停用表达）", () => {
    expect(SRC).toContain("input.receivers.length === 0");
  });

  it("同域冲突预判用**现算**的 scope_key 作为比较值（列可能落后于配置）", () => {
    /**
     * ⚠ 这里的判据要精确区分两件事：
     *   · ✅ 合法：`eq(automationRule.scopeKey, scopeKey)` —— 用**现算值**去查别的行，
     *     这是 WHERE 的比较对象；
     *   · ❌ 有问题：`select({ scopeKey: automationRule.scopeKey })` —— 把**列**当成
     *     当前配置的真值读出来用。列在改过 `trigger_config` 之后会落后，
     *     而 `ux_mn_automation_rule_enabled_action` 是按列建的 ⇒ 两边会不同步。
     *
     * 初版这条断言写成 `not.toContain("automationRule.scopeKey,")`，
     * 于是把上面那个**合法**的 WHERE 一起拦了 —— 断言红的原因是它写错了，不是代码错。
     */
    expect(SRC).toContain("computeScopeKey(");
    expect(SRC).toContain("eq(automationRule.scopeKey, scopeKey)");
    // 关键：没有"把列读进 select"的用法（那才是把列当真值）
    expect(SRC).not.toMatch(/scopeKey:\s*automationRule\.scopeKey/);
  });
});

describe("读数：`live` 与 `enabled` 不是同一个数", () => {
  it("摘要同时给 `enabled` 与 `live`，且 `live` 要求**有执行体**", () => {
    expect(SRC).toContain('live: items.filter((r) => r.isEnabled && r.executor === "live").length');
    expect(countOf("enabled: items.filter((r) => r.isEnabled).length")).toBe(1);
  });
});
