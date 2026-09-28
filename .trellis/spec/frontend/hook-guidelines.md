# Hook Guidelines

> 自定义 hook 与数据获取模式。服务端数据统一走 `@tanstack/react-query`（技术选型 §2「服务端数据」行）。
> 来源：`docs/tech-stack-decision.md` §2、§13.5 禁令⑤⑥⑧、§3.3；`docs/PRD-phase1-permission-design-draft.md` §4.1、§7.1。

---

## 取数只在客户端 hook 里发生

禁令⑥要求页面壳零业务数据，所以业务读取的路径固定为：

```text
page.tsx（外壳，无业务数据） → 'use client' 组件 → useXxx hook → /api/** → 已过 withScope 的服务层
```

- 不要在 `page.tsx` / `layout.tsx` 里 `await` 业务查询，也不要用 Server Component 直查 DB 再把 props 传下去——那等于把行级数据范围判定挪到页面壳，禁令⑥要防的就是这个。
- Server Functions 允许用于表单 mutation，但**只做编排**，权限判定仍复用同一套服务层（§13.2）。

---

## react-query 约定

- **queryKey 带宿主与分页/筛选参数**，形如 `["matters", { page, pageSize, sortBy, sortDir, filters }]`。禁止用 `"list"` 这种不带资源名的键——切换筛选条件时必须产生新键，否则会把上一个用户的查询结果留在同一实例内。
- `staleTime` 是本项目**唯一允许的缓存层**（§12.5 把"列表详情走客户端 query 的 staleTime"列为三处缓存之一）。它是每浏览器实例私有，不构成跨用户共享。
- 分页/排序/筛选**必须服务端**（禁令⑧，每页上限 100）。因此：不开 `keepPreviousData` 之外的"一次拉全量"策略；`queryFn` 里不许出现把整表拉回本地再 sort/filter 的实现。
- 404 是**正常路径**，不是错误：`selectable-users` 与详情降级都可能返回不存在。要区分"401 未登录"与"404 不可见"，前者触发登录跳转，后者渲染占位（权限草案 §7.1 的降级口径）。
- mutation 成功后按资源精确失效（`invalidateQueries` 指定 key），不要全站 `invalidateQueries()`——一次转案件会牵动 5 个 key，逐个列出来。

---

## 自定义 hook 命名与形态

- `use` 前缀、动词或资源名，放在离使用点最近的 `hooks/`；跨域复用才上移到公共 `hooks/`。
- 一个 hook 只做一件事：`useMatterList(params)` 取数、`useMatterDetail(id)` 取单条、`useConvertSubmit()` 提交。取数与表单状态不要混在同一个 hook 里。
- 表单状态属于 antd `Form`（`Form.useForm()`），**不要**包成自研 `useFormState`；校验规则从 `src/shared/schema` 的 Zod 派生（禁令⑧，见 `type-safety.md` 的 `rulesFor`）。
- **N7 实测确认（2026-09-27，v6 换库后这条仍成立）**：列表参数放 URL 搜索参数 + `useQuery({ queryKey: [资源, query对象] })` 这条路是顺的——翻页/排序只改 URL，queryKey 跟着变，分享链接能复现同一视图。约束一条：`useSearchParams()` 必须在 `Suspense` 边界内，否则 Next 16 构建期直接报错。
- 期限/"剩 N 天"计算走 `shared/time` 纯函数，不写在组件里（技术选型 §4「期限计算」行）。

---

## 人员选择器（本期新增的接口位）

```ts
// 目标形态（未落地）
useSelectableUsers(hostType, hostId, { page, pageSize: 50, q })
```

- 端点只有两个：`GET /matters/{id}/selectable-users`、`GET /risk-matters/{id}/selectable-users`。**必须带宿主上下文**，分页上限 **50**，不接受跨宿主批量列举（权限草案 §4.1）。
- **没有裸 `/users` 列表可用来"先把全所人员拉下来再前端筛"**——那正是 §4.1 收窄要堵的探测面（`can_manage_user` 的管理页除外）。
- 选不到新入职同事是**已接受代价**，不要为了绕过它去加接口（§4.1 代价条）。

---

## 常见错误

1. 在 Server Component 里预取业务数据后 `dehydrate` 给客户端 → 违反禁令⑥。
2. queryKey 不带参数 → 换筛选条件却复用旧数据（内部系统里这会被当成"权限串了"）。
3. 为"体验更顺"改成本地全量排序 → 禁令⑧，等于绕过 `ScopeResolver`。
4. 把 404 当异常弹 toast。
5. mutation 后全量 invalidate，导致 5 张表同时重新鉴权取数。
