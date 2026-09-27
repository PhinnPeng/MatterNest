# State Management

> 状态分四层，各自有唯一归属。结论来源：`docs/tech-stack-decision.md` §2、§12.5、§13.3-3、§13.5 禁令⑧。

---

## 四层归属

| 层 | 用什么 | 不放什么 |
|---|---|---|
| **服务端态**（案件/事项/通知/配置列表） | `@tanstack/react-query`（§2「服务端数据」行） | 不放 Redux/Zustand；不放组件内 `useState` 手抄一份 |
| **表单态** | react-hook-form（+ Zod resolver） | 不放全局 store；不放 query cache |
| **局部 UI 态**（开合、当前 Tab、列显隐） | 组件 `useState` | 不放能影响数据范围的"筛选态"——那属服务端态 |
| **URL 态**（列表的 `page/pageSize/sortBy/sortDir/filters`） | 搜索参数（使分享链接可复现同一视图） | 不放 id 类敏感集合、不放 token |

URL 态这一层是本次填 spec 时**新定的建议口径**（规格件未写）：`DataTable` 的受控参数天然适合落在 URL，便于同事之间发链接对齐视图。若不同意，删掉这半行即可，不影响禁令⑧（分页仍在服务端）。

---

## 一期**不引入**任何全局状态库

- 不装 Redux / Zustand / Jotai / MobX。业务后台的共享状态其实只有"当前登录者是谁 + 他的范围档"，那一份由后端每次请求现算（§2），前端拿副本反而造成权限不一致。
- 不装 `next-intl` / i18n 框架。本项目**没有第二套语言**，需要的是组件的**中文 locale**（**已于 N1 实测通过**：`date-fns` 的 `zhCN` 给「九月 2026」与星期单字，口径集中在 `src/shared/time/zh-cn.ts`，且 `Locale` 只能在 client 侧 import——见 `component-guidelines.md` 的日期条）。

---

## 缓存的硬边界（§12.5，判据是安全不是性能）

本系统每次读取都带行级数据范围谓词，**任何跨用户共享的响应缓存都是泄露面**。因此：

- ❌ HTTP 层缓存、反代缓存、查询结果缓存、Redis——一律不做（§3.6、§12.5）。
- ❌ Next 的 `'use cache'` / 跨实例共享缓存——不用（§13.3-3）。
- ✅ 允许的三处：配置字典与权限集走**进程内 `Map`**（权限以 `userId:token_version` 为键，版本变更天然失效）；列表/详情走 react-query 的 `staleTime`（每浏览器实例私有）；除此之外没有第四处。
- 触发加缓存的可观测信号（将来才评估）：单查询 p95 > 200ms 且 `EXPLAIN` 显示索引已最优；副本 > 2 且出现必须跨进程共享的状态；附件需要 CDN（那时加在对象存储侧，仍不是 Redis）。

---

## 认证与会话态

- session 存 PG（`auth_session`，含 `auth_via`），**没有框架自带 session 可用**（C4 经 §13.2 继承）；前端只拿 httpOnly cookie，不在 `localStorage` 里存 token，也不在前端存"当前权限集"副本。
- 未登录：proxy 只做**登录跳转**，鉴权判定在每个 handler 内（禁令⑤、§13.3-1）。所以前端不要实现"本地判断有没有权限"的逻辑分支——判不了，也不该判。
- `activation_status='pending'`（云之家首登自动建号，等管理员开通）：这是一个**必须专门画的 UI 态**，返回"等待管理员开通"而不是 403（§7 裁定 F、枚举表 E37）。
- 角色/权限变更**下一次请求即生效**（靠 `token_version`），所以不要在客户端长期缓存角色布尔值来做按钮显隐的"优化"。

---

## 已接受风险，不要误当作已实现能力

离职自动回收目前可能是降级方案（登录时校验 + 长期未登录告警 + 人工停用），**"离职即失效"不是已具备能力**（master P1-16、技术选型 §3.4）。前端不要写"检测到离职已自动封禁"这类文案，也不要把降级路径当兜底实现掉。

---

## QueryClient 的 retry 口径（Demo 那轮实测，2026-09-27）

`src/app/components/providers.tsx` 里是**唯一**的 QueryClient 构造点，retry 规则：

```ts
retry: (count, err) => (err instanceof ApiFailure && err.status < 500 ? false : count < 1)
```

为什么 4xx 一次都不重试，两条都是硬的：

1. **语义**：400 是"这个请求本身不成立"、404 是"对你不可见"（默认拒绝的 404-not-403，权限草案 §1 元规则 3）。
   重试等于在门已经答过"没有"之后再敲一次——审计日志里看起来像探测。
2. **会真的卡死界面**：react-query 只在**两次重试之间**问 `onlineManager`；后台标签页 / 内嵌 0×0 面板里
   它可能报 offline，于是查询停在 `fetchStatus:"paused"`、`isPending` 恒真。
   实测症状就是"骨架屏转到天荒地老，而 header 里的用户名照常渲染出来"——
   因为成功的查询（200）走不到那条分支，只有失败的会停住。
   当时的取证手段：把 QueryClient 临时挂到 `window` 上读 `getQueryCache()`，
   看到 `{status:"pending", fetchStatus:"paused"}` 才定位到；**不要靠猜**。

推论：`staleTime` 可以按数据新鲜度调，但 **retry 策略不要在页面里各写一份**，
否则又会出现"这条查询重试三次、那条不重试"的口径分叉。
