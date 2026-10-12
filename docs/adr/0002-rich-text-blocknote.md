# 富文本编辑器引入 BlockNote（含 Mantine 皮肤）

事项/案件的「描述」要从纯文本改成富文本。裁定：引**开源无头系编辑器 BlockNote**（`@blocknote/core` + `@blocknote/react` + `@blocknote/mantine`，MPL-2.0），并照抄同级项目 `F:\WorkSpace\UnionDesk`（`UnionDeskWeb/apps/UnionDeskAdminWeb/src/pages/platform/domains/ticket-type-config/components/description-template-editor.tsx`）的用法：`useCreateBlockNote({ dictionary: zh })` + `<BlockNoteView theme onChange />`，**纯默认配置**——不定制斜杠菜单、不定制格式条。

这是一次"明知故犯"的偏离：MatterNest 的禁令⑦ 写着"前端只允许一套组件体系（antd 6），不得引入第二套体系"，而 `@blocknote/mantine` **要求**一个 Mantine 皮肤（BlockNote 的三个官方皮肤 mantine / shadcn / ariakit 都是 MPL-2.0；不引皮肤就得自己写视图，等于丢掉它的全部卖点）。用这个代价换来的收益只有一处，但很实在：**与 UnionDesk 同栈**——两个项目同一套编辑器、同一条升级路径、同一种存储口径。

## Considered Options

- **TipTap**（3.31.4，MIT，无头）+ 自建 antd 工具条与 `/` 菜单：视觉能保持一套体系，但 `/` 菜单、浮动条、块类型菜单都要自己写（约 150–250 行），且与 UnionDesk 不一致。**被否，理由是跨项目一致优先于视觉纯一**。
- **自封装 `contenteditable` 最小编辑器**：零依赖，但能力上限低、之后每加一个格式都要自己维护。被否。
- **BlockNote 只引 core + react、不引皮肤**：技术上不成立——`BlockNoteView` 在皮肤包里，没有皮肤就得自己渲染块，等于把它的卖点全丢掉。被否。

## Consequences

- **禁令⑦ 必须加一条具名白名单**：`@blocknote/*` 与其 Mantine 皮肤是唯一例外，且只允许出现在富文本编辑器内部——`@mantine/*` 不得用于任何其他控件。注意现有门禁的名字表（`antd/es|radix|lucide|date-fns|react-hook-form|pro-components`）**扫不到 `mantine` 与 `blocknote`**：照抄进去门禁照样绿。所以这条只能靠规范自己写明，否则规范与门禁互相说谎（已在 `docs/tech-stack-decision.md` §13.6.2 与前端 spec 落白名单）。
- **存储口径随之定为 markdown**（`editor.blocksToMarkdownLossy` / `tryParseMarkdownToBlocks`）：列表的 `ILIKE` 搜索直接可用，不需要额外的纯文本投影列；只读渲染走 `react-markdown` + `remark-breaks`（注意 `remark-breaks` 是为了软换行不被折叠成空格——UnionDesk 在 `description-template-markdown.ts` 里踩过这个）。
- **审计日志不落正文**（`logging-guidelines.md` 既有禁令不变）。
- 编辑态内的控件外观是 Mantine 的，与 antd 不一致。这是本裁定的既定代价，**不是缺陷，不要"顺手统一"**。
- 要引的包：`@blocknote/{core,react,mantine}` + peer `@mantine/{core,hooks,utils}` + `react-markdown`、`remark-breaks`。**不需要** `@ant-design/pro-components` / `@ant-design/pro-editor`——那两个是 UnionDesk 别处在用，且是 MatterNest 明令点名的禁区。
- 顶部**没有**常驻工具条：BlockNote 的默认 UI 是"输入 `/` 唤出块菜单 + 选中文字浮出格式条"。要常驻顶部条得自己写，且会与 Mantine 风格并行——这是选 B 时就接受的。
