"use client";

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "@/shared/schema/list-query";

/**
 * 列表状态放在 **URL** 里，而不是组件 state。
 *
 * 四个理由，按分量排：
 *   1. 内网系统里"把这个筛选结果发给同事看"是真实诉求，URL 是唯一能承载它的地方；
 *   2. 浏览器的前进/后退自然回到上一个筛选态，不需要自己维护历史；
 *   3. 详情页返回列表时筛选不丢（组件被卸载了，URL 还在）；
 *   4. 服务端只认查询串，所以"前端传什么服务端信什么"这条越权面在这里被压成零：
 *      参数照样要过 `listQuerySchema`（禁令⑧），URL 只是搬运工。
 *
 * `pageSize` 越界**不在这里夹**：让 URL 上的 `pageSize=500` 原样发出去，
 * 由服务端 400 + 前端显示错误条。静默夹小等于把违规参数藏起来。
 */
export type ListState = {
  page: number;
  pageSize: number;
  sortBy: string;
  sortDir: "asc" | "desc";
  keyword: string;
  status: string;
  /** 归档视图（二态）：false=在办列表，true=归档视图。取代旧的"混入"开关。 */
  archivedOnly: boolean;
  /**
   * 只看**未指派处理人**的事项（T1）。
   *
   * 放在共享的 `ListState` 里而不是事项视图的局部 state：筛选条件必须能进 URL，
   * 否则"把这条筛选发给同事"就做不到，而那是筛选器最基本的一条。
   * `undefined` = 不限（后端 `ownerEmptyField` 的第三态）。
   *
   * ⚠ 类型是字面量 `"1"` 而不是 `string`：解析器只产 `"1"` 或 `undefined`，
   * 放开成 `string` 会让 `"0"`、`"yes"` 这类**没有意义的值**在类型层合法，
   * 而 `toQuery` 的 `if (s.ownerEmpty)` 会把它们当成"开启"发出去（后端只收 1/true ⇒ 400）。
   * 收窄之后，写错值在编译期就红，不用等运行时。
   */
  ownerEmpty?: "1";
  /**
   * 只看**已结案缺材料**的案件（F2-26 / G4 的运维视角出口）。
   *
   * 与 `ownerEmpty` 同理由放在这里：筛选必须能进 URL。三态与它一致
   * （`undefined` / `""` = 不限，`"1"` = 只看缺材料的）。
   *
   * ⚠ 只对**已归档**的案件有意义——谓词里带了 `is_archived = true`，
   * 所以它在归档视图里才有内容，在办列表上恒为空。
   *
   * 类型同样是字面量 `"1"`（理由见 `ownerEmpty`）。
   */
  missingMaterials?: "1";
};

export function useListState(defaults?: Partial<ListState>) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const state = useMemo<ListState>(
    () => ({
      page: Number(sp.get("page") ?? 1) || 1,
      pageSize:
        Number(sp.get("pageSize") ?? defaults?.pageSize ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE,
      sortBy: sp.get("sortBy") ?? defaults?.sortBy ?? "updated_at",
      sortDir: sp.get("sortDir") === "asc" ? "asc" : "desc",
      keyword: sp.get("keyword") ?? "",
      status: sp.get("status") ?? "",
      archivedOnly: sp.get("archivedOnly") === "1" || sp.get("archivedOnly") === "true",
      // 三态与 ownerEmpty 一致：`undefined` = 不限（"0"/空串都不算开了筛选）
      ownerEmpty: sp.get("ownerEmpty") === "1" || sp.get("ownerEmpty") === "true" ? "1" : undefined,
      missingMaterials:
        sp.get("missingMaterials") === "1" || sp.get("missingMaterials") === "true"
          ? "1"
          : undefined,
    }),
    [sp, defaults?.pageSize, defaults?.sortBy],
  );

  /** `patch` 里值为空/默认值的键会被删掉，URL 保持干净（`?status=&page=1` 那种噪音） */
  const push = useCallback(
    (patch: Partial<Record<keyof ListState, string | number | boolean>>) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === "" || v === undefined || v === false) next.delete(k);
        else next.set(k, String(v));
      }
      // 改了筛选条件就回到第 1 页——除非这次调用本身就是在改页码
      if (!("page" in patch)) next.delete("page");
      const q = next.toString();
      router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
    },
    [router, pathname, sp],
  );

  const href = useCallback(
    (patch: Partial<Record<keyof ListState, string | number | boolean>>) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === "" || v === undefined || v === false) next.delete(k);
        else next.set(k, String(v));
      }
      if (!("page" in patch)) next.delete("page");
      const q = next.toString();
      return q ? `${pathname}?${q}` : pathname;
    },
    [sp, pathname],
  );

  return { state, push, href, maxPageSize: MAX_PAGE_SIZE };
}

/** 把状态拼成请求串（空值不发，免得服务端收到 `keyword=`）。 */
export function toQuery(s: ListState): string {
  const p = new URLSearchParams();
  p.set("page", String(s.page));
  p.set("pageSize", String(s.pageSize));
  p.set("sortBy", s.sortBy);
  p.set("sortDir", s.sortDir);
  if (s.keyword) p.set("keyword", s.keyword);
  if (s.status) p.set("status", s.status);
  if (s.archivedOnly) p.set("archivedOnly", "1");
  // ⚠ 下面两个是**筛选开关**，漏掉任何一个都是"界面里点了没反应"：
  //   `state` 从 URL 读得到、界面也回显了，但请求里没有它 ⇒ 服务端按"不限"处理 ⇒
  //   用户看到的是"筛选不生效"而不是报错。`ownerEmpty` 就真的这样漏过一次
  //   （服务端筛选有断言、且是对的；坏的只有这里），所以补了 `use-list-state.spec.ts`
  //   那条结构性断言：**ListState 里每个筛选键都必须出现在 toQuery 的输出里**。
  if (s.ownerEmpty) p.set("ownerEmpty", "1");
  if (s.missingMaterials) p.set("missingMaterials", "1");
  return p.toString();
}
