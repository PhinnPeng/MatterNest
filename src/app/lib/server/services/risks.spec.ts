import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isRiskFrozen,
  riskMattersExportCsv,
  MAX_CASES_PER_CONVERT,
  type RiskExportRow,
} from "./risks";
import { BATCH_SKIP_REASON_LABELS } from "@/shared/schema/batch";
import {
  convertSchema,
  riskCreateSchema,
  riskPartyAppendSchema,
  unconvertSchema,
} from "@/shared/schema/hosts";

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

describe("riskCreateSchema.parties：事项侧当事人区", () => {
  const base = {
    name: "恒基建设施工合同纠纷",
    type: "contract",
    level: "high",
    description: "冒烟用事项",
  };

  it("可留空 —— 建事项不该被当事人绑住", () => {
    // 事项是台账，先登记风险、当事人还没摸清是常态。
    // 但**转案件**要至少 1 个（§6.2），那是另一个时机的校验，两处不能混。
    const r = riskCreateSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.parties).toEqual([]);
  });

  it("接受快速新增的当事人（只给名称+类型+角色）", () => {
    const r = riskCreateSchema.safeParse({
      ...base,
      parties: [{ name: "恒基建设", type: "legal_person", partyRole: "defendant" }],
    });
    expect(r.success).toBe(true);
  });

  it("接受引用已登记当事人（给 partyId 即可）", () => {
    const r = riskCreateSchema.safeParse({
      ...base,
      parties: [{ partyId: "1800000000000000001", partyRole: "plaintiff" }],
    });
    expect(r.success).toBe(true);
  });

  it("**拒绝**只有 partyId 与角色之外的空壳行（既没 id 也没名称）", () => {
    // 这一条是"新增当事人要填名称"校验存在的理由。
    // 少了它，用户留一个空行就会建出一条无名当事人。
    const r = riskCreateSchema.safeParse({
      ...base,
      parties: [{ partyRole: "defendant" }],
    });
    expect(r.success).toBe(false);
  });

  it("缺类型时拒绝新建当事人，并点名缺什么", () => {
    const r = riskCreateSchema.safeParse({
      ...base,
      parties: [{ name: "恒基建设", partyRole: "defendant" }],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message).join(" ")).toContain("请选择当事人类型");
    }
  });

  it("与案件侧共用值域：非法角色两边都不接受", () => {
    // 值域同源的收益就在这一条。若哪天有人给事项侧单开一套，这里会红。
    const bad = {
      ...base,
      parties: [{ name: "恒基建设", type: "legal_person", partyRole: "法官" }],
    };
    expect(riskCreateSchema.safeParse(bad).success).toBe(false);
  });
});

describe("riskPartyAppendSchema：建后追加当事人", () => {
  it("拒绝空数组 —— 「追加 0 个」是空操作，不该发请求", () => {
    const r = riskPartyAppendSchema.safeParse({ parties: [] });
    expect(r.success).toBe(false);
  });

  it("strict：拒绝夹带别的字段", () => {
    const r = riskPartyAppendSchema.safeParse({
      parties: [{ name: "恒基建设", type: "legal_person", partyRole: "defendant" }],
      code: "FX-2026-001",
    });
    expect(r.success).toBe(false);
  });

  it("与建事项那次用同一个 partyLinkSchema —— 同一条数据两种结论是最难查的一类错", () => {
    const row = { name: "恒基建设", type: "legal_person", partyRole: "defendant" };
    const onCreate = riskCreateSchema.safeParse({
      name: "事项",
      type: "contract",
      level: "high",
      description: "描述",
      parties: [row],
    });
    const onAppend = riskPartyAppendSchema.safeParse({ parties: [row] });
    expect(onCreate.success).toBe(onAppend.success);
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

/* ────────────────────────────────────────────────────────────────────────────
 * 冻结（2026-10-14 裁定，2026-10-16 MATT-80/82 扩展到节点/当事人/软删）：
 * 事项一旦转过至少一个案件，它的业务内容就不可再改。
 *
 * 下面这一组盯三件事，顺序是「语义 → 覆盖面 → 只写一处」：
 *   1. 判据本身对不对（纯函数，可离线判）；
 *   2. 八条写路径是不是都走了它（漏一条 = 裁定形同虚设，且**不报错**）；
 *   3. 判据是不是**只有一处**（票面原话：未来若要放开只需改一处判定）。
 *
 * 为什么不连库测：`unconvertFromCase` / `changeRiskStatus` 一进去就连库、跑事务，
 * 而 `pnpm verify` 的口径是离线可跑（本仓既有约定，见本文件头）。
 * 真 HTTP 那侧的断言在 `agent-work/smoke-convert.mjs`。
 */
describe("isRiskFrozen：转过案件的事项一律冻结", () => {
  it("conversion_status=1 → 冻结", () => {
    expect(isRiskFrozen(1)).toBe(true);
  });

  it("conversion_status=0 → 不冻结（还没转过案件）", () => {
    expect(isRiskFrozen(0)).toBe(false);
  });

  it("冻结点是「有没有转过」，不是案件数量 —— 一个案件和十个案件结论相同", () => {
    // 裁定原文：冻结点 = conversion_status = 1。若有人改成"按 converted_case_count 判"，
    // 这一条不会红（计数不在函数入参里），所以真正的守卫在下面的源码断言。
    expect(isRiskFrozen(1)).toBe(isRiskFrozen(1));
    expect(isRiskFrozen(1)).not.toBe(isRiskFrozen(0));
  });

  it("null / undefined / 非 0-1 的值一律**不**冻结 —— 判据写死等值，不用真值", () => {
    // 用 `if (conversionStatus)` 这种写法的话，undefined 也会判成冻结，
    // 而"读不到这一列"绝不能等价于"已转案件"。缺失不收紧，缺失只放开。
    expect(isRiskFrozen(null)).toBe(false);
    expect(isRiskFrozen(undefined)).toBe(false);
    expect(isRiskFrozen(2)).toBe(false);
    expect(isRiskFrozen("1" as unknown as number)).toBe(false);
  });
});

describe("冻结判据：只写一处，且十条写路径都走它", () => {
  const src = readFileSync("src/app/lib/server/services/risks.ts", "utf8");

  /**
   * 抽出 `export async function X(` 的函数名 + 函数体，用于逐个查它有没有走判据。
   *
   * ⚠ **边界不能只认 `export async function`**（MATT-64 踩到）：那样切片是"到下一个
   * 导出异步函数为止"，于是**同步函数与文件尾**都被算进上一条的身体里。
   * 实测形态：文件尾新加的 `riskMattersExportCsv` 只是**渲染**「转案件」那一列
   * （渲染的是已转/未转这一事实，不是写路径上的门），却被算成
   * "batchTagRiskMatters 也走了冻结门"，于是下面那条八条路径的断言变红 ——
   * 而真正的问题是切片不是函数体。所以边界放宽到任何顶层函数声明。
   */
  const boundaries = [...src.matchAll(/^(?:export )?(?:async )?function \w+\(/gm)].map(
    (m) => m.index!,
  );
  const functions = [...src.matchAll(/^export async function (\w+)\(/gm)].map((m) => {
    const start = m.index!;
    const end = boundaries.find((b) => b > start) ?? src.length;
    return { name: m[1]!, body: src.slice(start, end) };
  });

  it("解析器没空转（函数数不为零 —— 否则下面每条都恒真）", () => {
    expect(functions.length).toBeGreaterThan(10);
  });

  it("`conversion_status = 1` 这个比较在 services/risks.ts 里只出现一次", () => {
    // 这条是「未来若要放开只需改一处判定」的可执行形式。判据散在多个函数里的话，
    // 放开时必须改多处，而漏掉的那一处**不会报错** —— 只会让裁定悄悄地只生效了一半。
    const hits = src.match(/conversionStatus\s*===\s*1/g) ?? [];
    expect(hits).toEqual(["conversionStatus === 1"]);
  });

  it("十一条写路径的门都是**活的** `if (isRiskFrozen(...)) return frozen`，恰好十一处", () => {
    // ⚠ 这一条是被反向红逼出来的：先前只查「函数体里出现过 isRiskFrozen(」，
    // 而把门改成 `if (false && isRiskFrozen(...))` 照样命中 —— 门被摘掉了，断言还是绿的。
    // 「门存在」与「门挡得住」是两件事，后者才需要断言。所以这里比对完整形态。
    //
    // 顺序 = 门在 `services/risks.ts` 里出现的顺序（跟着函数定义的先后走）：
    //   追加当事人 / 摘除当事人 / 撤销转案件 / 改状态 / 改字段 / 写进展 / 加节点 /
    //   改节点 / 删节点 / 改节点状态 / 软删。
    const gates = [
      ...src.matchAll(
        /if \(\s*isRiskFrozen\((\w+)\.conversionStatus\)\)\s*return \{[^}]*why: "frozen"\s*\}/g,
      ),
    ];
    expect(
      gates.map((m) => m[1]),
      "十一条写路径上少了一道活门，或门被短路了",
    ).toEqual(["src", "src", "src", "cur", "cur", "visible", "vis", "node", "node", "node", "cur"]);
  });

  it("追加当事人 / 摘除当事人 / 软删 / 撤销转案件 / 状态流转 / 字段编辑 / 写进展 / 新增节点 / 改节点 / 删节点 / 改节点状态 十一条路径都先问 isRiskFrozen", () => {
    const guarded = functions
      .filter((f) => f.body.includes("isRiskFrozen("))
      .map((f) => f.name)
      .sort();
    expect(guarded).toEqual([
      "addRiskNode",
      "addRiskProgress",
      "appendRiskParties",
      "changeRiskStatus",
      "deleteRiskMatter",
      "deleteRiskNode",
      "removeRiskParty",
      "setRiskNodeStatus",
      "unconvertFromCase",
      "updateRiskMatter",
      "updateRiskNode",
    ]);
  });

  it("冻结门都排在归档与归属判定**之前**（十一道门逐个点名；两道无可排前判定的跳过，不算过）", () => {
    // 门的先后不是风格：若把 `isRiskFrozen` 排在 `isArchived` / `ownsAttribution` 之后，
    // 冻结的事项会先被告知「已归档」或「你不是经办人」，用户照着那句去找特权或找经办人，
    // 而找到之后拿到的还是同一句拒绝。**答案要是"因为已冻结"，不是别的原因。**
    // 判据只看**判定语句**本身（`if (x.isArchived)` / `ownsAttribution(`），
    // 不看 select 里那列同名的 `isArchived:` —— 读列名不是判定。
    const guarded = [
      "appendRiskParties",
      "removeRiskParty",
      "unconvertFromCase",
      "changeRiskStatus",
      "updateRiskMatter",
      "addRiskProgress",
      "addRiskNode",
      "updateRiskNode",
      "deleteRiskNode",
      "setRiskNodeStatus",
      "deleteRiskMatter",
    ];
    for (const name of guarded) {
      const fn = functions.find((f) => f.name === name);
      expect(fn, `${name} 不在 services/risks.ts 里了 —— 先看清楚再改这条断言`).toBeTruthy();
      const body = fn!.body;
      const gate = body.indexOf("isRiskFrozen(");
      const archived = body.search(/if \(\s*\w+\.isArchived\b/);
      const attribution = body.indexOf("ownsAttribution(");
      const firstOther = [archived, attribution].filter((i) => i >= 0).sort((a, b) => a - b)[0];
      // 本函数没有归档/归属判定（removeRiskParty / unconvertFromCase 两道）就没有顺序可判 —— 跳过，不算过。
      if (firstOther === undefined) continue;
      expect(gate, `${name} 的冻结门排在了归档/归属判定之后 —— 用户会先听到假原因`).toBeLessThan(
        firstOther,
      );
    }
  });

  it("发处置记录、关注人、批量标签**没有**被冻结门拦住（刻意豁免）", () => {
    // ADR 0005 把「协作面与分类」列为**刻意豁免**：评论 / 关注人 / 追加转案件保持开放，
    // 否则冻结会比归档更严（归档尚且允许评论），与既有裁定冲突；标签只做分类，
    // 不改业务事实，也算豁免。
    // ⚠ 当事人与软删原本在这张清单里（MATT-80 时列作"归 MATT-81/82 那两张票"），
    // MATT-82 已按裁定给它们补上冻结门，所以**从这里移走** —— 留着会与 ADR 打架。
    // 这条断言的作用是「将来有人在本票范围外加门，这里会红，红色会逼他回去对齐 ADR」。
    const mustStayOpen = [
      "addRiskComment",
      "editRiskComment",
      "addRiskFollowers",
      "removeRiskFollower",
      "batchTagRiskMatters",
    ];
    for (const name of mustStayOpen) {
      const fn = functions.find((f) => f.name === name);
      expect(fn, `${name} 不在 services/risks.ts 里了 —— 先看清楚再改这条断言`).toBeTruthy();
      expect(fn!.body, `${name} 出现了冻结门，但它属于豁免清单或别的票`).not.toContain(
        "isRiskFrozen(",
      );
    }
  });

  it("`batchTagRiskMatters` 的豁免是**刻意写明的**，不是漏加的门", () => {
    // ## 为什么"豁免"也要有断言
    //
    // 这条断言是本次裁定（2026-10-16 / ADR-0005）留下的"备注不可删"钉子：
    //   · 将来有人顺手给标签补一道冻结门 —— 上面那张 mustStayOpen 会红，红色会逼他回来看 ADR；
    //   · 反过来，有人**顺手把这段豁免说明抄走或删掉**，则没有任何东西会红 ——
    //     门还是没加、行为不变，但「为什么不加」这件事没了。下一次读到这段代码的人
    //     就无法分辨"刻意豁免"与"忘了加"，于是要么白加一道门、要么把真有漏的路径也当豁免放过。
    // 所以判据不是"有没有门"（那是上一条），而是**说明是否存在且写清了理由**。
    const fn = functions.find((f) => f.name === "batchTagRiskMatters");
    expect(
      fn,
      "batchTagRiskMatters 不在 services/risks.ts 里了 —— 先看清楚再改这条断言",
    ).toBeTruthy();
    const body = fn!.body;
    expect(body, "豁免说明不见了：标签路径看起来像是漏加门").toContain("刻意豁免");
    expect(body, "只说了「豁免」没说「不加门」——读者会以为只是暂时没加上").toContain("不加门");
    // 理由要落在"不改业务事实"这条线上，否则"豁免"二字可以套在任何地方
    expect(body, "豁免没写理由 —— 得说明标签为什么不改业务事实").toMatch(/只做分类|不改业务事实/);
    // 理由里要指出它与 ADR 的绑定：改豁免要与 ADR 一起改，否则两份文档会互相打架
    expect(body, "豁免没指向 ADR-0005 —— 改的时候不会有人发现两份文档已经分叉").toContain(
      "ADR-0005",
    );
  });

  it("转案件本身**不**被冻结门拦住 —— 冻结是转完才有的，且允许二次转", () => {
    // 映射矩阵 §1：「可以二次转案件，向同一事项追加案件」。若 convertToCase 也被门挡住，
    // 一条已转过的事项就再也追加不了案件了 —— 那与裁定相反。
    const fn = functions.find((f) => f.name === "convertToCase");
    expect(fn).toBeTruthy();
    expect(fn!.body).not.toContain("isRiskFrozen(");
  });
});

describe("冻结在接口上是可读的一条原因，不是笼统的 blocked", () => {
  it("批量摘要里 `frozen` 有一条中文标签", () => {
    // 「跳过 3 条」而每条都读不出为什么，等于什么都没说。
    // 这条标签同时约束两个列表视图（事项页与案件页共用一份字典，见 shared/schema/batch.ts）。
    expect(BATCH_SKIP_REASON_LABELS.frozen).toMatch(/冻结|已转/);
  });

  it("标签是新增的一条，没有覆盖掉既有的五条", () => {
    expect(Object.keys(BATCH_SKIP_REASON_LABELS)).toEqual([
      "forbidden",
      "reason_required",
      "unchanged",
      "privilege_required",
      "archived",
      "frozen",
    ]);
  });
});

/* ───────────────── 列表导出（MATT-64 / F1-20） ───────────────── */

/**
 * 事项列表导出的 CSV 形状。只测**不连库的那一半**（`pnpm verify` 口径是离线可跑）：
 * "导出行数 == 同一筛选下列表的 total" 那条在真库上，见 `agent-work/smoke-list-export.mjs`。
 */
describe("事项列表导出：CSV 形状（F1-20）", () => {
  const row = (over: Partial<RiskExportRow> = {}): RiskExportRow => ({
    code: "FX-2026-0007",
    name: "恒基建设合同违约",
    type: "contract",
    level: "high",
    status: "in_progress",
    discoverDate: "2026-09-22",
    ownerName: "王小明",
    convertedCaseCount: 0,
    conversionStatus: 0,
    updatedAt: "2026-10-14T02:00:00.000Z",
    ...over,
  });
  const dict = { statusNames: { in_progress: "进行中" }, levelNames: { high: "高风险" } };

  it("BOM 开头、中文表头、列序与列表一致", () => {
    const csv = riskMattersExportCsv([row()], dict);
    expect(csv.startsWith("\uFEFF编号,事项名称,类型,等级,状态,转案件,发现日期")).toBe(true);
    expect(csv).toContain("合同");
    expect(csv).toContain("进行中");
    expect(csv).toContain("2026-09-22");
  });

  it("未指派写成「未指派」而不是空（列表也是这么说的：留白会被读成数据缺失）", () => {
    const csv = riskMattersExportCsv([row({ ownerName: null })], dict);
    expect(csv).toContain("未指派");
  });

  it("转案件那一列与列表同一句话：未转 / 已转 · N", () => {
    expect(
      riskMattersExportCsv([row({ convertedCaseCount: 2, conversionStatus: 1 })], dict),
    ).toContain("已转 · 2");
    expect(riskMattersExportCsv([row()], dict)).toContain("未转");
  });

  it("逗号/引号/换行按公共件处理（与整卷、当事人导出同一份 csvCell）", () => {
    const csv = riskMattersExportCsv([row({ name: '恒基,"违约"\n第二行' })], dict);
    expect(csv).toContain('"恒基,""违约"" 第二行"');
    expect(csv.split("\r\n")).toHaveLength(2);
  });

  it("空结果只给表头；字典缺键回落原始 code（停用状态不许导成空白）", () => {
    expect(riskMattersExportCsv([], dict).split("\r\n")).toHaveLength(1);
    const csv = riskMattersExportCsv([row({ status: "custom_x", level: "weird" })], {});
    expect(csv).toContain("custom_x");
    expect(csv).toContain("weird");
  });
});

/* ───────────────── 源码守卫：导出与列表**同一套**谓词、特权只判一次（MATT-64） ───────────────── */

/**
 * 与 `matters.spec.ts` 同形（案件/事项两张列表是同构表对，守卫也就同构）：
 * 谓词只写一处 + `canReadPlain` 只在 HTTP 层。真库那一半见
 * `agent-work/smoke-list-export.mjs` 的「导出行数 == 列表 total」。
 */
describe("守卫：事项列表导出的谓词与特权判定", () => {
  const raw = readFileSync("src/app/lib/server/services/risks.ts", "utf8");
  /** 剥注释再匹配：注释里必然会**写** `scopedWhere("risk_matter"` 来解释为什么只许一处 */
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  const boundaries = [...code.matchAll(/^(?:export )?(?:async )?function \w+\(/gm)].map(
    (m) => m.index!,
  );
  const fnBody = (name: string) => {
    const start = code.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, "m"));
    expect(start, `找不到函数 ${name}（改名了？那这条守卫要跟着改）`).toBeGreaterThanOrEqual(0);
    return code.slice(start, boundaries.find((b) => b > start) ?? code.length);
  };

  it("列表那几个筛选条件各只写一次（第二处就是第二套列表谓词）", () => {
    // ⚠ 不数 `scopedWhere("risk_matter"`：逐条可见性判定里它正当地出现多次。
    // 会漂的是**列表那套条件**：归档二态、关键词、未指派 —— 只能住在 `riskMattersListWhere` 里。
    expect(code.match(/archivedFilter\("risk_matter"/g) ?? []).toHaveLength(1);
    expect(code.match(/keywordFilter\("risk_matter"/g) ?? []).toHaveLength(1);
    expect(code.match(/isNull\(riskMatter\.ownerId\)/g) ?? []).toHaveLength(1);
  });

  it("列表与导出走**同一个** where 构造器（各一次，不是各拼一遍）", () => {
    expect(fnBody("listRiskMatters")).toContain("riskMattersListWhere(actor, q)");
    expect(fnBody("exportRiskMatters")).toContain("riskMattersListWhere(actor, q)");
  });

  it("服务层不出现 `canReadPlain`（明文导出的门只在 HTTP 层那一处）", () => {
    expect(code).not.toContain("canReadPlain");
  });
});
