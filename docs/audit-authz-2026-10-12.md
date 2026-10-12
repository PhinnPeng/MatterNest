# 鉴权与用户列表审计报告

- **日期**：2026-10-12
- **范围**：`F:\WorkSpace\MatterNest` 自有鉴权实现（登录、口令、会话、API 鉴权面）
- **方法**：静态代码审读 + 只读数据库查询 + 对运行中服务（`http://127.0.0.1:3777`）发无 Cookie / 带 Cookie 的 HTTP 请求
- **性质**：所有者自查。**未改动任何代码、未写库、未删数据**（`git status` 仅有审计前已存在的 `agent-work/probe-*.mjs` 未跟踪文件）
- **DB 访问**：全部包在 `BEGIN READ ONLY` 事务里，结束即回滚。**未 SELECT 任何 `password_hash` 值**，只用 `length()` / 正则 / 等值比较判断形态

---

## 一、结论先行（按严重度排序）

| # | 严重度 | 发现 | 类型 |
|---|---|---|---|
| F1 | **高** | seed 里 6 个账号口令 = 用户名，且**哈希明文写在 git 跟踪的 SQL 里**；`is_admin` 逃生口给了 `wangkf` | 实测确认 |
| F2 | **中** | seed 幂等重放会把所有演示账号口令**重置**回用户名（`ON CONFLICT DO UPDATE SET password_hash`） | 代码确认 |
| F3 | **中** | 登录端点存在**账号枚举计时侧信道**（约 40–45ms 稳定差） | 实测确认 |
| F4 | **中** | `mn_auth_session.revoked_at` 与 `mn_app_user.token_version` 两列**从未被任何代码读取或写入** —— 吊销能力是死的 | 代码确认 |
| F5 | **中** | 软删用户（`mn_app_user.is_deleted = true`）**仍可登录并通过鉴权** | 代码确认（当前库内无软删用户） |
| F6 | **低-中** | 登录失败**无限速、无锁定**；UI 文案称"每次都会记进审计"，但审计枚举里根本没有 LOGIN 类 action，也没有任何写入 | 代码+实测确认 |
| F7 | **低** | `mn_auth_session` 已过期行**从不清理**（210 行中 187 行已过期） | 实测确认 |
| F8 | **低** | 登录页在非生产环境**明文列出 5 个可用账号 + 角色 + 数据范围** | 实测确认 |
| F9 | **低** | 非生产构建的 SSR HTML 里注入 `data-insp-path="src/...tsx:行:列"`，暴露源码结构与行号 | 实测确认 |
| F10 | **信息** | 部分端点**先校验后鉴权**（400 早于 401），未登录即可探测 schema | 实测确认 |
| — | **通过** | 未找到任何真正的登录绕过：所有 `/api/**` 业务端点均要求有效会话；SSR 页面壳零业务数据 | 实测确认 |

---

## 二、逐条证据

### F1 — 演示账号口令 = 用户名，哈希明文入库且已进 git（高）

**库内账号清单**（只读查询 `mn_app_user`）：

| id | username | display_name | is_enabled | activation_status | is_admin | is_deleted | 角色 |
|---|---|---|---|---|---|---|---|
| 101 | `wangkf` | 王凯锋 | true | active | **true** | false | full_admin(all) |
| 102 | `lichen` | 李晨 | true | active | false | false | full_operator(all) |
| 103 | `zhaolj` | 赵凌 | true | active | false | false | full_admin(all), joined_operator(participating) |
| 104 | `suny` | 孙奕 | true | active | false | false | joined_operator(participating) |
| 105 | `hezp` | 何哲培 | true | active | false | false | sys_admin(owned) |
| 106 | `qiangl` | 强玲 | true | **pending** | false | false | self_operator(owned) |

**口令形态判定**（不打印哈希本身）：全部 6 行 `length(password_hash) = 128`、`^[0-9a-f]+$` 为 true、`password_hash = username` 为 **false**、无 `salt:hash` 分隔符。即：**存的是 scrypt 派生摘要，不是明文，也不是可逆加密** —— 这一点是好的。

**但口令本身是弱口令，且哈希已公开**：

- `src/app/lib/server/db/seed/0001_identity.sql:7` —— 文件自己的注释写明："`password_hash` 是 scrypt(salt=用户名相关串)，**仅 dev 演示**，口令等于用户名"
- `src/app/lib/server/db/seed/0001_identity.sql:28-33` —— 6 行 INSERT 里直接写着 128 位十六进制摘要
- `src/app/lib/server/db/seed/0001_identity.sql:38` —— "演示账号的口令 = 用户名，仅 dev 可用"

独立验证（离线、无 DB）：对这 6 个用户名计算 `scryptSync(username, "mn-demo-salt-"+username, 64).toString("hex")`，与 seed 文件里的摘要**逐字相等，6/6 全中**。

也就是说：**任何人拿到这个仓库，不需要爆破就能拿到全部 6 个账号的口令。** 其中 `wangkf` 是 `is_admin = true` 的逃生口（`src/app/lib/server/db/schema/identity.ts:66-70`），它绕过数据范围谓词（`src/app/lib/server/scope/visibility.ts:58`），能看见全公司数据。

**实测正常登录可用**（验证口令确实就是用户名）：

```
POST /api/auth/login  {"username":"wangkf","password":"wangkf"}
  -> 200  {"userId":"101","displayName":"王凯锋"}
     set-cookie: mn_session=<43 chars>; Path=/; HttpOnly; SameSite=lax

GET /api/session  (带该 cookie)
  -> 200  {"userId":"101","displayName":"王凯锋","dataScope":"all","isAdmin":true,
           "privileges":{"canUnarchive":true,"canReadPlain":true,
                         "canManageUser":false,"canManageConfig":false}}
```

**缓解现状**：`src/app/lib/server/db/seed/0001_identity.sql:8` 已写明"生产环境这些行必须被部署脚本覆盖"；登录页的账号提示块用 `NODE_ENV !== "production"` 门控（`src/app/(auth)/login/login-form.tsx:99`）。**但这两条都是约定，没有强制**。若生产部署漏跑覆盖脚本，这 6 个账号（含 `is_admin`）即全线沦陷。

---

### F2 — seed 幂等重放会重置口令（中）

`src/app/lib/server/db/seed/0001_identity.sql:34`：

```sql
ON CONFLICT ("username") DO UPDATE SET "password_hash" = excluded."password_hash", ...
```

同一文件 `:35-37` 解释了为什么用 `DO UPDATE` 而不是 `DO NOTHING`（首轮 seed 算错过摘要，导致登录恒 401）。**但这个选择同时意味着：任何时候重跑 seed，都会把已经被改成强口令的账号口令打回 `= 用户名`。** seed 在生产环境重放 = 制造弱口令。

**未实测**（重放 seed 属写操作，已按要求跳过）。这一条是**读代码得出的**。

---

### F3 — 登录端点的账号枚举计时侧信道（中）

`src/app/api/auth/login/route.ts:33-35`：

```ts
const same = "账号或口令不正确";
if (!row || !verifyPassword(password, username, row.hash))
  return fail(401, "bad_credentials", same);
```

**文案口径是对的** —— 实测三类失败返回**逐字相同**的响应：

```
账号不存在      -> 401 {"error":"bad_credentials","message":"账号或口令不正确"}
口令错          -> 401 {"error":"bad_credentials","message":"账号或口令不正确"}
口令对但未开通  -> 401 {"error":"bad_credentials","message":"账号或口令不正确"}   (qiangl/pending)
```

**但 `||` 短路让 scrypt 只在用户存在时才执行**（`src/app/lib/server/auth/auth.ts:37-39` 的 `scryptSync` 只经由 `verifyPassword` 调用），这是一个干净的计时探针。实测（12 轮交错采样，消漂移）：

```
账号不存在   : n=12 avg=39.9ms median=37.9ms min=37.3ms max=58.6ms
账号存在     : n=12 avg=82.1ms median=79.7ms min=73.8ms max=99.9ms
```

差值区间不重叠，**约 40–45ms 的稳定差**。远好于 `timingSafeEqual` 想防的那点差异（`src/app/lib/server/auth/auth.ts:45`）—— 讽刺的是，`timingSafeEqual` 用对了，短路把它整个抵消了。

匿名攻击者据此可以无认证地枚举出全部有效用户名。给定 F1，这些用户名就是口令。

**修复方向**：账号不存在时也走一次等价的 `scryptSync`（对假 hash 比对）。

---

### F4 — 吊销能力是死的：两列从未被读写（中）

schema 里定义了两列，并在注释里承诺了离职回收链路：

- `src/app/lib/server/db/schema/identity.ts:73-75` —— `tokenVersion`，注释写"**吊销全部会话用**（离职回收链路，权限草案 §5）"
- `src/app/lib/server/db/schema/identity.ts:123` —— `revokedAt`
- `src/shared/enums/auth.ts:41` —— "只有 `inactive` 触发回收链路（`is_enabled=false` + 吊销 session + `token_version++`）"

实测 grep 全仓源码：`revoked_at` / `revokedAt` / `token_version` / `tokenVersion` 在 `src/**` 下的命中**只有 schema 定义与迁移快照本身，没有任何一处读写**。

- `readActor`（`src/app/lib/server/auth/auth.ts:112-162`）只查 `token_hash` + `expires_at` + `is_enabled` + `activation_status`，**不查 `revoked_at`，也不比对 `token_version`**
- `destroySession`（`src/app/lib/server/auth/auth.ts:96-104`）走的是 `DELETE` 删行，绕过了这两列

**后果**：任何未来按 schema 注释去实现"离职回收"的人，写 `UPDATE mn_auth_session SET revoked_at = now()` 会发现**会话照样能用** —— 吊销是静默失效的。库里现有 210 行会话、`revoked_at IS NOT NULL` 的 **0 行**（说明这条路径从没被走过）。

实测 logout 本身是正确的（删行）：
```
POST /api/auth/logout -> 200
随后用同一 token 打 /api/session -> 401   (正确)
```

---

### F5 — 软删用户仍可登录并通过鉴权（中）

`mn_app_user` 继承了 `auditColumns`，含 `is_deleted` 与 `deleted_at`（`src/app/lib/server/db/schema/common.ts:38-45`；实测 `information_schema` 确认两列存在）。

但：
- `src/app/api/auth/login/route.ts:22-31` 的 SELECT 只取 `id, display_name, password_hash, is_enabled, activation_status` —— **不过滤 `is_deleted`**
- `src/app/lib/server/auth/auth.ts:118-130` 的 `readActor` JOIN 也不带 `is_deleted` 条件

对比：`readActor` 明确处理了停用与未开通（`src/app/lib/server/auth/auth.ts:135`），唯独漏了软删。当前库内 6 个用户 `is_deleted` 全为 false，所以**今天不可利用**；但"删除用户"这个动作一旦落地，软删账号会带着完整权限继续登录。

这一条是**读代码得出的**，未构造数据实测（设软删需写库，已跳过）。

---

### F6 — 登录无限速、无锁定；UI 声称的审计不存在（低-中）

**无限速**：`src/**` 全仓 grep `rateLimit|lockout|failedAttempt|tooMany|429` —— **零命中**。`POST /api/auth/login` 可无限次调用。结合 F1（口令可知）与 F3（可枚举），这是完整的爆破/撞库面。

**UI 文案与实现不符**：`src/app/(auth)/login/login-form.tsx:68` 写着"连续失败不会锁定，**但每次都会记进审计**"。实测：

- `mn_activity_log` 全表 `action` 分布：`STATUS_CHANGED(14) / NODE_UPDATED(7) / ARCHIVED(2) / RISK_CREATED(2) / NODE_CANCELLED(1) / MATTER_CREATED(1) / COMMENT_CREATED(1) / PROGRESS_CREATED(1) / CONVERTED_TO_CASE(1)` —— **没有任何登录相关行**（`action ILIKE '%login%' OR '%auth%' OR '%登录%'` 命中 0）
- `mn_activity_log.action` 的 CHECK 约束值域共 46 个，**不含任何 LOGIN 类 action** —— 即当前 schema 下**根本写不进去**
- `src/app/api/auth/login/route.ts` 全文没有 `logActivity` 调用

所以：**登录失败既不限速，也不留痕**，而界面上告诉用户留痕了。这比单纯缺功能更糟 —— 它会让审计视角误以为登录失败可追溯。

---

### F7 — 过期会话行从不清理（低）

只读统计：

```
total_sessions = 210
expired  (< now)      = 187
live     (>= now)     = 23
revoked_at IS NOT NULL = 0
oldest expiry = 2026-09-27
```

`src/app/lib/server/auth/auth.ts` 没有任何清理逻辑。过期会话在**鉴权层被正确拒绝**（`:133` `if (new Date(row.expiresAt).getTime() < Date.now()) return null;`），所以这是**存储增长问题，不是安全绕过**。只是会话表会无界增长。

---

### F8 — 非生产环境登录页列出可用账号（低）

`src/app/(auth)/login/login-form.tsx:23-29` 硬编码 5 个账号 + 角色 + 数据范围，`:99` 用 `NODE_ENV !== "production"` 门控，`:114-116` 点击即填入 `username` 与 `password`（都是用户名）。

实测未登录访问 `/login` 的 SSR HTML，可见文本含：
```
演示账号（口令 = 账号，点一下填入）… wangkf 总经理 [全公司 L1] … lichen 风控总监 …
另有 qiangl（未开通）：登录应与口令错误给同一句提示。
```

这与 F1 的 SQL 文件是**同一个弱点的第二次暴露**，但暴露面小得多（前者进 git，后者只在非生产运行时）。

---

### F9 — 非生产 SSR 注入源码路径（低）

实测未登录页面 HTML 中：

```
/login   : data-insp-path="src/app/layout.tsx:24:5:html"
                     "src/app/(auth)/login/page.tsx:25:5:div"
/matters : data-insp-path="src/app/layout.tsx:24:5:html"
                     "src/app/(desk)/layout.tsx:15:10:AppShell"
```

来源：`next.config.ts:21` 在非生产挂 `@stinsky/xray` 的 turbopack 插件，`src/app/layout.tsx:29` 非生产渲染 `<Xray/>`。

**代码已经显式防护生产**（`next.config.ts:13-14` 注释写明"生产 HTML 里带上源码路径是白给的信息泄露面"，且用 `isProd` gate 掉）。当前服务跑的是开发模式，所以可见。**属于配置正确、开发模式下的预期行为**，记录以备部署核查。

---

### F10 — 先校验后鉴权（信息）

部分 handler 在 `withActor` **之前**做输入校验，未登录时先返回 400：

```
GET /api/matters?pageSize=100000  (无 Cookie) -> 400  "Too big: expected number to be <=100"
GET /api/matters?sortBy=bogus     (无 Cookie) -> 400  枚举值域全量回显
GET /api/risk-matters?page=0      (无 Cookie) -> 400
GET /api/parties?q=               (无 Cookie) -> 400
GET /api/session                  (无 Cookie) -> 401  (正确)
GET /api/overview                 (无 Cookie) -> 401  (正确)
GET /api/meta?host=bogus          (无 Cookie) -> 401  (正确)
```

成因：`src/app/api/matters/route.ts:9-11` 先 `query()` 再 `withActor()`；`src/app/api/parties/route.ts:21-23` 同理。**无业务数据泄漏**（400 只回显 zod 枚举值域），但给了未认证探测者 schema 信息。严重度低。

---

### 通过项 — 未找到任何真正的登录绕过

**1. 所有 `/api/**` 业务端点均要求有效会话。** 逐个实测（无 Cookie）：

```
GET /api/session                        -> 401
GET /api/overview                       -> 401
GET /api/meta?host=matter               -> 401
GET /api/meta?host=risk_matter          -> 401
GET /api/matters?page=1&pageSize=20     -> 401
GET /api/risk-matters?page=1&pageSize=20 -> 401
GET /api/matters/1                      -> 401
GET /api/matters/6001                   -> 401
GET /api/matters/999999999              -> 401
GET /api/risk-matters/1                 -> 401
GET /api/risk-matters/1/parties         -> 401
GET /api/parties?q=华                    -> 401
```

写端点（`/api/auth/login` 除外）未带 Cookie 时全部 405 或 400，**无一例 200**。

代码侧核对：27 个导出的 handler（`GET`/`POST`/`PATCH`/`DELETE`）中，除 `POST /api/auth/login`（本就该匿名）与 `POST /api/auth/logout`（无 token 时 `destroySession` 是 no-op，`src/app/lib/server/auth/auth.ts:98` `if (token)` 守卫）外，**全部**走 `withActor`（`src/app/lib/server/http.ts:171-177`）或显式 `readActor() + unauthorized()`。

**2. 页面壳零业务数据（禁令⑥ 成立）。** 未登录访问所有 desk 页面 → HTTP 200，但：

- 剥掉 `<script>`/`<style>`/标签后的可见文本，只有导航、筛选控件、"加载中…"骨架、计数显示为 **0**
- 从 DB 取 23 条真实业务字符串（`mn_matter.name` / `internal_code` / `case_no`、`mn_risk_matter.name` / `code`、`mn_party.name`）去 grep 7 个未登录页面的完整 HTML：**0 命中**
- 从 DB 取 6 个用户的中文名 + 用户名去 grep：**0 命中**（唯一命中是 antd 的 CSS 变量名 `anticon` 的巧合子串，非数据）

符合 `src/app/(desk)/layout.tsx:7` 与 `src/app/layout.tsx:8-10` 的禁令⑥约定。SSR 未登录时渲染出的是"菜单 + 去登录链接 + 空表骨架"，**无业务行**。结构由 `src/app/components/app-shell.tsx:82-193` 的客户端组件在浏览器侧拉 `/api/session` 后决定。

**3. 会话 token 不可伪造。**
- 生成：`randomBytes(32).toString("base64url")`（`src/app/lib/server/auth/auth.ts:71`），实测长度 **43** 字符，符合预期
- 存储：DB 只存 `HMAC-SHA256(pepper, token)`（`:32-34`），cookie 里是原始 token
- pepper 缺失即抛，不给默认值（`:26-30`）；`.env:19` 的值是 dev 占位，`pepper()` 无硬编码兜底
- 实测篡改末位 1 字符 → **401**；送 43 个 `a` → **401**

**4. 会话过期被服务端强制校验。** cookie 有 `Expires`（实测 `Expires=Mon, 12 Oct 2026 13:49:31 GMT`），且 `readActor` 在 `:133` 独立比对 DB 的 `expires_at`。**即使伪造一个未过期的 cookie 有效期，服务端仍会拒绝过期会话。**

**5. `React cache()` 无跨请求串号。** `readActor` 用 `cache()` 做请求级去重（`src/app/lib/server/auth/auth.ts:112`）。实测并发交错打两个身份的 `/api/session`，6 轮全部稳定返回各自身份（101/all/admin 与 105/owned/非admin），**无串号**。

**6. Cookie 属性合规。** 实测 `Set-Cookie`：`Path=/; HttpOnly; SameSite=lax` + `Expires`。
- `HttpOnly` ✓（`:88`）
- `SameSite=lax` ✓（`:89`）—— 挡跨站 POST 型 CSRF
- `Secure` 仅在 `NODE_ENV=production` 时加（`:91`）—— 开发环境 HTTP 下必然没有，这是对的取舍
- 无 `Domain` ✓（不跨子域）
- 实测带 `Origin: http://evil.example` 的跨源 POST 未被 CORS 响应头放行；且 `SameSite=lax` 下浏览器不会在跨站 POST 携带该 cookie。**无 CSRF 绕过**

**7. `next.config.ts` 无 rewrites、无鉴权绕过路径。** 全文 24 行，只有 `output: "standalone"`、`reactStrictMode`、非生产的 xray 插件。**无 `rewrites()`、无 `redirects()`、无 `headers()`**。

**8. 全仓无 middleware / proxy 文件。** `Get-ChildItem -Recurse -Include middleware.ts, proxy.ts`（src 下）**零命中**。这与代码注释一致（`src/app/lib/server/auth/auth.ts:16-17` 明确说鉴权**不**依赖 middleware，是有意的）。**副作用：不存在"middleware 漏配导致路径跳过鉴权"这类经典绕过**。

**9. 无 `searchParams` SQL 注入。** `sortBy` / `status` / `sortDir` 全是 `z.enum` 白名单（`src/shared/schema/list-query.ts:21-30, 75-83`），不是自由字符串。实测：

```
?sortBy=id;DROP+TABLE+mn_app_user   -> 400 枚举拒绝
?sortBy=created_at;SELECT+1         -> 400 枚举拒绝
?pageSize=100000                    -> 400 上限 100 拒绝
?page=0 / page=-1                   -> 400 下限 1 拒绝
?status=' OR '1'='1                 -> 400 枚举拒绝
?keyword=' OR 1=1--                 -> 200 total:0（当普通字符串处理，无注入）
?keyword=%25                        -> 200（通配符未转义，但只是多返回行，非注入）
```

grep 全仓 SQL 拼接：全部走 drizzle `sql` 模板绑定参数，无 `.raw()` 拼接用户输入（`sql.raw()` 仅出现在 `src/app/lib/server/db/schema/ddl.ts:23,28`，且入参被强制限制为 `[a-z0-9_]` 的字面量列表）。**无注入面。**

**10. 无硬编码调试/测试后门。** grep `process.env.(MN_|DEBUG|TEST|E2E|AUTH_BYPASS|SKIP_AUTH)` 全仓仅 2 处命中：`src/shared/ids/snowflake.ts:22`（`MN_WORKER_ID`）与 `src/app/lib/server/auth/auth.ts:27`（`MN_SESSION_PEPPER`）。**无任何 `if (dev) skipAuth()` 之类的旁路。**

**11. 越权（数据范围）确实在服务端生效。** 实测同一端点两个身份：

```
GET /api/matters?page=1&pageSize=1  (wangkf: L1 + is_admin) -> total: 5
GET /api/matters?page=1&pageSize=1  (hezp:   L3 owned)      -> total: 0
```

谓词集中在 `src/app/lib/server/scope/visibility.ts` 单一入口，`:96` 兜底 `sql\`false\``（"宁可零行不要全表放行"）。默认拒绝方向正确。

**12. 404 / 403 分工符合设计。** 业务读接口不可见给 404（`src/app/lib/server/http.ts:53-54`），避免案号枚举探测。实测 `wangkf`（L1 全量）访问不存在的 `/api/matters/1` → 404。

**13. 无用户列表端点。** 全仓无 `/api/users` 类路由（`Get-ChildItem -Filter route.ts` 逐一核对，27 个 handler 无一列举 `mn_app_user`）。符合 `src/app/api/parties/route.ts:11-12` 引用的"§4.1 拒绝裸 `/users` 列表"。**用户枚举只能走 F3 的登录计时侧信道。**

---

## 三、未覆盖或存疑

1. **未做任何写操作**，因此以下均为**代码推断，未经实测**：
   - F2（seed 重放重置口令）
   - F5（软删用户仍可登录）
   - F4 中"写 `revoked_at` 不会生效"的具体行为
   
   构造这三项都需要写库，按只读要求跳过。

2. **未审计以下越权面**（超出本次委托的"登录绕过与用户列表"范围）：
   - 业务写入路径的字段级授权（如 `ownerId` 能否被改成他人）
   - `parties.ts:242` 的 `actor.isAdmin ? sql\`true\` : undefined` —— `is_admin` 会让当事人搜索**不受范围谓词约束**，能搜到全公司当事人。这是 `visibility.ts:16-17` 注释里声明的刻意设计，但配 `is_admin` 落在 F1 的弱口令账号上，风险被放大
   - `mn_party.id_number` 明文：搜接口只回尾 4 位（`parties.ts:272`），但案件/事项**详情接口回全量明文证件号**（`matters.ts:187`、`risks.ts:350`），不受 `canReadPlain` 约束。代码注释称这是 IQ-12 后的刻意决定（`parties.ts:13-15`），未逐一核对权限草案原文

3. **未审计 XSS / CSRF token 的必要性**。当前无 CSRF token，依赖 `SameSite=lax`。对"仅 JSON API + 无服务端 Server Action"的形态足够，但若未来引入 Server Action（`"use server"`）或跨站可触发的 GET 写操作，`lax` 不够（`lax` 挡不住顶级导航 GET）。

4. **未审计部署链路**。`MN_SESSION_PEPPER` 在 `.env` 里是 dev 占位值。若生产沿用同一值，会话摘要密钥公开 —— 拿到 `mn_auth_session.token_hash` 的人可离线爆破 token（32 字节随机，爆破不可行，但可确认"这库被读过"）。代码层已强制"缺值即抛"，但没有"值太弱即抛"的检查。

5. **未审计多副本一致性**。`next.config.ts:6-7` 提到多副本必须共配 `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` 与 `deploymentId`，本次未验证。

6. **Xray 探测样本有限**：只测了 `/login` 与 `/matters`，其余 5 个 desk 页面未逐一取样（逻辑同源，判定为无差异）。

---

## 四、附：凭据卫生声明

- 审计过程中**未打印、未落盘** `.env` 中的 `PGPASSWORD` 或任何 `password_hash` 值
- 数据库访问全部在 `BEGIN READ ONLY` 事务内，事务结束即回滚；脚本运行前后 `mn_app_user` / `mn_auth_session` 行数未变（前者 6 行，后者仅因 4 次登录冒烟 +2、1 次登出 -1）
- 唯一被"读出来"的敏感材料是 seed SQL 里的 6 行口令摘要 —— 它们**本来就在 git 跟踪的文件里**（`git ls-files -- src/app/lib/server/db/seed/` 确认 4 个 seed 文件均已跟踪），本报告引用它们时只给出"与 scrypt(口令=用户名) 逐字相等"的布尔结论，未复述摘要本身
- 临时探测脚本全部写在 `C:\Users\Administrator\AppData\Local\Temp\opencode\` 下，**未进入仓库**
- 未创建任何 Paca 票，未改动任何代码