# Auth & Guards

> 认证与归属判定的唯一落点。来源代码：`src/app/lib/server/auth/auth.ts`、`src/app/lib/server/scope/guards.ts`。

---

## Session 模型（`auth.ts`）

- 登录成功：`createSession(userId)` 生成 32 字节随机 token，DB 只存 `HMAC-SHA256(token, MN_SESSION_PEPPER)` 摘要；cookie `mn_session` 放 token 本身，httpOnly + sameSite=lax + 生产 secure，8 小时绝对过期。
- 取当前操作者：`readActor()`——
  - 无 token / 过期 / 停用 / 未 `active` / 无角色 → `null`，由调用方出 401；
  - 用 `react` 的 `cache()` 做**请求级**去重（列表/计数/按钮各调一次也只查一次库）；
  - `privileges` 取多角色并集，`dataScope` 取最宽（`widestDataScope`）。
- 口令校验：`scryptSync` 派生 + `timingSafeEqual`；密钥只从 env 取，缺了直接抛，**不写默认值**。

## 判定入口（三处，缺一不可）

| 层 | 函数 | 何时用 |
|---|---|---|
| handler 入口 | `withActor(async (actor) => ...)` | 所有 `/api/**` |
| 特权开关 | `requirePrivilege(actor, "canUnarchive" \| ..., label)` | `canUnarchive`/`canReadPlain`/`canManageUser`/`canManageConfig` 类动作 |
| 归属/状态类写 | `ownsAttribution(actor, ownerId)` | 改负责人、改状态、归档、删除、增删协办/关注人 |
| 拉人参与 | `canAddParticipant(actor, targetUserId, {coOccurred, targetEnabled})` | 承办/协办/关注的目标用户挑选 |

## 两条归属护栏（`guards.ts`）

- **护栏 1（`ownsAttribution`）**：改归属/状态必须是负责人本人，或 `dataScope === "all"`，或 `isAdmin`。`dataScope` 其它取值一律拒绝（含未知值按最窄处理）。
- **护栏 2**：明细读写（节奏/进展/费用/评论/附件/自定义提醒）**不加判定**——可见即可写，可见性由 scope 谓词单点保证。

`ownerId` 用 `String(...)` 归一比较（服务层 `bigint`、DTO/URL `string` 混用的失败形态是负责人自己也改不动）。

## 禁止项

- 鉴权只放 proxy/middleware——matcher 漏路径会跳过；proxy 只做未登录跳转。
- 用 `===` 比较口令或 token 派生值。
- 在客户端组件 import `auth/auth.ts` 或 `db/*`。
- 登录成功/失败写进 `activity_log`（见 `logging-guidelines.md`）。
