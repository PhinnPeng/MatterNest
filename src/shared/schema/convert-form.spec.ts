import { describe, expect, it } from "vitest";
import {
  COPYABLE_FIELDS,
  NON_COPYABLE_FIELDS,
  caseCardSchema,
  convertFormSchema,
  copyCardOnto,
  describeIssuePath,
  summarizeIssues,
  type CaseCard,
} from "./convert-form";
import { LITIGATION_ROLES } from "../enums/business";

const card = (over: Partial<CaseCard> = {}): CaseCard => ({
  party_name: "张三",
  party_role: "defendant",
  cause: "买卖合同纠纷",
  tags: [],
  nodes: [{ name: "举证期限" }],
  ...over,
});

/**
 * N7 的通过标准是"错误能定位到第几张卡、哪个字段"——这几条测试就是该标准的实现证明。
 */
describe("describeIssuePath（Zod path → 人话）", () => {
  it("卡片内字段：索引 +1，字段名查中文", () => {
    expect(describeIssuePath(["cases", 2, "party_name"])).toBe("第 3 张卡 · 当事人名称");
    expect(describeIssuePath(["cases", 0, "nodes", 1, "due_date"])).toBe(
      "第 1 张卡 · 节点 · 节点期限",
    );
  });

  it("表单级字段不带卡号；未知字段名回退原 key 而不是抛错", () => {
    expect(describeIssuePath(["risk_matter_id"])).toBe("来源事项");
    expect(describeIssuePath(["cases"])).toBe("案件卡片");
    expect(describeIssuePath(["cases", 1, "mystery_field"])).toBe("第 2 张卡 · mystery_field");
  });
});

describe("convertFormSchema", () => {
  it("空数组被拒，且提示是中文", () => {
    const r = convertFormSchema.safeParse({ risk_matter_id: "123", cases: [] });
    expect(r.success).toBe(false);
    if (!r.success) expect(summarizeIssues(r.error.issues)).toContain("案件卡片：至少建一个案件");
  });

  it("第 3 张卡缺当事人名称 → 汇总里出现「第 3 张卡 · 当事人名称」", () => {
    const r = convertFormSchema.safeParse({
      risk_matter_id: "123",
      cases: [card(), card(), card({ party_name: "" })],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const lines = summarizeIssues(r.error.issues);
      expect(lines.some((l) => l.startsWith("第 3 张卡 · 当事人名称："))).toBe(true);
    }
  });

  it("当事人地位用 E12 值域：律所口径的 represented 一律拒收（IQ-15）", () => {
    // `represented`（"是否我方代理"）的参照系是律所，随 IQ-15 软作废。我方提诉还是应诉
    // 由案件上的 `litigation_role` 单值表达。这条断言的作用是**钉死它回不来**——
    // 照旧文档重写表单时最容易把它顺手加回去，而那样用户又会填"我方代理"这种无意义的值。
    const r = caseCardSchema.safeParse({ ...card(), party_role: "represented" });
    expect(r.success).toBe(false);
    // 而且值域要真的跟着 E12 走，不是自己抄一份
    expect(LITIGATION_ROLES).toContain("defendant");
  });

  it("跨卡规则：当事人 + 案由重复 → 报错落在后面那张卡，并指名与第几张重复", () => {
    const r = convertFormSchema.safeParse({
      risk_matter_id: "123",
      cases: [card(), card()],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(summarizeIssues(r.error.issues)).toContain(
        "第 2 张卡 · 案由：与第 1 张卡重复（当事人 + 案由相同）",
      );
    }
  });

  it("一次最多 20 张卡", () => {
    const many = Array.from({ length: 21 }, (_, i) => card({ party_name: `甲${i}` }));
    expect(convertFormSchema.safeParse({ risk_matter_id: "1", cases: many }).success).toBe(false);
  });
});

describe("copyCardOnto（跨卡复制）", () => {
  it("白名单与黑名单不得有交集——有交集就意味着 id 会被复制走", () => {
    const overlap = COPYABLE_FIELDS.filter((f) =>
      (NON_COPYABLE_FIELDS as readonly string[]).includes(f),
    );
    expect(overlap).toEqual([]);
  });

  it("复制带过去业务字段，但 id 类字段保持目标卡自己的值", () => {
    const source = card({
      matter_id: "900",
      party_id: "800",
      party_name: "李四",
      cause: "借款合同纠纷",
      court: "上海一中院",
      amount: "5000.00",
      tags: ["大额"],
    });
    const target = card({
      matter_id: "111",
      party_id: "222",
      party_name: "旧名",
      cause: "旧案由",
    });

    const out = copyCardOnto(source, target);
    expect(out.party_name).toBe("李四");
    expect(out.cause).toBe("借款合同纠纷");
    expect(out.court).toBe("上海一中院");
    expect(out.tags).toEqual(["大额"]);
    expect(out.matter_id).toBe("111"); // 矩阵 §3：id 类不参与复制
    expect(out.party_id).toBe("222");
  });

  it("目标卡的节点列表不被覆盖（节点是每卡独立的生成结果）", () => {
    const source = card({ nodes: [{ name: "举证期限" }, { name: "开庭" }] });
    const target = card({ nodes: [{ name: "只属于这张卡" }] });
    expect(copyCardOnto(source, target).nodes).toEqual([{ name: "只属于这张卡" }]);
  });
});
