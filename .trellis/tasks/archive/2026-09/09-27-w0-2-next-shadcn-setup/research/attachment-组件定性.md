# `attachment` 组件定性（N1 复测取证）

取证时间 2026-09-27。`ui.shadcn.com` 被域名级重置（见研究文档 §6.3），改从**官方 GitHub 仓 `shadcn-ui/ui`** 取一手源码，
`raw.githubusercontent.com` 与 `api.github.com` 均 200。

## 取到的文件

| 用途 | 路径 |
|---|---|
| 组件源码 | `apps/v4/registry/bases/radix/ui/attachment.tsx` |
| 官方文档 | `apps/v4/content/docs/components/radix/attachment.mdx` |
| 触发器示例 | `apps/v4/examples/radix/attachment-trigger.tsx` |
| 三 base 对照 | `apps/v4/registry/bases/{aria,base,radix}/ui/*.tsx` |

## 结论

官方 description 原文：**"Displays a file or image attachment with media, metadata, upload state, and actions."**
用途句："Use it for files and images in chat composers, message threads, and **upload lists**."

源码里的状态枚举与子件（决定它能替掉我们哪一块 UI）：

```tsx
state?: "idle" | "uploading" | "processing" | "error" | "done"
// 子件：Attachment / AttachmentMedia / AttachmentContent / AttachmentTitle
//      AttachmentDescription / AttachmentActions / AttachmentAction / AttachmentTrigger
// 变体：class-variance-authority；原语：radix-ui 的 Slot
```

**所以它是附件展示件，不是上传器。** MatterNest 的 W3-7 仍需自写：选文件、向 `/api/**` 申请预签名 PUT、直传 MinIO、
进度回报、扩展名/大小白名单校验；可以省掉的是"附件行 + 上传中/失败态 + 删除按钮"这块 UI。

## 三个必须记下的坑

1. **落点存疑**：官方示例 import 的是 `@/styles/radix-rhea/ui/attachment`（`styleName="radix-rhea"`），
   而 `shadcn init` 默认 `style=nova`。所以"组件到底落在 `components/ui/` 还是 `styles/<style>/ui/`"**未定**，
   直接牵动技术选型 §5 拓扑与禁令⑦ 的措辞。**这条只能等 CLI 真跑一次定，不许靠读源码推断。**
2. **不能手拷 `.tsx` 顶替 `shadcn add`**：件里用了 `cn-attachment …` 这类由 registry 随件下发的样式类，
   手拷进仓会得到"能编译但渲染不对"的东西——正是本项目最讨厌的那类静默失效。
3. **数字不要互相验证**：同一仓库实测 `aria` 59 / `base` 62 / `radix` 61 个 ui 件，
   而 docs 站点 registry index 是 63 条（含非 ui 条目）。两者口径不同，不能拿来互证"清单完整"。

## 网络阻断的定性（复测三次）

```
ui.shadcn.com → 66.33.60.193
TCP 443 connect → 连上后立刻 ECONNRESET（<100ms，三次一致）
对照组同机同进程：registry.npmjs.org 200 / github.com 200 / raw.githubusercontent.com 200
```

→ **域名级定向重置，不是抖动、不是 CLI 版本、不是 query 长度**。CLI 报错里"降级到 `shadcn@4.20.0` 再试"是无效方向。
出路只有两条：换出口（代理/热点），或在能访问该域名的机器上 `init` + `add` 后把产物拷回来。
