import { describe, expect, it } from "vitest";
import { SCOPE_KEY_LENGTH, SCOPE_KEY_VECTOR_COUNT } from "@/shared/enums/automation";
import { canonTriggerConfig, computeScopeKey } from "./scope-key";

/**
 * `scope_key` 归一化的 8 条必过向量（枚举表 §4.4）+ 实现自身的黄金值探针。
 *
 * ## 为什么这个文件必须存在（而不是"归一化函数看着挺对"）
 *
 * 唯一约束的判定完全落在这个函数的产出串上，而它的失效形态是**静默**的：
 * 同一条件算出两个 key ⇒ 同域同动作能并存（用户收到两条同源通知）；
 * 不同条件算出一个 key ⇒ 该共存的规则插不进去（报错指向约束，不指向归一化）。
 * 两种都不会在类型检查、代码审阅或冒烟里露头。
 *
 * ## 为什么向量写成数据表而不是 8 个 `it`
 *
 * 8 条向量是**文档里的一个数字**（`SCOPE_KEY_VECTOR_COUNT = 8`）。写成 8 个独立的
 * `it("V1 …")` 时，"漏抄一条"只会让文件少一个用例——测试数变了，但没有任何断言会红。
 * 数据表 + `expect(VECTORS.length).toBe(SCOPE_KEY_VECTOR_COUNT)` 把这件事变成机器可核对的。
 *
 * 两条"不同 key"的向量（V4/V7）不能省：只有"同 key"的话，
 * 一个恒返回常量的实现会全绿。
 */
type Vector = {
  id: string;
  triggerType: string;
  triggerTarget: string;
  a: Record<string, unknown>;
  b: Record<string, unknown>;
  same: boolean;
  note: string;
};

const VECTORS: readonly Vector[] = [
  {
    id: "V1",
    triggerType: "status_changed",
    triggerTarget: "matter",
    a: { status_code: "closed" },
    b: { status_code: "closed" },
    same: true,
    note: "同一份配置 → 同 key",
  },
  {
    id: "V2",
    triggerType: "time_no_progress",
    triggerTarget: "matter",
    a: { days: 3 },
    b: { days: "03" },
    same: true,
    note: '`{"days":3}` 与 `{"days":"03"}` 同 key（数值键取 int，规则 5）',
  },
  {
    id: "V3",
    triggerType: "event_occurred",
    triggerTarget: "all",
    a: { receivers: ["owner", "follower"] },
    b: { receivers: ["follower", "owner"] },
    same: true,
    note: "标量数组先升序（规则 3）",
  },
  {
    id: "V4",
    triggerType: "status_changed",
    triggerTarget: "matter",
    a: { status_code: "closed" },
    b: { status_code: "in_progress" },
    same: false,
    note: "不同状态码 → 不同 key",
  },
  {
    id: "V5",
    triggerType: "time_no_progress",
    triggerTarget: "matter",
    a: { days: 3, x: null },
    b: { days: 3 },
    same: true,
    note: "空值丢键（规则 2）",
  },
  {
    id: "V6",
    triggerType: "status_changed",
    triggerTarget: "matter",
    a: { a: 1, b: 2 },
    b: { b: 2, a: 1 },
    same: true,
    note: "键序无关（规则 1）",
  },
  {
    id: "V7",
    triggerType: "time_no_progress",
    triggerTarget: "matter",
    a: { event: "risk_converted" },
    b: { days: 30 },
    same: false,
    note: "同触发类型、不同键 → 不同 key",
  },
  {
    id: "V8",
    triggerType: "status_changed",
    triggerTarget: "matter",
    // 状态被改名（`name` 列）而 `code` 不变 ⇒ 同配置。归一化只吃 code，
    // 所以这条钉的是"别把显示名也塞进 trigger_config"
    a: { status_code: "closed" },
    b: { status_code: "closed" },
    same: true,
    note: "约束挂在 code 上，改显示名不影响域",
  },
];

describe("scope_key 归一化（枚举表 §4.4 的 8 条向量）", () => {
  it("向量表条数与登记一致（漏抄一条在这里红，而不是「少一个用例」）", () => {
    expect(VECTORS.length).toBe(SCOPE_KEY_VECTOR_COUNT);
    expect(SCOPE_KEY_LENGTH).toBe(12);
  });

  it.each(VECTORS.map((v) => [v.id, v] as const))("%s %s", (_id, v) => {
    const ka = computeScopeKey(v.triggerType, v.triggerTarget, v.a);
    const kb = computeScopeKey(v.triggerType, v.triggerTarget, v.b);
    if (v.same) expect(ka, v.note).toBe(kb);
    else expect(ka, v.note).not.toBe(kb);
  });

  it("3.0 与 3 也同 key（管理员把 3 写成 3.0 不该能绕过唯一约束）", () => {
    const t = "time_no_progress";
    expect(computeScopeKey(t, "matter", { days: 3.0 })).toBe(
      computeScopeKey(t, "matter", { days: 3 }),
    );
  });

  it("`canon()` 产出无空白、键按 ASCII 升序（规则 1/7）", () => {
    expect(canonTriggerConfig({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canonTriggerConfig({ days: 14, status_code: "closed" })).toBe(
      '{"days":14,"status_code":"closed"}',
    );
    expect(canonTriggerConfig({})).toBe("{}");
    expect(canonTriggerConfig({ xs: [{ k: 1 }, { k: 2 }] })).not.toBe(
      canonTriggerConfig({ xs: [{ k: 2 }, { k: 1 }] }),
    );
  });

  it("摘要形态：12 位、落在 base32hex 小写字母表内", () => {
    const key = computeScopeKey("event_occurred", "all", { event: "comment_added" });
    expect(key).toHaveLength(SCOPE_KEY_LENGTH);
    expect(key).toMatch(/^[0-9a-v]{12}$/);
  });

  /**
   * **实现自身的黄金值探针**：把"SHA-1 写对了没有"与"归一化写对了没有"分开。
   *
   * 期望值是**独立算出来的**（`node:crypto` 的 `createHash("sha1")` + 同一份 base32hex
   * 字母表，见 `agent-work/_tmp-scope.mjs` 那一轮的交叉核对），不是从本实现抄的。
   * 少了这条，一个错的散列配一个错的归一化可能互相抵消成绿。
   *
   * 第二条用**非 ASCII** 值：UTF-8 编码是手写的（禁令① 不许用 `node:crypto`），
   * 而"编码写错"只在中文进 `trigger_config` 时才现形。
   */
  it("黄金值：与独立实现（node:crypto）逐字一致，含非 ASCII 输入", () => {
    expect(computeScopeKey("status_changed", "all", { status_code: "closed" })).toBe(
      "voa3vu2kch4o",
    );
    expect(computeScopeKey("time_no_progress", "matter", { days: 14, status_code: "closed" })).toBe(
      "9hviq69mu3cd",
    );
    expect(computeScopeKey("status_changed", "matter", { status_code: "已结案" })).toBe(
      "vumafs6melbv",
    );
  });
});
