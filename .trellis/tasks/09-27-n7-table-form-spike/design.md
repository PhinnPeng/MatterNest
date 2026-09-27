# N7 spike 设计

## 分层（故意把逻辑放在可测的地方）

```text
src/shared/schema/list-query.ts     Zod：page/pageSize(≤100)/sortBy 枚举/sortDir/filters  ← 上限在这里拦
src/shared/schema/convert-form.ts   Zod：动态数组表单（N 张卡 + 跨字段规则 + 复制白名单）
src/app/lib/server/spike/matters.ts 纯函数 queryMatters(rows, q)：排序→筛选→分页→{items,total}
src/app/api/spike/matters/route.ts  薄壳：解析 URL → 两个 schema 各 parse 一次 → 返回 JSON
src/app/components/ui/data-table/   DataTable.tsx（headless 装配 + 受控参数）+ 列定义辅助
src/app/components/spike/n7-*.tsx   client 组件：表格 + 动态数组表单
src/app/spike/n7/page.tsx           页面壳（零业务数据，禁令⑥）
```

**为什么 `queryMatters` 是纯函数**：Route Handler 里塞逻辑就没法在 vitest 里测（要造 Request），
而"排序/筛选/分页的正确性 + 上限"恰好是本票要证明的东西。薄壳 + 可测内核，也是 W2-1 仓储层的形状。

## 三个设计选择（都是 spec 里悬着、要靠实跑定的）

1. **参数放 URL 搜索参数**，不放组件内 state。理由：`state-management.md` 里我写过"URL 态是本轮新增口径"，
   这次正好验它成不成立——如果 react-table 的受控模式跟 URL 同步别扭，就回来把那条改掉，不硬撑。
2. **`pageSize` 上限拦在 Zod schema**（`z.number().max(100)`），Route Handler 与客户端各 parse 一次同一份 schema
   （禁令⑧"校验单源"的兑现方式）。客户端拦是体验，服务端拦才是防线，两者共用一份定义。
3. **跨卡复制用字段白名单而不是黑名单**。id 类字段（`matter_id`/`node_id`/`client_id`）不参与复制（矩阵 §3）——
   黑名单会随字段增加而漏，白名单漏了会立刻在表单上看见，失败模式更便宜。白名单常量放 `src/shared/schema/convert-form.ts`。

## 错误定位的形态

Zod 的 `issue.path` 是 `["cases", 2, "client_name"]` 这种。要变成人话需要一层映射：

```
cases[2].client_name  →  「第 3 张卡 · 当事人名称」
```

索引 +1（人从 1 数起）+ 字段名查中文名字典（字典仍在 `shared`，不另写一份）。
**这层映射本身要测**，因为它是"错误能定位到第几张卡"这条通过标准的实现。

## 不做

- 不引 `@tanstack/react-query` 之外的数据层；不写乐观更新（M3 再说）。
- 不做虚拟滚动、列固定、拖拽（§12.4 已定第一期可放弃）。
- 不碰真库与 `withScope`（N2）。
