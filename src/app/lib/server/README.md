# lib/server

服务端专用层：`db/`（Drizzle 与仓储基类）、`scope/`（ScopeResolver + `withScope`）、`session/`、`auth/`（云之家客户端与签名）。
**可以** import Node API——这是它与 `src/shared/` 的唯一区别。

硬约束：

- 不得被 `src/shared/` 或任何客户端组件 import（禁令① 的镜像面）。
- 不得把鉴权放进 proxy/middleware（禁令⑤：官方要求在每个 Server Function / handler 内部校验）。
- 所有查询必须经 `ScopedQuery`；裸 `select()` 由 lint 拦（待 W2-1 落地，见 `tools/lint-guard/README.md`）。

W0-4 起内容（Drizzle + 迁移管线）。
