# components/ui

前端**唯一**组件层（禁令⑦）：shadcn 复制件 + 自封装基元。业务组件只准依赖这一层，不得直接 import 原语包（Radix UI）。

第一期已确定要自封装的两件：

- `data-table/DataTable.tsx` —— 强制服务端分页/排序/筛选，每页上限 100（禁令⑧；理由是权限不是性能）
- `file-upload/FileUpload.tsx` —— 预签名 PUT 直传 MinIO；**React 侧有无现成件本轮未核到**，一律按自封装排期（P1-18）

位置说明：技术选型 §5 把本目录画在 `src/app/` 下，而 shadcn CLI 默认落 `src/components/ui`。
W0-2 装配时**按 §5 配 `components.json` 的 alias**，不要让两边各走一半；实测结论回填这里。
