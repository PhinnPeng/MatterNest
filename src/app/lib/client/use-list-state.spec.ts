import { describe, expect, it } from "vitest";

import { REPORT_FILTER_KEYS, REPORT_OMITTED_KEYS } from "@/shared/schema/list-query";
import { toQuery, toReportQuery, type ListState } from "./use-list-state";

/**
 * `toQuery` 的守卫（MATT-42 期间补）。
 *
 * ## 为什么必须有这条测试
 *
 * 这里出过一次**真缺陷**：`ListState` 有 `ownerEmpty`，事项列表的「只看未指派」筛选
 * 在 URL 里读写正常、界面也回显正常，**但 `toQuery` 不输出它** ⇒ 请求里根本没有这个参数
 * ⇒ 服务端按"不限"处理。用户看到的是"筛选点了没反应"。
 *
 * 它躲过了所有既有门禁：服务端那条筛选**有**真 HTTP 断言（`smoke-risk` 三条，全绿），
 * 因为坏的是客户端拼串这一步；类型检查也过（少输出一个可选参数不是类型错）。
 *
 * 所以这条测试断言的是**结构**而不是某个具体字段：`ListState` 里凡是"筛选类"的键，
 * 都必须出现在 `toQuery` 的输出里。将来再加一个筛选开关而忘了在这里输出，它会红。
 */

/**
 * 与 `ListState` 的筛选类键一一对应。
 *
 * ⚠ **这里曾经是一份手维护清单**，而检查子代理用一次变异证明了它拦不住它声称要拦的事：
 * 给 `ListState` 加一个新筛选键（不写 `toQuery`、也不加进本数组）→ **12 条全绿**。
 * 那正是 `ownerEmpty` 真实出过的 bug 形态（新增键时漏输出），所以"结构性断言"名不副实。
 *
 * 现在下面那条 `_exhaustive` 把它变成**编译期**约束：`ListState` 里凡不是分页/排序的键，
 * 都必须出现在 `FILTER_KEYS` 里，否则 `MissingFilterKey` 不是 `never` ⇒ 编译错。
 */
const FILTER_KEYS = [
  "keyword",
  "status",
  "archivedOnly",
  "ownerEmpty",
  "missingMaterials",
] as const;

/** 分页与排序不属于"筛选开关"——它们由 `toQuery` 无条件带上，不参与这条断言 */
type NonFilterKey = "page" | "pageSize" | "sortBy" | "sortDir";
/**
 * ⚠ `Exclude<…, undefined>` 是必需的：`ownerEmpty` / `missingMaterials` 是**可选**键，
 * 索引它们会带出 `undefined`，而 `undefined` 不在 `FILTER_KEYS` 里 ⇒ 这条穷尽性检查
 * 会对着 `undefined` 报错（第一次跑就是这么红的——说明它真的会咬人，不是装饰）。
 */
type FilterKeyOf<S> = Exclude<
  { [K in keyof S]: K extends NonFilterKey ? never : K }[keyof S],
  undefined
>;
type MissingFilterKey = Exclude<FilterKeyOf<ListState>, (typeof FILTER_KEYS)[number]>;

// 编译期穷尽性检查：新增筛选键而忘了登记 ⇒ **这一行报错**（不用等到运行时）
const _exhaustive: MissingFilterKey extends never ? true : never = true;
void _exhaustive;

const ALL_ON: ListState = {
  page: 2,
  pageSize: 50,
  sortBy: "name",
  sortDir: "asc",
  keyword: "合同",
  status: "in_progress",
  archivedOnly: true,
  ownerEmpty: "1",
  missingMaterials: "1",
};

describe("toQuery：筛选开关不许被静默丢掉", () => {
  it("分页与排序恒在", () => {
    const q = new URLSearchParams(toQuery(ALL_ON));
    expect(q.get("page")).toBe("2");
    expect(q.get("pageSize")).toBe("50");
    expect(q.get("sortBy")).toBe("name");
    expect(q.get("sortDir")).toBe("asc");
  });

  it.each(FILTER_KEYS)("筛选键 %s 在开启时出现在请求串里", (key) => {
    const q = new URLSearchParams(toQuery(ALL_ON));
    // `archivedOnly` / `ownerEmpty` / `missingMaterials` 用 "1" 表示开；其余是原值
    expect(q.has(key)).toBe(true);
    expect(q.get(key)).toBeTruthy();
  });

  it.each(FILTER_KEYS)("筛选键 %s 在关闭时不出现（不发空参数）", (key) => {
    const off: ListState = {
      ...ALL_ON,
      keyword: "",
      status: "",
      archivedOnly: false,
      ownerEmpty: undefined,
      missingMaterials: undefined,
    };
    expect(new URLSearchParams(toQuery(off)).has(key)).toBe(false);
  });

  it('三态筛选：`undefined` 是不限，`"1"` 才是开启（没有第三个值可写）', () => {
    // `ownerEmpty` / `missingMaterials` 的类型是字面量 `"1"`，所以 `"0"` / `"yes"`
    // 这类"看着像关闭"的值**写不出来**（编译期就红）——这正是收窄类型的目的：
    // 否则 `toQuery` 的 `if (s.ownerEmpty)` 会把它们当成开启发出去，而后端只收 1/true（400）。
    const off = new URLSearchParams(toQuery({ ...ALL_ON, ownerEmpty: undefined }));
    expect(off.has("ownerEmpty")).toBe(false);
    const on = new URLSearchParams(toQuery({ ...ALL_ON, ownerEmpty: "1" }));
    expect(on.get("ownerEmpty")).toBe("1");
  });
});

/* ───────────────────── 报表卡吃哪几个筛选（F8-1 随筛选联动） ───────────────────── */

/**
 * `REPORT_FILTER_KEYS` / `REPORT_OMITTED_KEYS` 必须**恰好划分** `ListState` 的筛选类键。
 *
 * 两条编译期约束，而不是运行时断言：新增一个筛选键（比如哪天加个"只看我关注"）却忘了
 * 分类，`_partition` 那一行直接编译红。运行时断言做不到这件事——它只能检查"我想到的键"
 * （`ownerEmpty` 漏进 `toQuery` 时 12 条运行时断言全绿，正是这个原因，见文件头注）。
 */
type ReportKey = (typeof REPORT_FILTER_KEYS)[number];
type OmittedKey = (typeof REPORT_OMITTED_KEYS)[number];
/** 既没进报表、也没被明确排除的键 ⇒ 分类漏了一个 */
type Unclassified = Exclude<FilterKeyOf<ListState>, ReportKey | OmittedKey>;
const _partition: Unclassified extends never ? true : never = true;
/** 同一个键不能既进又出（`Extract` 非 never 就是两边都写了） */
type Overlap = Extract<ReportKey, OmittedKey>;
const _noOverlap: Overlap extends never ? true : never = true;
void _partition;
void _noOverlap;

describe("toReportQuery：报表只吃那三个筛选", () => {
  it("筛选开启时逐个出现（键名与列表逐字相同）", () => {
    const q = new URLSearchParams(toReportQuery(ALL_ON));
    for (const key of REPORT_FILTER_KEYS) {
      expect(q.get(key), `${key} 没进报表请求串`).toBeTruthy();
    }
  });

  it("全部关闭时一个都不发（不发空参数）", () => {
    const off: ListState = {
      ...ALL_ON,
      status: "",
      archivedOnly: false,
      ownerEmpty: undefined,
    };
    expect(toReportQuery(off)).toBe("");
  });

  it.each(REPORT_OMITTED_KEYS)(
    "`%s` 一律不进报表请求串（关键词/分页/排序不是筛选，理由见 shared 的分类表）",
    (key) => {
      // ALL_ON 里这些键全都是"开着"的值，所以这条断言真的在拦东西
      expect(new URLSearchParams(toReportQuery(ALL_ON)).has(key)).toBe(false);
    },
  );

  it("请求串的键集合 == 开着的那些 REPORT_FILTER_KEYS（不许多、不许少）", () => {
    const keys = [...new URLSearchParams(toReportQuery(ALL_ON)).keys()].sort();
    expect(keys).toEqual([...REPORT_FILTER_KEYS].sort());
  });
});
