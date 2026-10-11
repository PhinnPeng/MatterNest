import { describe, expect, it } from "vitest";
import { MAX_CASES_PER_CONVERT } from "./risks";
import { convertSchema, unconvertSchema } from "@/shared/schema/hosts";

/**
 * 转案件的请求边界（T2）。
 *
 * 为什么不测 `convertToCase` 本体：它一进去就连库、跑事务，而 `pnpm verify` 的口径是
 * 离线可跑。这里只测"无库可判定、且错了不会当场报错"的那部分——
 * 请求形状与数量边界属于这一类：越界若不拦，症状是"建出一堆用户没预期的案件"，
 * **不报错**，等发现时已经落库了。
 */

const card = (over: Record<string, unknown> = {}) => ({
  name: "恒基建设施工合同纠纷",
  cause: "建设工程施工合同纠纷",
  caseType: "civil_commercial",
  procedure: "first_instance",
  litigationRole: "defendant",
  level: "high",
  ...over,
});

describe("convertSchema：一次提交 N 张卡", () => {
  it("接受单张卡（旧行为不能被破坏）", () => {
    const r = convertSchema.safeParse({ cases: [card()] });
    expect(r.success).toBe(true);
  });

  it("接受 N 张卡 —— 基数是 1→N 不是 1→1", () => {
    // 映射矩阵 §1 写死「一次操作 = 1 事项 → N 个案件」。请求里若只能放一张，
    // "对方分三处起诉"就得转三次，中途失败会留下半态事项。
    const r = convertSchema.safeParse({ cases: [card(), card(), card()] });
    expect(r.success).toBe(true);
  });

  it("拒绝 0 张 —— 提示是中文且说清下限", () => {
    const r = convertSchema.safeParse({ cases: [] });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join(" ");
      expect(msg).toContain("至少建一个案件");
    }
  });

  it("拒绝超过上限，且上限与 MAX_CASES_PER_CONVERT 同源", () => {
    // 两处都改。谁先单改都会让"表单说能填 N、后端拒收"这种错位发生。
    const many = Array.from({ length: MAX_CASES_PER_CONVERT + 1 }, () => card());
    const r = convertSchema.safeParse({ cases: many });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message).join(" ")).toContain(
        `最多转 ${MAX_CASES_PER_CONVERT} 个案件`,
      );
    }
  });

  it("恰好等于上限时通过（边界是闭区间）", () => {
    const exact = Array.from({ length: MAX_CASES_PER_CONVERT }, () => card());
    expect(convertSchema.safeParse({ cases: exact }).success).toBe(true);
  });
});

describe("案号与金额：不再被整体 omit", () => {
  it("案号可填 —— §6.3 说可改，此前整列 omit 等于做成「不能改」", () => {
    const r = convertSchema.safeParse({ cases: [card({ caseNo: "沪0115民初123号" })] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.cases[0]?.caseNo).toBe("沪0115民初123号");
  });

  it("案号可省略 —— 未拿到法院正式案号时留空合法", () => {
    const r = convertSchema.safeParse({ cases: [card()] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.cases[0]?.caseNo).toBeUndefined();
  });

  it("金额可填 —— 映射矩阵 §2.4 是「留空逐案自填」，不是「禁止填」", () => {
    const r = convertSchema.safeParse({ cases: [card({ amount: "5000.00" })] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.cases[0]?.amount).toBe("5000.00");
  });

  it("描述**不接受** —— 描述不继承是规格裁定，不是漏填", () => {
    // 这条要真的拒：放过就会让"描述不复制"变成"描述可自由填写"，
    // 而映射矩阵 §2.5 要的是案件侧保留来源引用、不留会各自漂移的副本。
    const r = convertSchema.safeParse({ cases: [card({ description: "随手写段描述" })] });
    expect(r.success).toBe(false);
  });
});

describe("unconvertSchema：撤销转案件", () => {
  it("接受完整输入", () => {
    const r = unconvertSchema.safeParse({ caseId: "1800000000000000001", reason: "转错了事项" });
    expect(r.success).toBe(true);
  });

  it("**拒绝空原因** —— 枚举表 §3.2 把 UNCONVERT 列为原因必填", () => {
    // 这是最容易漏的一条：撤销是这条链上唯一**不可逆**的动作，
    // 审计里存一条"无理由撤销"等于没审计。
    const r = unconvertSchema.safeParse({ caseId: "1800000000000000001", reason: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message).join(" ")).toContain("撤销必须填原因");
    }
  });

  it("拒绝纯空白的 reason —— trim 后为空也算没填", () => {
    // 只判 `length > 0` 的话，全角空格能过；服务端再 trim 就成了无理由撤销。
    const r = unconvertSchema.safeParse({ caseId: "1800000000000000001", reason: "　 \n" });
    expect(r.success).toBe(false);
  });

  it("拒绝非数字 caseId —— 路由要拿它当 bigint 主键用", () => {
    const r = unconvertSchema.safeParse({ caseId: "abc", reason: "理由" });
    expect(r.success).toBe(false);
  });

  it("strict：拒绝顺手改案件字段 —— 撤销只准动关联", () => {
    // 若允许把案件字段一起带进来，"撤销"就变成了"改案"，两件事混在一个事务里，
    // 之后谁也说不清这次到底动过什么。
    const r = unconvertSchema.safeParse({
      caseId: "1800000000000000001",
      reason: "理由",
      name: "偷偷改个案件名",
    });
    expect(r.success).toBe(false);
  });
});
