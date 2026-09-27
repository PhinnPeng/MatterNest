# src/app

App Router 与 Route Handlers 的落点（技术选型 §5）。**本票只建骨架，不放业务代码。**

- `api/**` —— 唯一业务写入口，每个 handler 内 `withScope()`（禁令⑤）
- `components/ui/` —— 前端唯一组件层（禁令⑦）
- `lib/server/` —— 服务端专用层，可 import Node API（与 `src/shared` 相反）

内容从 W0-2（Next + Tailwind + shadcn 装配）开始进入；`api/**` 的第一个 handler 在 W0-4/W0-6。
