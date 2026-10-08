# API Route Conventions

> 所有 `/api/**` Route Handler 的统一写法。模式来自当前实现，不是理想态。
> 来源代码：`src/app/api/matters/route.ts`、`src/app/lib/server/http.ts`（`body`/`query`/`json`/`fail`/`pathId`/`withActor`/`requirePrivilege`）。

---

## Handler 骨架（固定模板）

```ts
export async function GET(req: Request) {
  const q = await query(req, listQuerySchema);   // 1. 解析 + Zod 校验
  if (!q.ok) return q.res;                        // 失败直接返回 400 JSON
  return withActor(async (actor) => json(await listMatters(actor, q.data))); // 2. 鉴权 3. 服务层
}
```

三条硬规则：

1. **body / query 必须过 `shared/schema` 的 Zod schema**，`parsed.data` 是 `T` 类型的唯一合法入口；不直接用 `req.json()` 的裸值。
2. **必须用 `withActor` 包裹**，`actor` 永不为 null 往下传；特权动作用 `requirePrivilege(actor, key, label)`，返回 `undefined` 才放行。
3. **出口只用 `json` / `fail` / `notFound` / `unauthorized` / `reasonRequired` / `attributionRequired`**，不自造 `NextResponse.json(...)` 分支。

## 错误口径（与 `error-handling.md` 一致）

| 场景 | 出口 |
|---|---|
| 未登录 / session 失效 | `unauthorized()` → 401 |
| 不可见或不存在 | `notFound()` → 404（措辞不区分两者） |
| 校验失败 | `body`/`query` 自动产出 `validation_failed` + `issues[].path` |
| 路径 id 非法 | `pathId(raw)` 非 `ok` 时返回 `bad_id` → 400（**不许 500**） |
| 归属/状态无权 | `attributionRequired()` → 403（与 404 分工：能否改归属） |
| 需填原因 | `reasonRequired()` → 422 |
| 业务可预期错误 | `new XxxError(...)` → `instanceof` 判定后 `fail(400, ...)`，其余 `throw` 冒泡 |

## BigInt / Date 序列化

- 出口层 `json()` 已统一 `bigint → string`、`Date → ISO string`（`http.ts` 的 `toWire`）。
- **服务层内部才允许 `bigint`**，跨过 `/api/**` 边界一律 string；不要在服务函数里手转（漏一个就是详情 500）。

## 子资源先取宿主再判权

`/api/matters/[id]/comments`、`.../nodes/[nodeId]`、`.../status` 入口给出子资源 id 时，**先查宿主再判可见性**，禁止按子资源 id 直查（`error-handling.md` §4 对应实现见各子路由）。

## 禁止项

- 不在 handler 里写第二套权限判断或手拼 JSON 错误体。
- 不在 handler 里直接写 SQL/ORM 查询——读写收敛到 `lib/server/services/*`，handler 只做解析、鉴权、调服务、序列化。
- 不用 `try/catch` 吞掉服务层错误统一包成 500；可预期错误显式映射，未知错误 `throw`。
