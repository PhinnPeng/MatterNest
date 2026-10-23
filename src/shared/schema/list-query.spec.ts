import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  listQuerySchema,
  matterListExportQuerySchema,
  ownerEmptyField,
  riskMatterListExportQuerySchema,
  searchParamsToRecord,
} from "./list-query";

/**
 * 禁令⑧ 的"每页上限 100"到底由谁拦——这条测试就是答案：**由 shared 里这份 schema 拦**，
 * 客户端与服务端各 parse 一次同一份定义。
 */
describe("listQuerySchema", () => {
  it("缺省值：第 1 页、每页 20、按 updated_at 倒序", () => {
    const q = listQuerySchema.parse({});
    expect(q).toMatchObject({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      sortBy: "updated_at",
      sortDir: "desc",
    });
  });

  it(`pageSize 上限 ${MAX_PAGE_SIZE} 拦得住（超了是拒绝，不是静默夹到 100）`, () => {
    expect(listQuerySchema.safeParse({ pageSize: MAX_PAGE_SIZE })).toMatchObject({ success: true });
    const over = listQuerySchema.safeParse({ pageSize: MAX_PAGE_SIZE + 1 });
    expect(over.success).toBe(false);
    if (!over.success) {
      expect(over.error.issues[0]?.path).toEqual(["pageSize"]);
    }
  });

  it("字符串数字会被 coerce（URL 参数天然是字符串）", () => {
    const q = listQuerySchema.parse({ page: "3", pageSize: "50" });
    expect(q.page).toBe(3);
    expect(q.pageSize).toBe(50);
  });

  it("sortBy 只认白名单列——自由字符串会变成注入面", () => {
    expect(listQuerySchema.safeParse({ sortBy: "amount" }).success).toBe(true);
    expect(listQuerySchema.safeParse({ sortBy: "id; drop table matter" }).success).toBe(false);
  });

  it("status 只认四个枚举值，keyword 超长被拒", () => {
    expect(listQuerySchema.safeParse({ status: "closed" }).success).toBe(true);
    expect(listQuerySchema.safeParse({ status: "whatever" }).success).toBe(false);
    expect(listQuerySchema.safeParse({ keyword: "x".repeat(61) }).success).toBe(false);
  });

  it("archivedOnly：URL 里的 'false' 不能被判成 true", () => {
    // 反面教材是 z.coerce.boolean() —— Boolean("false") === true，
    // 那会让"退出归档视图"静默变成"一直看归档"。
    expect(listQuerySchema.parse({ archivedOnly: "false" }).archivedOnly).toBe(false);
    expect(listQuerySchema.parse({ archivedOnly: "1" }).archivedOnly).toBe(true);
    expect(listQuerySchema.parse({}).archivedOnly).toBe(false);
    expect(listQuerySchema.safeParse({ archivedOnly: "yes" }).success).toBe(false);
  });

  /**
   * 案件查询区的四格（2026-10-19，canon `matters.html`）。
   *
   * 这四条盯的是**值域**而不是"能不能传"：`deadlineBucket` 是个闭集，写错一个字母
   * （`"due"` 而不是 `"soon"`）若被静默当成"不限"，用户会看到"筛选点了没反应"——
   * 与 `ownerEmpty` 那类事故同一个长相。
   */
  describe("案件查询区新增的四格", () => {
    it("caseType / procedure 收非空字符串（值域由库里的 CHECK 回答，不在前端收枚举）", () => {
      expect(listQuerySchema.safeParse({ caseType: "civil_commercial" }).success).toBe(true);
      expect(listQuerySchema.safeParse({ procedure: "first_instance" }).success).toBe(true);
      // 空串不算筛选值：「全部」发的是**不发这个键**
      expect(listQuerySchema.safeParse({ caseType: "" }).success).toBe(false);
      expect(listQuerySchema.safeParse({ caseType: "x".repeat(25) }).success).toBe(false);
    });

    it("owner 只认数字串（它要转 bigint 进 SQL，非数字该在这里 400 而不是 BigInt 抛 500）", () => {
      expect(listQuerySchema.safeParse({ owner: "7001" }).success).toBe(true);
      expect(listQuerySchema.safeParse({ owner: "abc" }).success).toBe(false);
      expect(listQuerySchema.safeParse({ owner: "7001; drop table" }).success).toBe(false);
    });

    it("deadlineBucket 四值闭集；`none` 是「未定期限」不是「不限」", () => {
      for (const v of ["overdue", "soon", "later", "none"] as const) {
        expect(listQuerySchema.parse({ deadlineBucket: v }).deadlineBucket).toBe(v);
      }
      // 拼错的值要被拒，而不是当成"不限"静默通过
      expect(listQuerySchema.safeParse({ deadlineBucket: "due" }).success).toBe(false);
      expect(listQuerySchema.safeParse({ deadlineBucket: "1" }).success).toBe(false);
      // 不传 = 不限（undefined），与 `none` 是两件事
      expect(listQuerySchema.parse({}).deadlineBucket).toBeUndefined();
    });
  });
});

describe("searchParamsToRecord", () => {
  it("把 URLSearchParams 摊平成 schema 入参", () => {
    const sp = new URLSearchParams("page=2&pageSize=10&sortBy=code&sortDir=asc&status=closed");
    expect(searchParamsToRecord(sp)).toEqual({
      page: "2",
      pageSize: "10",
      sortBy: "code",
      sortDir: "asc",
      status: "closed",
    });
  });
});

/* ───────────────── 列表导出的查询面（MATT-64 / F1-20 + F2-23） ───────────────── */

/**
 * 为什么要有这一组：导出要"吃列表当前的筛选"，而**少一个筛选不会报错** ——
 * 症状是"列表 21 行、导出 43 行"（参数被 zod 静默剥掉，导出的是没筛过的全量）。
 * 所以这里钉两件事：
 *   ① **键集合**逐字列出（独立真源，不是从另一份 schema 现算的）；
 *   ② 字段是**同一个对象**，不是照抄一份值域 —— 照抄的那份会在某次改动里漂开，
 *      而两处都不报错。
 */
const keysOf = (shape: Record<string, unknown>, drop: readonly string[]) =>
  Object.keys(shape)
    .filter((k) => !drop.includes(k))
    .sort();

describe("列表导出的查询面与列表同源", () => {
  it("案件导出吃的筛选键就是列表那几个（多一个少一个都红）", () => {
    // 这是**列表**的筛选面（分页不算，导出没有分页）；`plain` 是导出自己的档位。
    // 2026-10-19 加了原型查询区的四格：案件类型 / 案件程序 / 经办人 / 期限范围。
    // 它们必须同时出现在这两份 shape 里——只加列表那一侧，导出会少筛一层而不报错，
    // 用户拿到的行数与列表对不上。
    const EXPECTED = [
      "archivedOnly",
      "caseType",
      "deadlineBucket",
      "keyword",
      "missingMaterials",
      "owner",
      "procedure",
      "sortBy",
      "sortDir",
      "status",
    ];
    expect(keysOf(matterListExportQuerySchema.shape, ["plain"])).toEqual(EXPECTED);
    expect(keysOf(listQuerySchema.shape, ["page", "pageSize"])).toEqual(EXPECTED);
  });

  it("事项导出比案件侧多 `ownerEmpty`（案件必有负责人，事项可空，IQ-5）", () => {
    expect(keysOf(riskMatterListExportQuerySchema.shape, ["plain"])).toEqual([
      "archivedOnly",
      "keyword",
      "owner",
      "ownerEmpty",
      "reportBucket",
      "riskLevel",
      "sortBy",
      "sortDir",
      "status",
    ]);
  });

  it("同一个字段**对象**（照抄一份值域是这条要拦的事）", () => {
    // `as const` 不是装饰：这里逐个键索引 `.shape`，收窄成字面量联合才会在
    // "导出侧少了一个键"时编译红，而不是静默 `undefined`
    const shared = [
      "status",
      "keyword",
      "archivedOnly",
      "missingMaterials",
      "caseType",
      "procedure",
      "owner",
      "deadlineBucket",
      "sortBy",
      "sortDir",
    ] as const;
    for (const k of shared) {
      expect(matterListExportQuerySchema.shape[k], `${k} 不是列表用的那个对象`).toBe(
        listQuerySchema.shape[k],
      );
    }
    expect(riskMatterListExportQuerySchema.shape.ownerEmpty).toBe(ownerEmptyField);
  });

  it("默认值：不传参数 = 全部不限、按更新时间倒序、脱敏档", () => {
    expect(matterListExportQuerySchema.parse({})).toMatchObject({
      sortBy: "updated_at",
      sortDir: "desc",
      archivedOnly: false,
      plain: false,
    });
  });

  it("两档：`1`/`true` 才是明文，`0` 是脱敏，写错的字面量一律拒（与 archivedOnly 同一条纪律）", () => {
    for (const v of ["1", "true"] as const) {
      expect(matterListExportQuerySchema.parse({ plain: v }).plain).toBe(true);
      expect(riskMatterListExportQuerySchema.parse({ plain: v }).plain).toBe(true);
    }
    for (const v of ["0", "false"] as const) {
      expect(matterListExportQuerySchema.parse({ plain: v }).plain).toBe(false);
    }
    // 手打的参数写错该红：`plain=yes` 若被当成 false 静默降级，用户以为导了明文
    expect(matterListExportQuerySchema.safeParse({ plain: "yes" }).success).toBe(false);
    expect(riskMatterListExportQuerySchema.safeParse({ plain: "yes" }).success).toBe(false);
  });

  it("导出不吃分页：带上去也只是被剥掉，不会变成「只导第一页」", () => {
    const q = matterListExportQuerySchema.parse({ page: "3", pageSize: "5", status: "closed" });
    expect(q).not.toHaveProperty("page");
    expect(q).not.toHaveProperty("pageSize");
    expect(q).toMatchObject({ status: "closed" });
  });
});
