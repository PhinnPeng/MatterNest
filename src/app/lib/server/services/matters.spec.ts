import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mattersExportCsv, resolveClosingDate, type MatterExportRow } from "./matters";
import { businessDateKey } from "@/shared/time/zh-cn";

/**
 * `closing_date` 的取值口径（MATT-69）。
 *
 * ## 为什么不测 `changeStatus` 本体
 *
 * 它一进去就连库、开事务，而 `pnpm verify` 的口径是离线可跑
 * （与 `risks.spec.ts` 里"为什么不测 `convertToCase` 本体"同一条理由）。
 * 所以判定被抽成 `resolveClosingDate`：逻辑与抽出来之前逐字相同，
 * 签名把"现在"作为**入参**——下面这些断言因此可以在不碰机器时钟的前提下钉住具体瞬时。
 *（改全局时钟的用例会与并行用例互相污染，而且一旦漏了 `useRealTimers` 就是一片假红。）
 *
 * ## 这一列错起来为什么是静默的
 *
 * `closing_date` 是 `date` 列、业务日语义的（"结案那天是哪天"），
 * 详情页「结案日期」与导出里都把它当纸面事实读。写成 UTC 日切片之后：
 * **上海 00:00–08:00 结案的案件落成前一天**，而用户当天点的就是"结案"——
 * 界面上没有任何东西提示它错了，差一天这件事只有对账才看得见。
 * 连带：规则 9 的 14 天原点取自这一列 ⇒ 那批案件提前一天收到"材料不全"提醒。
 */

/**
 * 夹具用的那个瞬时：`2026-10-13T17:30:00Z` = **上海 2026-10-14 01:30**。
 *
 * 选它是因为 UTC 与上海在这一刻**分属两天**（UTC 还是 13 号，上海已经 14 号了）。
 * 上海 08:00 之前提交都落在这个窗口里——用户体感是"凌晨补了个结案"。
 */
const SHANGHAI_LATE_NIGHT = "2026-10-13T17:30:00.000Z";

describe("结案日期取的是业务日（上海），不是 UTC 日", () => {
  it("先确认夹具本身有效：这个瞬时在 UTC 与上海确实不是同一天", () => {
    // 断言失败的话，下面那条红就没有意义了——它可能只是被一个"恰好同天"的夹具骗过去的。
    expect(SHANGHAI_LATE_NIGHT.slice(0, 10)).toBe("2026-10-13");
    expect(businessDateKey(SHANGHAI_LATE_NIGHT)).toBe("2026-10-14");
  });

  it("**上海凌晨 1:30 结案 ⇒ 结案日期是上海那一天**（UTC 切片会写成 10-13）", () => {
    const d = resolveClosingDate("closed", null, SHANGHAI_LATE_NIGHT);
    expect(d).toBe("2026-10-14");
  });

  it("反过来也钉住：白天的同一时刻，两种口径同值（防「这列其实无所谓」的自我宽慰）", () => {
    // 上海 10:30 ⇒ UTC 同为 10-13，两种算法一致；这一条让上面那条的"差异"有对照。
    expect(resolveClosingDate("closed", null, "2026-10-13T02:30:00.000Z")).toBe("2026-10-13");
  });

  it("上海 08:00 边界之上（08:00 整）已与 UTC 同日，边界之下才是分界点", () => {
    // 00:00 上海 = 前一天 16:00Z；08:00 上海 = 当天 00:00Z。这条钉住分界的**时刻**，
    // 而不是"大概是晚上"。
    expect(resolveClosingDate("closed", null, "2026-10-13T16:00:00.000Z")).toBe("2026-10-14");
    expect(resolveClosingDate("closed", null, "2026-10-14T00:00:00.000Z")).toBe("2026-10-14");
  });

  it("已有的结案日期不覆盖（重复进入 closed 仍是第一次那一天）", () => {
    expect(resolveClosingDate("closed", "2026-09-01", SHANGHAI_LATE_NIGHT)).toBe("2026-09-01");
  });
});

describe("其余两个分支不受影响（MATT-42 踩过的坑不许回来）", () => {
  it("归档语义**保留**结案日期（`closed → archived` 命中它）", () => {
    expect(resolveClosingDate("archived", "2026-09-01", SHANGHAI_LATE_NIGHT)).toBe("2026-09-01");
  });

  it("离开 closed 且不是归档 ⇒ 清空", () => {
    expect(resolveClosingDate("in_progress", "2026-09-01", SHANGHAI_LATE_NIGHT)).toBeNull();
    expect(resolveClosingDate("custom", "2026-09-01", SHANGHAI_LATE_NIGHT)).toBeNull();
  });
});

/* ───────────────── 列表导出（MATT-64 / F2-23） ───────────────── */

/**
 * 案件列表导出的 CSV 形状。
 *
 * 只测**不连库的那一半**：列序、转义、字典回落（`pnpm verify` 口径是离线可跑，
 * 与 `resolveClosingDate` 同一条理由）。"导出行数 == 同一筛选下列表的 total"
 * 那条最要紧的断言在真库上——`agent-work/smoke-list-export.mjs`。
 *
 * 为什么值得单独测列序：这份 CSV 的主要消费者是 Excel，列错位与串列只有人眼看得见，
 * 而 `csvCell` 的转义一旦被绕过（有人手写引号），症状只在含逗号的案件名上出现。
 */
describe("案件列表导出：CSV 形状（F2-23）", () => {
  const row = (over: Partial<MatterExportRow> = {}): MatterExportRow => ({
    internalCode: "AJ-2026-0001",
    caseNo: "(2026)苏01民初123号",
    name: "恒基建设施工合同纠纷",
    cause: "建设工程施工合同纠纷",
    procedure: "first_instance",
    level: "high",
    status: "in_progress",
    amount: "1200000.00",
    ownerName: "王小明",
    nextDeadline: "2026-10-20T09:00:00.000Z",
    updatedAt: "2026-10-14T02:00:00.000Z",
    ...over,
  });
  /** 状态与等级是**配置驱动**的（列表页从 /api/meta 取中文名），导出这一层自己查一次 */
  const dict = { statusNames: { in_progress: "进行中" }, levelNames: { high: "高风险" } };

  it("BOM 开头（Excel 中文表头不乱码）、中文表头、列序与列表一致", () => {
    const csv = mattersExportCsv([row()], dict);
    expect(csv.startsWith("\uFEFF内部编号,正式案号,案件名称,案由,程序,等级,状态,标的额")).toBe(
      true,
    );
    // 程序/等级/状态是**中文名**，不是库里那串 code（导出是给人看的台账，不是 dump）
    expect(csv).toContain("一审");
    expect(csv).toContain("高风险");
    expect(csv).toContain("进行中");
    expect(csv).toContain("2026-10-20T09:00:00.000Z");
  });

  it("逗号/引号/换行按公共件处理（与整卷、当事人导出同一份 csvCell）", () => {
    const csv = mattersExportCsv(
      [row({ name: '南京"鼎泰", 房地产\n第二行', cause: "买卖合同纠纷" })],
      dict,
    );
    expect(csv).toContain('"南京""鼎泰"", 房地产 第二行"');
    // 换行折成空格：Excel 里"一行一条记录"才对得上（表头 1 行 + 数据 1 行）
    expect(csv.split("\r\n")).toHaveLength(2);
  });

  it("空结果只给表头（不返回 undefined / 半行）", () => {
    const csv = mattersExportCsv([], dict);
    expect(csv.split("\r\n")).toHaveLength(1);
  });

  it("字典查不到就回落原始 code（停用状态的历史行不许导成空白）", () => {
    const csv = mattersExportCsv([row({ status: "custom_x", level: "weird" })], {});
    expect(csv).toContain("custom_x");
    expect(csv).toContain("weird");
  });

  it("没有最近期限时那一格是空的，不写 undefined", () => {
    const csv = mattersExportCsv([row({ nextDeadline: null })], dict);
    expect(csv).not.toContain("undefined");
    expect(csv).not.toContain("null");
  });
});

/* ───────────────── 源码守卫：导出与列表**同一套**谓词、特权只判一次（MATT-64） ───────────────── */

/**
 * 这两条钉的是本票最要紧的那句话的两半：
 *
 *   · **谓词只写一处**：导出集合与列表可见集合要逐行一致，而"第二处谓词"的失败形态
 *     是静默的（两处都 200，只是行数不同）——真库上由
 *     `agent-work/smoke-list-export.mjs` 的「导出行数 == 列表 total」盯着，
 *     离线这一半盯"结构上不可能有第二处"；
 *   · **特权只判一次**：`canReadPlain` 只在 HTTP 层（`requirePrivilege`）。服务层再判一次
 *     就会出现两套口径（与 `exportParties` 逐字同一条理由）。
 */
describe("守卫：案件列表导出的谓词与特权判定", () => {
  const raw = readFileSync("src/app/lib/server/services/matters.ts", "utf8");
  /** 剥注释再匹配：注释里必然会**写** `scopedWhere("matter"` 来解释为什么只许一处 */
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  /** 顶层函数体（切到下一个顶层函数声明为止）——用来问"这个函数里有没有那个调用" */
  const boundaries = [...code.matchAll(/^(?:export )?(?:async )?function \w+\(/gm)].map(
    (m) => m.index!,
  );
  const fnBody = (name: string) => {
    const start = code.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, "m"));
    expect(start, `找不到函数 ${name}（改名了？那这条守卫要跟着改）`).toBeGreaterThanOrEqual(0);
    return code.slice(start, boundaries.find((b) => b > start) ?? code.length);
  };

  it("列表那几个筛选条件各只写一次（第二处就是第二套列表谓词）", () => {
    // ⚠ 不数 `scopedWhere("matter"`：那一个在**逐条**可见性判定里正当地出现多次
    // （详情/改状态/删/加进展…每处都要按 id 判一次）。会漂的是**列表那套条件**：
    // 归档二态、关键词、缺材料 —— 它们只能住在 `mattersListWhere` 里。
    expect(code.match(/archivedFilter\("matter"/g) ?? []).toHaveLength(1);
    expect(code.match(/keywordFilter\("matter"/g) ?? []).toHaveLength(1);
    expect(code.match(/archiveMissingSql\(\)/g) ?? []).toHaveLength(1);
  });

  it("列表与导出走**同一个** where 构造器（各一次，不是各拼一遍）", () => {
    expect(fnBody("listMatters")).toContain("mattersListWhere(actor, q)");
    expect(fnBody("exportMatters")).toContain("mattersListWhere(actor, q)");
  });

  /**
   * 2026-10-19 新增的四格（案件类型 / 程序 / 经办人 / 期限范围）与指标带。
   *
   * 三条断言，各盯一个会静默失真的地方：
   *   · 新筛选只住在 `mattersListWhere` 里 —— 指标带复用**同一个函数**，
   *     若谁在指标那边另拼一份，"筛了三个条件、列表 3 行、卡片说 12 条"就会同时成立；
   *   · 指标与列表的 where 调用是同一处；
   *   · 指标那三个 `EXISTS` 的关联键写**裸限定名** `mn_matter.id` ——
   *     写成 `${matter.id}` 会被解析成 `n.matter_id = n.id`（恒假、静默 0），
   *     这个坑在本文件的 `nextDeadline` 上真实发生过一次。
   */
  it("新四格的谓词只写在 `mattersListWhere` 里（指标带复用同一处）", () => {
    expect(code.match(/eq\(matter\.caseType/g) ?? []).toHaveLength(1);
    expect(code.match(/eq\(matter\.procedure/g) ?? []).toHaveLength(1);
    expect(code.match(/eq\(matter\.ownerId, BigInt\(q\.owner\)\)/g) ?? []).toHaveLength(1);
    expect(code.match(/deadlineFilter\(q\.deadlineBucket\)/g) ?? []).toHaveLength(1);
  });

  it("指标带与列表**共用**那个 where（各拼一份就会对不上）", () => {
    expect(fnBody("matterMetrics")).toContain("mattersListWhere(actor, q)");
  });

  it("指标的 EXISTS 关联键是裸限定名 `mn_matter.id`（写成 `${matter.id}` 会恒假、静默 0）", () => {
    const metrics = fnBody("hasOpenNode") + fnBody("hasUnconfirmedNode");
    expect(metrics).toContain("n.matter_id = mn_matter.id");
    expect(metrics).not.toMatch(/n\.matter_id\s*=\s*"id"/);
  });

  it("服务层不出现 `canReadPlain`（明文导出的门只在 HTTP 层那一处）", () => {
    expect(code).not.toContain("canReadPlain");
  });
});
