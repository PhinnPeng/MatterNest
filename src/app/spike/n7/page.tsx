import { Suspense } from "react";
import { N7Table } from "@/app/components/spike/n7-table";
import { N7ConvertForm } from "@/app/components/spike/n7-convert-form";

/**
 * N7 spike 页。**页面壳零业务数据**（禁令⑥）：不查库、不 fetch，全部读取发生在下面的 client 组件里
 * 经 `/api/spike/matters` 进行。
 *
 * ⚠ `Suspense` 不是装饰：`N7Table` 用了 `useSearchParams()`，Next 16 在没有 Suspense 边界时
 * 静态预渲染会直接报 `useSearchParams() should be wrapped in a suspense boundary`。
 * 这条是本次实跑撞出来的，M3 的 14 个列表页都要照此包。
 */
export default function N7SpikePage() {
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 p-8">
      <header>
        <h1 className="text-xl font-semibold">N7 spike：数据表 + 动态数组表单</h1>
        <p className="text-sm text-muted-foreground">
          假数据、非业务页。表格参数走 URL 搜索参数，翻页与排序都打 <code>/api/spike/matters</code>
          。
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-medium">
          一、表格（服务端分页/排序/筛选 + 批量选择 + 列显隐）
        </h2>
        <Suspense fallback={<p className="text-sm text-muted-foreground">加载表格…</p>}>
          <N7Table />
        </Suspense>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-medium">二、动态数组表单（错误定位到第几张卡、哪个字段）</h2>
        <N7ConvertForm />
      </section>
    </main>
  );
}
