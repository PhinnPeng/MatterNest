# N7 spike 执行清单

1. [x] 依赖：`@tanstack/react-table` `react-hook-form` `zod` `@hookform/resolvers` `@tanstack/react-query`
2. [x] `src/shared/schema/list-query.ts`（含 `pageSize ≤ 100`）+ 测试
3. [x] `src/shared/schema/convert-form.ts`（动态数组 + 跨字段 + 复制白名单）+ 测试
4. [x] `src/app/lib/server/spike/matters.ts` 纯函数 + 排序/筛选/分页测试
5. [x] `src/app/api/spike/matters/route.ts` 薄壳
6. [x] `src/app/components/ui/data-table/`（DataTable + 列辅助）
7. [x] `src/app/components/spike/n7-table.tsx` / `n7-convert-form.tsx`（client）
8. [x] `src/app/spike/n7/page.tsx`（壳，零业务数据）+ `Providers`（QueryClientProvider）
9. [x] `pnpm verify` + `pnpm build` + `/spike/n7` HTML 取证（含一次翻页/排序请求）
10. [x] 结论回写：研究文档 §5 N7 行、`spec/frontend/{component,hook,state-management,quality}`、CHANGELOG
11. [x] 提交 + archive + journal（本票闭环；交互层遗留项登记在 prd 与研究文档 §7.3）

## 验证命令

```bash
pnpm verify && pnpm build
pnpm dev &  # 然后
curl -s "http://127.0.0.1:3000/api/spike/matters?page=2&pageSize=20&sortBy=updated_at&sortDir=desc"
curl -s "http://127.0.0.1:3000/api/spike/matters?pageSize=500"   # 期望被 schema 拒
curl -s http://127.0.0.1:3000/spike/n7 | grep -o "第 3 张卡\|<table"
```

## 回滚点

全部新增文件 + 五个依赖；`git clean -fd src/app/{api,components/spike,spike} src/shared/schema src/app/lib/server && git checkout package.json pnpm-lock.yaml` 可退回。
唯一要留的是研究文档 §5 的 N7 结论行（那是本票的产出物）。
