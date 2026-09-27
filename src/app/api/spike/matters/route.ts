import { NextResponse } from "next/server";
import { listQuerySchema, searchParamsToRecord } from "@/shared/schema/list-query";
import { queryMatters, SPIKE_ROWS } from "@/app/lib/server/spike/matters";

/**
 * N7 spike 的假接口（**不是业务接口**）。存在的目的有两个：
 * 1. 让"服务端分页/排序/筛选"在没有数据库与 `ScopeResolver` 的情况下也能被真实调用；
 * 2. 第一次实跑禁令⑤⑥：业务读取走 `/api/**`、返回体一律 JSON、页面壳不碰数据。
 *
 * ⚠ 这里**故意没有** `withScope()`——那是 N2/W0-6 的内容（要连库才能验）。
 * 真接口落地时，本目录整体删除，别把它当范式抄。
 */
export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const parsed = listQuerySchema.safeParse(searchParamsToRecord(url.searchParams));

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_query",
        issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      },
      { status: 400 },
    );
  }

  const { items, total } = queryMatters(SPIKE_ROWS, parsed.data);
  return NextResponse.json({
    items,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    total,
  });
}
