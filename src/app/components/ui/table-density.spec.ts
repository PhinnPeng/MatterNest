import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 表格密度契约的回归守卫。
 *
 * 为什么用"读源码字符串"这种看起来很难看的方式：这次的事故不是有人写错逻辑，
 * 而是 `shadcn add -y -o ... table ...` 把自封装的 `ui/table.tsx` **换成了 registry 默认版**，
 * 而 `DataTable` 对密度的假设没跟着复核。装完当场 diff 过"哪些文件变了"，
 * 但没人回头看"依赖这些文件的代码还成立吗"——所以守卫必须钉在**类名**这一层，
 * 因为出问题的就是类名。组件行为测试反而拦不住：官方版行为完全正常，只是不密集。
 *
 * 事故实测值（1440×900 同源 iframe）：表头背景透明 · 表头 14px/text-foreground · 单元格 p-2 · 「程序」列 45px。
 *
 * ⚠ 断言一律先按函数体切片再匹配。第一版我用 `function TableHeader[\s\S]*?bg-muted\/40`，
 * `[\s\S]*?` 会**跨函数**漂到后面的类名上，于是把 `bg-muted/40` 删掉它照样绿——
 * 我拿反向验证撞出来的。守卫自己的假通过比没有守卫更糟。
 */

const TABLE = readFileSync(new URL("./table.tsx", import.meta.url), "utf8");
const DATATABLE = readFileSync(new URL("./data-table/DataTable.tsx", import.meta.url), "utf8");

/** 取出某个组件函数的源码体（从它的 `function Name(` 到下一个顶层 `}`） */
function fn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`找不到 ${name}`);
  const end = src.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} 的函数体没闭合`);
  return src.slice(start, end);
}

describe("表格密度契约（防被 shadcn add -o 静默覆盖）", () => {
  it("表头：比正文弱（h-9 + 12px + muted），且带底槽", () => {
    const head = fn(TABLE, "TableHead");
    expect(head).toMatch(/h-9/);
    expect(head).toMatch(/px-3/);
    expect(head).toMatch(/text-xs/);
    expect(head).toMatch(/text-muted-foreground/);
    expect(fn(TABLE, "TableHeader")).toMatch(/bg-muted\/40/);
  });

  it("单元格：左右 12px（不是 registry 默认的 p-2=8px），溢出裁掉而不是把列顶宽", () => {
    const cell = fn(TABLE, "TableCell");
    expect(cell).toMatch(/px-3 py-2/);
    expect(cell).toMatch(/overflow-hidden/);
    expect(cell).toMatch(/text-ellipsis/);
  });

  it("行 hover 用主色淡底，不用灰底（纸色背景上灰底几乎不可见）", () => {
    const row = fn(TABLE, "TableRow");
    expect(row).toMatch(/hover:bg-primary\/\[0\.04\]/);
    expect(row).not.toMatch(/hover:bg-muted/);
  });

  it("列宽真的生效：DataTable 传 table-fixed 且有 colgroup 消费 size", () => {
    expect(DATATABLE).toMatch(/<Table className="table-fixed">/);
    expect(DATATABLE).toMatch(/<colgroup>/);
    expect(DATATABLE).toMatch(/getVisibleLeafColumns\(\)\.map/);
    expect(DATATABLE).toMatch(/getSize\(\)/);
  });

  it("table-fixed 不在原语里（详情页/配置页没有 colgroup，fixed 会把列平均切）", () => {
    expect(fn(TABLE, "Table")).not.toMatch(/table-fixed/);
  });

  it("守卫本身不跨函数匹配（防这份 spec 退化成假通过）", () => {
    // TableFooter 官方就带 bg-muted/50；如果 TableHeader 的断言写得漂出函数体，
    // 它会匹配到 footer 那一行 → 删掉表头底色也测不出来。这里把这条依赖钉住。
    expect(fn(TABLE, "TableFooter")).toMatch(/bg-muted\/50/);
    expect(fn(TABLE, "TableHeader")).not.toMatch(/bg-muted\/50/);
  });
});
