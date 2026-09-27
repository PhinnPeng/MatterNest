import { describe, expect, it } from "vitest";
import { buildSpikeRows, queryMatters, SPIKE_ROWS } from "./matters";
import { listQuerySchema } from "@/shared/schema/list-query";

const rows = buildSpikeRows(237);

const base = { page: 1, pageSize: 20, sortBy: "code", sortDir: "asc" } as const;

describe("queryMatters：分页/排序/筛选都在服务端", () => {
  it("返回的是当页，total 是全量——客户端拿不到全量数据", () => {
    const r = queryMatters(rows, { ...base, ...listQuerySchema.parse({}) });
    expect(r.items.length).toBe(20);
    expect(r.total).toBe(237);
    expect(r.items.length).toBeLessThan(r.total); // 这条就是"不许客户端全量排序"的前提
  });

  it("翻页不重不漏：12 页 × 20 条 = 237 条且 id 唯一", () => {
    const seen = new Set<string>();
    for (let p = 1; p <= 12; p += 1) {
      const r = queryMatters(rows, {
        ...base,
        page: p,
        pageSize: 20,
        sortBy: "code",
        sortDir: "asc",
      });
      r.items.forEach((x) => seen.add(x.id));
    }
    expect(seen.size).toBe(237);
  });

  it("排序方向真的生效（按 amount 升序 vs 降序的首行互为两端）", () => {
    const asc = queryMatters(rows, { ...base, sortBy: "amount", sortDir: "asc" });
    const desc = queryMatters(rows, { ...base, sortBy: "amount", sortDir: "desc" });
    expect(asc.items[0]?.amount).toBe("1000.00");
    expect(desc.items[0]?.amount).toBe("237000.00");
  });

  it("筛选后 total 跟着变小，分页按筛选结果重算", () => {
    const r = queryMatters(rows, {
      ...base,
      status: "closed",
      page: 1,
      pageSize: 20,
      sortBy: "code",
      sortDir: "asc",
    });
    expect(r.items.every((x) => x.status === "closed")).toBe(true);
    expect(r.total).toBe(rows.filter((x) => x.status === "closed").length);
    expect(r.total).toBeLessThan(237);
  });

  it("关键词命中编号/名称/负责人任一列", () => {
    const r = queryMatters(rows, { ...base, keyword: "陈律师", sortBy: "code", sortDir: "asc" });
    expect(r.total).toBeGreaterThan(0);
    expect(r.items.every((x) => x.owner_name === "陈律师")).toBe(true);
  });

  it("越界页码返回空列表而不是报错（真接口同理，前端要能处理）", () => {
    const r = queryMatters(rows, { ...base, page: 999 });
    expect(r.items).toEqual([]);
    expect(r.total).toBe(237);
  });

  it("数据集是确定性的：同参数两次调用结果一致（测试与 dev 才不会各说各话）", () => {
    const a = queryMatters(SPIKE_ROWS, { ...base });
    const b = queryMatters(SPIKE_ROWS, { ...base });
    expect(a.items.map((x) => x.id)).toEqual(b.items.map((x) => x.id));
  });
});
