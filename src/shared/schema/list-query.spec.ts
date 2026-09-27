import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  listQuerySchema,
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
