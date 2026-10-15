# 三把密钥能不能存在数据库里？——事实核查与一手来源研究

> 研究日期 2026-10-15 · 调研对象：`MN_AES_KEY` / `MN_HMAC_KEY` / `MN_SESSION_PEPPER` 三处读取点的本仓实际形态 + OWASP / NIST / Node.js 官方原文
>
> 承接 MATT-36（B7「三把密钥托管」HITL 待决）。**本文不替 MATT-36 拍板**，只把三个决策点上原本含糊的事实钉死，并给出贴着本仓形态的可选方案。
>
> 一手来源口径：OWASP 三份 cheat sheet、HashiCorp Vault transit 文档、Node.js `node:crypto` 官方文档均读**原文**；NIST 两份 SP 为 `nvlpubs.nist.gov` 上的 PDF 原件，本地抽取文本后逐句定位（抽取脚本与页码见 §9）。二手博客一篇未引。
>
> ⚠ **本文是变更前的快照。** §3 记的是「收紧落地之前」的本仓形态 ——
> `auth.ts:27` 的 `pepper()` 当时无缓存、`docker-compose.yml:125` 的 migrator
> 当时继承 `*app-env`、`assertFieldCryptoConfigured()` 当时零调用方。
> 三者已在 MATT-36 落地当天改掉（收紧第 1/2/3 项）。**读 §3 的行号与结论时
> 先做这个折算**；§4–§7 的裁定与理由不受影响。

---

## 1. 问题

**这三把密钥能不能存在数据库里？如果不能，替代方案是什么？**

展开成三个决策点：① SQL 注入是本系统的头号现实威胁，密钥入库后注入能不能读到它？② `MN_SESSION_PEPPER` 与另两把的风险等级是否真的不同？③ 「DB 里存被包装的 DEK」这个变体算不算「密钥入库」？

---

## 2. 短答

**不能入库，而且在本仓的形态下这个结论比一般项目更强、理由更简单：应用必须能读到密钥才能用它，而应用读密钥用的就是那条连数据库的连接、同一个 PostgreSQL 角色。密钥一旦入库，「应用能读密钥」这件事不再增加任何新能力，但「谁碰到了数据库」从此**多拿到一份密钥**。没有任何一种场景会因为把密钥放进库而抬高门槛。**

三个子问题的结论：

1. **① 前提在本仓不成立，结论反而更硬。** 本仓 `src/` 里**没有任何一处把用户输入拼进 SQL 字符串**（§3.6 实测）。所以「SQL 注入是头号现实威胁」这个前提没有代码支撑——现实威胁是**备份泄漏**与**主机被登录**。但结论不变且更强：威胁模型不变（同身份、同连接、同角色），而**结果严格变坏**。
2. **②「不等价」成立，但你的论证里藏着一个未说出口的前提，且方向反了。** 泄露 AES/HMAC 密钥 ⇒ 事后解密全部 PII（只需**读**）；泄露 pepper ⇒ 可伪造任意用户会话（需要**写**一条 `mn_auth_session` 行或能恢复备份）。所以在「只拿到只读备份」这一具体场景里，**AES 密钥严格更严重**，pepper 泄漏并不直接等于认证绕过。但**「两把必须分开」有一手依据**（NIST SP 800-57 Pt1 R5 §5.2 用的是 `shall`）。至于「认证类密钥必须比数据密钥保护等级更高」——**我在任何一手来源里都没找到这种排序规定**，NIST Rev 5 里 `protection level` 这个词出现 **0 次**。
3. **③ 你的判断方向反了：信封加密不是「看起来可行但不等价」的变体，它是 OWASP 明文开出来的例外。** 「You should not store keys next to the secrets they encrypt, **except if those keys are encrypted themselves (see envelope encryption)**」。它在本仓的现实性取决于一个具体问题——**KEK 放哪**。在单机 Docker Compose、无 KMS、postgres 与 app 同栈同主机的形态下，KEK 只能落在应用主机上，而 `pgdata` 卷也在同一台机器上，于是它把边界从「备份离开主机」挪到「主机被拿下」，没有跨过那一条真实的边界。

替代方案：§7。结论是**保持 env 注入**，做三处收紧（本仓现状在 `deploy/docker-compose.yml` 里已经是「不进镜像、不进 git、运行时注入」），把信封加密记成 MATT-36 的带触发条件的选项。

---

## 3. 第 0 步：本仓事实核实

### 3.1 三把密钥的每一处读取点

全仓 `grep 'MN_AES_KEY|MN_HMAC_KEY|MN_SESSION_PEPPER'` 命中 37 处。**生产代码里真正读值的只有 5 行**：

| 密钥 | 读取点 | 读的是什么 | 形态 |
|---|---|---|---|
| `MN_AES_KEY` | `src/app/lib/server/crypto/field-crypto.ts:90` | `process.env` | 模块级 `Buffer` 缓存（`:87`），首次用到才读 |
| `MN_HMAC_KEY` | `src/app/lib/server/crypto/field-crypto.ts:94` | `process.env` | 模块级 `Buffer` 缓存（`:88`），首次用到才读 |
| `MN_SESSION_PEPPER` | `src/app/lib/server/auth/auth.ts:27` | `process.env` | **无缓存，每次调用重读 `process.env`** |

**零处从数据库读。**（实测：`src/` 全域 grep 无任何 `process.env` 值被写入 DB 的代码路径；`migrations/` 与 `seed/` 里无密钥字面量；`src/app/lib/server/db/schema/` 下无任何密钥列。）

三处非生产读取点：`agent-work/smoke-parties.mjs:65`（冒烟脚本启动自检）、`src/app/lib/server/services/parties.spec.ts:206-207`（单测注入）、`.github/workflows/ci.yml:36-38`（CI 注入）。

派生值（不是密钥本身，但同源）：`MN_KEY_VERSION` 在 `field-crypto.ts:100` 被读，**同样无缓存**，每次 `encryptField`/`decryptField` 都读一次 env。

### 3.2 密钥在不在热路径上

| 密钥 | 是否热路径 | 依据 |
|---|---|---|
| `MN_AES_KEY` | **否**（第一次 `encryptField`/`decryptField` 后命中 `aesCache`） | `field-crypto.ts:87-92` |
| `MN_HMAC_KEY` | **否**（同上） | `field-crypto.ts:88-95` |
| `MN_SESSION_PEPPER` | **是** —— 每一个需鉴权的 API 请求都重读一次 `process.env` | `auth.ts:26-30`（`pepper()` 无缓存）→ `auth.ts:32-34`（`tokenHashOf`）→ `auth.ts:143`（`readActor` 的 `WHERE token_hash = …`）→ `src/app/lib/server/http.ts:188`（`withActor` 是每个 handler 的包装器） |

⇒ 三把里只有 pepper 在热路径上。**这条与「密钥存哪」无关，但决定了改造顺序**：任何「把 pepper 换成别的来源」的方案都必须考虑每次请求多一次 I/O；反过来，现在就可以把它 memoize 掉。

### 3.3 部署形态与进程数

| 事实 | 依据 |
|---|---|
| 单副本，无 `deploy.replicas` | `deploy/docker-compose.yml:3-7`（「一期单副本（MATT-35）」），`deploy/README.md:103-105` |
| **一个容器一个 Node 进程**，`output: "standalone"` | `deploy/Dockerfile` 末行 `CMD ["node", "server.js"]`（注释明写「单副本（MATT-35）：不起 cluster」）；`next.config.ts:19` |
| `instrumentation.ts` 的 `register()` 每 server 实例跑一次 | `src/instrumentation.ts:51-57` |
| **两个容器拿到全部三把密钥，其中一个根本不用** | `deploy/docker-compose.yml:125`（`migrator` 的 `environment: <<: *app-env`）——而 `tools/migrate.mjs` 全文无 `MN_AES_KEY`/`MN_HMAC_KEY`/`MN_SESSION_PEPPER` 引用（实测） |
| 开发机 `.env` 存在，三把都**已设值** | `Test-Path .env` = True；实测 `MN_AES_KEY` len=43、`MN_HMAC_KEY` len=43、`MN_SESSION_PEPPER` len=31（**43 = 32 随机字节的 base64url，即 256 bit**；值本身未读取、未记录） |
| `deploy/.env` 不存在 | `Test-Path deploy/.env` = False |

⚠ **未核实**：真实部署环境是否与 `docker-compose.yml` 一致（本仓 `deploy/README.md:152-155` 自述「**不验证起栈**」「`docker compose up` 本票没跑过」）。本节结论限定于仓库内的配置契约。

### 3.4 `MN_SESSION_PEPPER` 具体参与什么运算

**派生方式：单次 HMAC-SHA256，无迭代、无 KDF、无 salt。**

```ts
// src/app/lib/server/auth/auth.ts:32-34
function tokenHashOf(token: string): string {
  return createHmac("sha256", pepper()).update(token).digest("hex");
}
```

- token 的生成：`auth.ts:82` — `randomBytes(32).toString("base64url")`，**256 bit 熵**。
- 落库：`auth.ts:89` — 存 `HMAC-SHA256(pepper, token)` 的 hex。
- cookie：`auth.ts:96-105` — 放 token **本身**，`httpOnly` + `sameSite=lax` + 生产 `secure`，8 小时绝对过期（`auth.ts:23`）。
- **验证位置：`auth.ts:143`**，在 `readActor()` 里的 `WHERE auth_session.token_hash = tokenHashOf(token)`，即**用 token 的 HMAC 摘要做等值查表**，不是「取出摘要再比对」。校验路径同时复查 `isEnabled` / `activationStatus` / `isDeleted` / `expiresAt`（`auth.ts:146-149`）。
- 登出：`auth.ts:112` — `DELETE … WHERE token_hash = tokenHashOf(token)`。
- 它**不参与密码摘要**。密码走 `scryptSync(password, \`mn-demo-salt-${username}\`, 64)`（`auth.ts:37-39`），salt 由用户名决定、无 pepper——`auth.ts:36` 自己标了「生产要换成每用户随机 salt + 参数入列」。

⇒ pepper 的角色是 OWASP 所谓 **post-hashing pepper**（"the pepper is acting as the HMAC key"），作用在**高熵随机 token** 上，不作用在低熵口令上。这个区别在 §5.2 里很关键。

### 3.5 现在怎么注入的

| 面 | 现状 | 依据 |
|---|---|---|
| `.env.example` | 三个键**全部留空**，只给生成命令 | `.env.example:37,38,56`；生成命令在 `:54` |
| `.env` | 已被 `.gitignore` 排除（`.env` / `.env.*`，`!.env.example`） | `.gitignore:24-26` |
| `deploy/docker-compose.yml` | 走 **`environment:`**（不是 `secrets:`），全部值 `${VAR:-}` 留空槽 | `docker-compose.yml:57,58,72`；文件内无 `secrets:` 顶层键（实测） |
| `deploy/Dockerfile` | 刻意不 `COPY .env` | `deploy/Dockerfile`「刻意不做的事」段 |
| CI | `${{ secrets.X || '<固定占位>' }}`，无 secret 时回落 | `.github/workflows/ci.yml:36-38` |
| 本地启动自检 | `agent-work/smoke-parties.mjs:65-67` 缺值即退出 | — |
| 启动期断言 | `assertFieldCryptoConfigured()` **已定义但零调用方** | `field-crypto.ts:110-113`；全仓 grep 只有定义处一处命中 |

### 3.6 SQL 注入面（实测，这是 §5.1 的基础）

**`src/` 里不存在由用户输入拼出的 SQL 字符串。** 逐项：

| 检查项 | 结果 |
|---|---|
| `db.execute(` / `client.query(` 裸字符串 | **零命中**（`src/` 全域） |
| `.unsafe(` / `prepare(` | **零命中**（`src/` 全域） |
| `sql.raw(...)` | **仅 2 处**，取值域都是封闭常量 |
| `sql` 模板里插裸 JS 字符串 | 存在（如 `scope/visibility.ts:117` 的 `like lower(${like})`），**但 Drizzle 会把它变成绑定参数**，不是注入 |

两处 `sql.raw` 的取值：

- `src/app/lib/server/db/schema/ddl.ts:23` — `sqlInList()`，`:19` 先用 `/^[A-Za-z0-9_]+$/` 硬校验，不合规当场抛（注释 `:12-14` 说明这是 DDL 场景没有参数上下文的被迫为之）。
- `src/app/lib/server/services/notifications.ts:1117` — `const table = host === "matter" ? "mn_matter" : "mn_risk_matter"`，由 `HostKind` 枚举三元选出，两个字面量，无外部输入。

**Drizzle 语义的实测依据**（读 `node_modules/drizzle-orm@0.45.3` 本体，非记忆）：

```js
// node_modules/drizzle-orm/sql/sql.cjs:343-346
function raw(str) {
  return new SQL([new StringChunk(str)]);   // StringChunk = 原样进 SQL 文本
}
sql2.raw = raw;
```

而 `sql` 模板（`sql.cjs:324-333`）把每个插值作为独立 chunk 推入 `queryChunks`，由 `Param`（`sql.cjs:306-322`）承载，最终编译成 `$1, $2…` 绑定参数。⇒ **`sql.raw` 是唯一的字面量注入面，本仓两处都不接受外部输入。**

`agent-work/*.mjs` 下有大量 `sql.unsafe(\`delete … ${id}\`)` 式字符串拼接（例：`probe-convert-form.mjs:222-235`、`smoke-batch.mjs:177`）。这些是**开发期本地脚本，不在 `src/`，不进镜像**（`Dockerfile` 只 `COPY .next/standalone` 与 `.next/static`）。

**PostgreSQL 角色事实**：全仓（`src/`、`tools/`、`deploy/`）grep `GRANT|REVOKE|CREATE ROLE` **零命中**。`tools/migrate.mjs:39` 与 `src/app/lib/server/db/client.ts:33` 读的是**同一个** `process.env.PGUSER`；`deploy/docker-compose.yml:125`（migrator）与 `:40-46`（app）拿的是同一份 `PGUSER` 环境块。⇒ **应用角色就是 schema 的拥有者**，没有任何权限隔离。

---

## 4. 逐把密钥决策表

| | `MN_AES_KEY` | `MN_HMAC_KEY` | `MN_SESSION_PEPPER` |
|---|---|---|---|
| **用途**（本仓核实） | AES-256-GCM 字段级加密 PII：`encryptField`/`decryptField`，`field-crypto.ts:116-155`。调用点 15 处（`parties.ts` 9、`exports.ts` 1、`matters.ts` 1、`risks.ts` 1 等） | 盲索引（确定性 HMAC）使密文列可等值检索，`blindIndex` `field-crypto.ts:171-175`。落 `mn_party.id_number_hash varchar(64)`（`db/schema/hosts.ts:436`，唯一索引 `:461`） | 会话 token 的 HMAC-SHA256 密钥，`auth.ts:32-34`；派生/校验见 §3.4 |
| **泄露后果** | 攻击者拿到 DB 后可**离线解密全部 PII**（历史 + 未来）。GCM tag 会挡住篡改，挡不住解密 | 可对可枚举的证件号空间做**离线字典攻击**、恢复同一人关联关系（`field-crypto.ts:158-162` 自己写明这条动机）。**本身不直接泄露 PII** | 可为**任意 `userId`** 计算合法 `token_hash`；配合任何写入 `mn_auth_session` 的能力 ⇒ **认证绕过 / 权限提升**，包括 `is_system_owner`（`auth.ts:59-72`）。**不能单独解密任何数据** |
| **能否入库** | ❌ **否** | ❌ **否** | ❌ **否（理由最强）** |
| **推荐存放位置（本仓形态）** | 保持 `env` 注入；不进镜像（`Dockerfile` 已如此）、不进 git（`.gitignore:24-26`）。后续可换 Compose `secrets:` 文件挂载以从 `docker inspect` 里消失（§7 方案 B） | 同左 | 同左，**且优先**：它是唯一一把「泄漏后能直接产生新权限」的密钥 |
| **一手出处** | OWASP SM §7.3、KM §Storage 1/4/6、NIST SP 800-57 Pt1 R5 §5.1.1(6) + §B.3.4 | OWASP SM §7.3、KM §Storage、NIST §5.1.1(6)（HMAC 密钥同属对称数据加密密钥类）+ SP 800-131A R2 §10 | OWASP **Password Storage CS §Peppering**「should be stored separately from the password database」；NIST §5.1.1(3) 对称认证密钥 + §5.3.6(3) |

---

## 5. 三个子问题的结论

### 5.1 ① SQL 注入是头号现实威胁——**前提在本仓不成立**

**结论（明确）：密钥入库在本仓形态下**严格净负**，与 SQL 注入是否成立无关；而 SQL 注入在本仓**当前不是**头号现实威胁。

**A. SQL 注入面实测为零。** 见 §3.6：`src/` 无用户输入拼接 SQL；两处 `sql.raw` 取值域是封闭常量；Drizzle 模板插值走绑定参数（`node_modules/drizzle-orm/sql/sql.cjs:306-333, 343-346`）。⇒ 「头号现实威胁」这个前提**没有本仓代码支撑**。这不是说以后不会有——Drizzle 用法、新的 `sql.raw`、新写的字符串拼接都可能引入——而是说**今天的威胁模型不该把权重压在它上面**。

**B. 即便注入成立，密钥入库也不会变得更糟——只会恒等地更糟。** 推理链，每一环都有依据：

1. 应用必须能读密钥才能用它（`field-crypto.ts:90,94`、`auth.ts:27`）。
2. 应用读密钥不需要数据库，只需要 `process.env`——**但「应用进程」这一个身份已经同时握有密钥与那条数据库连接**。
3. 那条连接用的是 schema 拥有者角色（§3.6 末段），能读库里的任何东西。
4. ⇒ 注入点若存在于应用内，它**与密钥处于同一身份边界内**。OWASP Password Storage CS §Peppering 把这条写得几乎就是本仓的处境：「It prevents an attacker from being able to crack any of the hashes **if they only have access to the database, for example, if they have exploited a SQL injection vulnerability** or obtained a backup of the database.」——注意前提是「**only** access to the database」。

**C. 于是入库的真实变化是**（这是本题的核心，也是一个不需要任何推测的恒等式）：

| | 密钥不在库里 | 密钥在库里 |
|---|---|---|
| 攻击者拿到**只读** DB 备份 | 得到密文。`field-crypto.ts:158-162` 论证过：盲索引是 keyed 的，所以「拿到了库」与「拿到了明文」是两件事 | 得到密文 **+ 三把能打开它的钥匙**。`MN_AES_KEY` 在手 ⇒ 全部 PII 明文 |
| 攻击者拿到**可写** DB | 同上，仍是密文 | 拿到钥匙 + 可插 `mn_auth_session` 行 ⇒ 直接认证绕过 |
| 威胁模型是否变化 | — | **不变**（同身份、同连接、同角色、同权限） |
| 结果是否变化 | — | **严格变坏**，且**没有任何一行代码能让它变好** |

「应用到密钥的访问面没有缩小」是这一步的关键：应用仍需每请求读 pepper（§3.2），仍需在解密路径上拿 AES 密钥。**把密钥搬进库，没有换来任何新的隔离。**

**D. 权威侧的对齐**：OWASP Secrets Management CS §7.3 —「You should not store keys next to the secrets they encrypt, except if those keys are encrypted themselves」（信封加密，见 §5.3）；OWASP Key Management CS §Storage 第 1 条 —「should **never** be committed to source code repositories or embedded in build artifacts… Secrets and keys should be stored in a dedicated secrets-management solution or key vault」；NIST SP 800-57 Pt1 R5 §5.3 — cryptoperiod 存在的四条理由之一是「**Limits the amount of exposure if a single key is compromised**」（限制单把密钥失陷时的暴露面）。

**E. 这条结论的适用边界**：结论 3「威胁模型不变」依赖一个本仓已核实的事实——**应用 DB 角色 = schema 拥有者**（§3.6）。若运维在仓外另建了一个受限角色给应用（仓内 `GRANT`/`REVOKE` 零命中，无法证实也没法否证），则「注入 ⇒ 读到密钥」需要多一跳，但**它读自己那张放密钥的表这一跳省不掉**——除非那张表对一个必须用它的角色不可读，而那在逻辑上不成立。

### 5.2 ② `MN_SESSION_PEPPER` 与另两把的风险等级

**结论：两个不等价的断言要拆开看——「泄漏后果不同质」成立，「认证类密钥保护等级必须更高」在一手来源里没有依据，而「必须分开保管」有一手依据。**

**A. 后果不同质（成立）。** 方向不同、可逆性不同、时间轴不同：

| | AES/HMAC 泄漏 | pepper 泄漏 |
|---|---|---|
| 破坏的是 | **机密性** | **认证** |
| 时间轴 | **回溯性**：过去写的、现在写的、未来写的 PII 全受影响 | **前瞻性**：只对泄漏之后新造的 token 有用 |
| 需要的最少权限 | **只读** | **写**（`INSERT INTO mn_auth_session`），或能恢复备份 |
| 攻击链长度 | 备份 → 离线解密，一步 | 备份 → 算 HMAC → **写一行** → 拿到 cookie，两步 |

**B. 你那个论证里没说出来的前提，必须补上。** 「泄露 pepper ⇒ 伪造任意用户会话」在**能力**上正确：攻击者可以任选 `userId`、任选 token、算出合法 `token_hash`。但把它当成**已实现的认证绕过**需要一个前提——`readActor` 是 `WHERE token_hash = ?` 的等值查表（`auth.ts:129-144`），所以还需要库里真有这么一行。于是：

- 攻击者**只有只读备份**：不能伪造会话。最多做的是对猜想的 token 做离线验算，而 token 是 `randomBytes(32)`（256 bit，`auth.ts:82`）——**本来就不可爆破**，pepper 泄漏在这里没有增量。
- 攻击者**有写权限**（SQL 注入带写、或把备份恢复到线上）：才成立。

⇒ **在「只拿到只读备份」这一具体场景里，`MN_AES_KEY` 严格更严重。** 任何把 pepper 的等级说成「必然高于 AES 密钥」的说法，都在这个场景下被自己的论据推翻。

**C. 那 pepper 到底防住了什么？**（这是本仓设计里容易被误解的一点）既然 token 有 256 bit 熵，HMAC-SHA256 本身就不可爆破。pepper 的真实作用是 §5.1-C 那张表的第一行：**「攻击者拿到只读 DB」不等于「拿到可用会话」**。它是纵深防御，不是承重结构。反过来说，pepper **不阻止**攻击者看到「哪些 `user_id` 在什么时间有会话」这类元数据（`mn_auth_session` 表本身），也不阻止它伪造 `token_hash` 这个值本身。

**D. 「认证类密钥要有更高保护等级」——找不到一手出处。** 我检索了 OWASP Secrets Management CS、OWASP Key Management CS、NIST SP 800-57 Pt1 R5 与 SP 800-131A R2：

- OWASP KM CS §Key Usage 列了三条理由，第二条是「**Limiting the use of a key limits the damage that could be done if the key is compromised**」——讲的是**限制用途**来限制爆炸半径，不是给密钥类别排保护等级。
- OWASP SM CS §2.3 / §6.3 讲 least privilege，讲的是**谁能读**，不区分密钥类别。
- NIST SP 800-57 Pt1 R5 全文出现 `protection level` **0 次**（实测 regex 计数）。Rev 4 的分级概念在 Rev 5 里不是一等公民；Rev 5 的对应内容是 §5.2 的**单一用途**要求 + §5.3.6 按密钥类型给的 cryptoperiod。

**E. 「必须分开」有硬依据（本仓已经做到了）。** NIST SP 800-57 Pt1 R5 **§5.2 Key Usage**（p.33）原文：

> In general, a single key **shall** be used for only one purpose (e.g., encryption, integrity authentication, key wrapping, random bit generation, or digital signatures). There are several reasons for this:
> 1. The use of the same key for two different cryptographic processes may weaken the security provided by one or both of the processes.
> 2. **Limiting the use of a key limits the damage that could be done if the key is compromised.**
> 3. Some uses of keys interfere with each other.

（`shall` 是 Rev 5 相对 Rev 4 的加强——同文档变更记录 p.151 第 23 条：「In Section 5.2, the use of "should" in the first line has been changed to "shall" to more strongly indicate that keys must not be used for multiple purposes」）

⇒ 本仓 `MN_AES_KEY` / `MN_HMAC_KEY` 分离（`field-crypto.ts:25-26`）、`MN_SESSION_PEPPER` 另算一把，三把互不复用，**符合这条 `shall`**。

**F. pepper 泄漏的后果在 NIST 里有对应表述。** SP 800-57 Pt1 R5 §5.3.6(3)「Symmetric authentication key」：

> Note that **if a MAC key is compromised, it may be possible for an adversary to modify the data and then recalculate the MAC.**

本仓的 pepper 就是一把 MAC 密钥（`createHmac("sha256", pepper())`），NIST 这句话描述的正是「泄漏后攻击者可自行产出任意合法 MAC」——在 `mn_auth_session` 上，「产出任意合法 MAC」= 「产出任意合法会话」。**这是「泄漏 pepper = 可伪造」这个判断的最直接一手背书**，也是我找到的最接近「认证密钥后果不同质」的原文。

同节的 cryptoperiod 建议：对称认证密钥 originator-usage period **不超过两年**，recipient-usage period 不超出 originator 结束 **三年以上**（§5.3.6(3)b）。对比 §5.3.6(6)b 对称数据加密密钥：加密小体量数据「might have an originator-usage period of **up to two years**」，recipient 不超出三年以上。⇒ **NIST 给这两类的 cryptoperiod 建议是同一个量级**，这从侧面否定了「认证类要更严」。

### 5.3 ③ 信封加密（DB 存 wrapped DEK）

**结论：这不算「把密钥存在数据库里」——一手来源明文允许——但在本仓形态下它换不到想要的边界。**

**A. 算不算「密钥入库」？不算。** 三处一手来源，三处都认可这个例外：

1. OWASP Secrets Management CS **§7.3**：

   > You should not store keys next to the secrets they encrypt, **except if those keys are encrypted themselves (see envelope encryption)**. Start by consulting the Key Management Cheat Sheet on where and how to store the encryption and possible HMAC keys.

   「键本身**被加密了**」是原文给的**例外条件**，不是漏洞。

2. OWASP Key Management CS §Storage 第 6 条：

   > If you are planning on storing keys in offline devices/**databases**, then **encrypt the keys using Key Encryption Keys (KEKs)** prior to the export of the key material. **KEK length (and algorithm) should be equivalent to or greater in strength than the keys being protected.**

3. NIST SP 800-57 Pt1 R5 **§B.3.4 Symmetric Data-Encryption Keys**：

   > In many cases, **the key is protected and stored with the encrypted data**. When archived, the key should be wrapped (i.e., encrypted) by an archive-encryption key or by a symmetric key-wrapping key that is wrapped by a protected archive-encryption key.

   ⇒ 你单独存的是 **wrapped DEK（密文）**，不是密钥。这与 §5.1 的论证**不冲突**：§5.1 论证的是「把明文密钥放进库，威胁模型没变而结果变坏」；包装之后，攻击者拿到备份**只拿到密文**，回到 §5.1-C 表格的第一行。

**B. 算法本身合规。** NIST SP 800-131A R2 §7 / Table 6（p.16）：「The use of **AES-128, AES-192 and AES-256 for both the wrapping and unwrapping** of keying material is **acceptable**」。若实现为 AES-256-GCM 包装（本仓已有 `aes-256-gcm` 与 AAD 惯例，`field-crypto.ts:58,118-121`），同一份 Table 1 的 AES-256 条目适用。若要正式走 key-wrapping 专用算法，SP 800-38F 的 KW/KWP 是 SP 800-131A §7 点名的 approved method。

**C. 代价是什么。** 按本仓形态逐条：

| 代价 | 具体是什么 |
|---|---|
| **外部依赖** | KEK 必须存在于 DB 到不了的地方。这是整个方案唯一的支点，也是它在本仓塌掉的地方（见 D） |
| **离线性** | **没有任何改善**。谁拿到 KEK 谁就能离线解密。信封加密不是 KMS 那种「密钥从不离开保险库」的性质，除非 KEK 本身由一个服务托管 |
| **代码面** | `decryptField`（`field-crypto.ts:139-155`）从一步变两步；`blindIndex`（`:171-175`）与 `encryptField`（`:116-123`）要用同一把 DEK 才能保证密文与盲索引口径一致——**这会连带把 `MN_HMAC_KEY` 也拖进包装层**，即两把都要 wrap |
| **数据模型** | 要新增「每行/每版本一个 wrapped DEK」的存储与版本簿记。而现有设计是 `field-crypto.ts:98` 明写的：「一期只有一把钥匙，轮换属 MATT-36」，`MN_KEY_VERSION` 只做记录、**不做密钥选择** |
| **轮换** | OWASP SM §2.4 / KM CS §Cryptoperiods：「To retire a KEK, **re-wrap** stored DEKs under the replacement KEK before destroying the old one. Rewrapping leaves the DEKs unchanged and does not reset their cryptoperiods」——好消息是换 KEK 不用重加密全部 PII，代价是多一套 rewrap 批处理 |
| **丢 KEK = 丢全部 PII** | NIST §B.3.4 要求 DEK 在数据生命周期内**必须可恢复**（备份/归档）。KEK 成为比现在的 `MN_AES_KEY` **更高**单点故障 |

**D. 在本仓现实吗：不现实。** 唯一的问题只有一个——**KEK 放哪**。逐条对照本仓形态：

- 部署形态：单机 Docker Compose、无 KMS、无 HSM、无 Vault（`deploy/docker-compose.yml` 全部 6 个服务：postgres / minio / migrator / app / nginx；`deploy/README.md:146-151` 自述「**不拍密钥托管口径**，属 MATT-36（HITL）」）。
- ⇒ KEK 只能是应用主机上的一个文件或一个 env。
- 而 `postgres` 就在同一个 compose 栈里，pgdata 是 named volume（`docker-compose.yml:94`），**与 app 同一台机器**。
- ⇒ 「主机被登录」这一场景下，KEK 与数据库**同时**沦陷。信封加密把防线从「DB 备份离开了主机」挪到「主机本身被拿下」，**没有跨过本仓最现实的那条边界**。
- 更糟的是 app 与 db 共享 `PGPASSWORD`（`docker-compose.yml:44`），主机被拿下时密码也在同一处。

**E. 什么情况下它变成正确答案（触发条件，写给 MATT-36）。** 三条之一成立即值得重开：

1. **数据库变成托管服务**（RDS / Cloud SQL / 阿里云 RDS），物理上与应用主机分离 ⇒ 拿 RDS 备份不再等于拿 KEK。
2. **引入 Vault / KMS**。此时正确形态不是「自己写包装」，而是把加解密本身交出去。HashiCorp Vault transit 官方文档的可核实性质：
   > "Vault doesn't store the data sent to the secrets engine." / "The primary use case for `transit` is to encrypt data from applications **while still storing that encrypted data in some primary data store**." / "Note that Vault **does not store** any of this data. The caller is responsible for storing the encrypted ciphertext."
   > rewrap: "This process **does not reveal the plaintext data**. As such, a Vault policy could grant almost an untrusted process the ability to 'rewrap' encrypted data, since the process would not be able to get access to the plaintext data."

   顺带一提，Vault 文档的 **Convergent Encryption** 一节描述的用途（「allow values to be stored encrypted in a database, but with limited lookup/query support, so that rows with the same value for a specific field can be returned from a query」）**正是本仓盲索引在做的事**——可以拿它当本仓 `MN_HMAC_KEY` 存在的行业对照。
3. **合规要求给出外部托管的密钥**（此时按 OWASP SM §3.2.2 走，且 CI 与部署工具要单独配 Vault 凭据，§3.2.2 有清单）。

---

## 6. 强度核验：三把密钥够不够（NIST SP 800-131A Rev 2）

| 本仓用法 | SP 800-131A R2 原文结论 | 判定 |
|---|---|---|
| AES-256-GCM | Table 1（p.7）：「AES-256 Encryption and Decryption — **Acceptable**」；正文 p.8：「The use of AES-128, AES-192, AES-256 is **acceptable** for encryption and decryption using the approved modes in the SP 800-38 series」（GCM 由 SP 800-38D 规定，见 §10 脚注 20） | ✅ 合规 |
| GCM 的 96-bit IV | 本仓 `IV_BYTES = 12`（`field-crypto.ts:44`），每次 `encryptField` 现 `randomBytes(12)`（`:117`） | ✅ 符合 SP 800-38D 推荐长度 |
| GCM 的 IV 复用上限 | Vault transit 文档「NIST rotation guidance」节转述 SP 800-38D §8.3：同一 key version 累计加密 **2^32 次**前应轮换（AES-GCM、随机 96-bit IV）。OWASP KM CS §Cryptoperiods 转述同一句 | ⚠ **推断**：本仓未做用量计数（`field-crypto.ts:98` 自述轮换未做）。按 birthday bound，2^32 次随机 IV 的碰撞概率量级约 2^23，对一个内网工具尚可接受，但这是**推断**，不是实测，也不是合规声明 |
| HMAC-SHA256 + 256-bit key（盲索引） | Table 9 + §10 正文 p.21：「HMAC Generation: **Keys less than 112 bits in length are disallowed**... The use of key lengths **≥ 112 bits is acceptable**」；「Any approved hash function may be used」（SHA-2 家族在 Table 8 里「Acceptable for all hash function applications」） | ✅ 合规（256 ≥ 112） |
| HMAC-SHA256 + `MN_SESSION_PEPPER`（**字符串**） | 同上，门限按 HMAC 密钥的**字节长度**算。`.env.example:54` 的生成命令给出 32 随机字节的 base64url = 43 字节 = 344 bit | ✅ 合规（前提是按该命令生成） |
| CI 的回落占位值 | `ci.yml:38` = `ci-only-not-for-production`（26 字节 = 208 bit） | ⚠ **长度合规但强度不合规**：SP 800-131A 只管长度；OWASP SM §2.7.1 要求「New secrets must be securely generated and **cryptographically robust enough for their purpose**」。固定明文不满足后者——这是**我的判定**，非来源明说 |
| 单独一句「pepper 强度」 | — | NIST SP 800-131A R2 **不覆盖** pepper 概念（它只覆盖算法与密钥长度）。pepper 的强度要求在 OWASP Password Storage CS：「In this strategy, a password is hashed… then hashed again using an HMAC… **the pepper is acting as the HMAC key and should be generated as per requirements of the HMAC algorithm**」（即走 HMAC 的长度与随机性要求） |

**结论：三把的强度都够。** 唯一缺口是 **GCM 用量上限无计数**——而 NIST 与 OWASP 都是把这条挂在「轮换」而不是「强度」名下。

---

## 7. 本仓可行的落地方案

**形态前提（§3.3 已核实）**：单机；`deploy/docker-compose.yml` 起 postgres / minio / migrator / app / nginx 五个服务；app 单副本单进程；无 KMS / Vault / HSM；镜像非 root（uid 1001 `nextjs`）；无 TLS（`deploy/README.md:130-131`，域名未定死）。

### 7.1 三个方案

**方案 A —— 保持现状：compose `environment:` 注入**（当前形态）

**方案 B —— compose `secrets:`（file 支撑）+ 启动时一次性读入**

```yaml
# deploy/docker-compose.yml 增补（示意）
services:
  app:
    secrets:
      - mn_aes_key
      - mn_hmac_key
      - mn_session_pepper
secrets:
  mn_aes_key:
    file: ./secrets/aes_key        # 该目录须 gitignore
  mn_hmac_key:
    file: ./secrets/hmac_key
  mn_session_pepper:
    file: ./secrets/session_pepper
```

⚠ **这与一条已写下的仓内决定冲突，必须显式说出来。** `field-crypto.ts:32-34` 原文：「托管方式（KMS / secret 注入 / 轮换周期）定下来之前，**不要在这里加第三处密钥来源** ——文件、数据库、内置默认值都不许。」

这条禁令的**本意是「不许同时存在多个来源」**（防止「有的部署走 env、有的走文件、有的走默认值」的半可用状态），而不是「文件这个来源永久不许用」。方案 B 是**替换** env，不是**新增**来源，因此不违反它的意图——但**确实需要 MATT-36 显式改写这一行**，否则下一个读代码的人会认为方案 B 违规。**这是决策项，不是实现项。**

**方案 C —— DB 存 wrapped DEK，KEK 在主机文件**（§5.3 判定：现在不现实，仅登记为选项）

### 7.2 四场景表现表

| | A：`environment:`（现状） | B：compose `secrets:` 文件 | C：wrapped DEK 入库 | （对照）D：明文密钥入库 |
|---|---|---|---|---|
| **备份泄漏**（`pg_dump` / pgdata 卷被拷走） | ⚠ 拿到密文；**拿不到密钥**（密钥在容器 env，不在 pgdata 里）。但 env 落在宿主机的 compose 解析结果里，**若备份主机 `/var/lib/docker` 则一并丢失** | ✅ 同 A，且密钥不进 `docker inspect` / `docker compose config` 的输出 ⇒ 运维日志、CI 日志、贴配置到工单的场景不再泄漏 | ✅ **本方案唯一真正买到的一格**：备份里只有 wrapped DEK | ❌ **彻底失守**：备份 = 全部 PII 明文 + 全部会话伪造能力 |
| **应用主机被登录**（root 或 docker 组权限） | ❌ `docker inspect app` 直接看到三把值；`/proc/<pid>/environ` 可见（同 uid 或 root） | ❌ 文件路径已知即读到。但**不再是「看一眼 `docker inspect` 就到手」**，需要知道文件路径 | ❌ KEK 文件在同一台机器上，**与 pgdata 同时沦陷**。无改善 | ❌ 全失守，且 pgdata 与密钥同一台机器 |
| **SQL 注入** | ✅ 无改善也无恶化（注入读不到 env，除非能读 `/proc`）——**但本仓当前注入面实测为零**（§3.6） | ✅ 同 A | ✅ 注入只拿到 wrapped DEK；`decryptField` 要 KEK 才走得通。**注意：这是把「以后可能出现的注入」纳入考虑，不是今天就有的防护** | ❌ 注入直接 `SELECT` 出密钥 |
| **密钥轮换** | ⚠ 改 `deploy/.env` + `docker compose up -d app`。**换 `MN_AES_KEY` 会让全部旧密文解不开**（`field-crypto.ts:33-34` 自述）——实测风险见下方注 | ✅ 同 A；额外好处：可以用 `docker compose` 之外的方式（如 ansible/systemd secret）编排，且能对文件单独设权限与属主 | ✅ 换 KEK 只需 rewrap，**不必重加密 PII**（OWASP KM CS §Cryptoperiods）。**但要新写 rewrap 批处理**（仓内无任何工具） | ❌ 轮换要在业务库里改行，且旧行仍可被旧密钥解密 |

> **注（上表第 2 行的实务补充）**：Docker Compose 的 **非 swarm** `secrets:` 底层就是宿主机上一个 bind-mounted 文件。方案 B 提升的是**可见性**（不进 `docker inspect`、可设权限、可审计），不是**隔离性**。任何声称 compose secrets 能防住「主机被登录」的说法都是错的——这一点 OWASP SM §5.1 自己也划了范围：「Mounted volumes (file) … Ensure that these mounts are mounted in by the orchestrator and never built-in, as this will leak the secret with the container definition.」

### 7.3 建议（供 MATT-36 参考，本文不代拍板）

**留在方案 A，并做三处收紧。** 理由：本仓是内网自用工具、单副本、五服务单机栈、无 KMS；`OWASP SM §5.1` 对三种注入方式给了明确优先级，并把环境变量排在最后——但它同一段的理由是「environment variables are generally accessible to all processes and **may be included in logs or system dumps**」，在本仓**没有启动日志打印 env、没有 core dump、没有多进程共享 env**（单副本单进程，§3.3），这三条风险全部不成立。为了消除「`docker inspect` 泄露」而改写一条已写下的仓内禁令（`field-crypto.ts:32-34`）、并新增一条代码路径，**收益与成本不成比例**。

**三处收紧**（都不碰密钥的存放位置）：

1. **给 `migrator` 收窄环境块。** `docker-compose.yml:125` 把 `*app-env`（含全部三把）传给了跑 `tools/migrate.mjs` 的一次性容器，而该脚本对三把密钥的引用实测为**零**。改成只给 `PG*` + `MN_DB_CONFIRM`。这直接落实 NIST §5.2 的第二条理由（限制用途以限制爆炸半径）与 OWASP SM §2.3 的 least privilege。
2. **把 `pepper()` memoize 成与 `aesKey()` 同一形状。** `auth.ts:26-30` 现在每个需鉴权的请求重读一次 `process.env`（§3.2）。改成模块级缓存后：热路径归零；且顺带得到一个「启动时集中校验密钥」的挂载点。
3. **把 `assertFieldCryptoConfigured()` 接进 `instrumentation.ts`。** 该函数已写好（`field-crypto.ts:110-113`）且**零调用方**（实测）。现在「缺密钥」的失败点是第一次用到加密的那次请求（`:104-108` 自己写了这一点）。挂到 `src/instrumentation.ts:51-57` 的 `register()`（或 `instrumentation-node.ts` 的 `registerNode()`）后，失败发生在 `ready` 之前，而不是第一次查当事人详情时。

**方案 B 记为可触发的升级**：触发条件 = ①「运维日志/工单里出现过 compose 展开结果」的实际事件，或 ②进入托管数据库。**方案 C 记为可触发的升级**：触发条件 = ①引入 Vault/KMS，或 ②数据库变成托管服务。在此之前不动。

---

## 8. 一手来源清单

**OWASP（`https://cheatsheetseries.owasp.org/cheatsheets/…`，取于 2026-10-15）**

- `Secrets_Management_Cheat_Sheet.html`
  - §2.3 Access Control（least privilege、细粒度访问控制）
  - §2.7.1 Creation（「securely generated and cryptographically robust enough for their purpose」「minimum privileges」）
  - §2.7.2 Rotation
  - §4.2 / §4.2.2 Envelope & BYOK（「use your key or the customer main key … to encrypt the **data key** … The data key, in turn, encrypts the secret」）
  - §4.4 API limits（KMS 有 API 限额；提到 data key caching）
  - §5.1 Injection of Secrets (file, in-memory) —— 三种方式与 env 的排序与理由
  - §5.3 Internal vs External Access
  - §6.2 Dynamic vs Static Use Cases（"storage encryption keys" 被列为 static long-term）
  - §6.3 Ensure limitations are in place
  - §7.1（推荐 AES-256-GCM）
  - **§7.3 Where to store the Encryption Keys?** —— 「except if those keys are encrypted themselves (see envelope encryption)」
- `Password_Storage_Cheat_Sheet.html`
  - **§Peppering** 开头：「It prevents an attacker from being able to crack any of the hashes **if they only have access to the database, for example, if they have exploited a SQL injection vulnerability** or obtained a backup of the database.」
  - **§Common requirements for peppering strategies**：「Unlike a password salt, the pepper should not be public and **should not be stored along with the generated hash**. The pepper should be **stored separately from the password database**.」「Peppers are secrets and should be stored in "secrets vaults" or HSMs」
  - **§Post-hashing peppers**：「the pepper is acting as the HMAC key and should be generated as per requirements of the HMAC algorithm」
  - §Introduction：「Consider using a pepper to provide additional defense in depth (**though alone, it provides no additional secure characteristics**)」—— 本仓 pepper 定位的原文依据
- `Key_Management_Cheat_Sheet.html`
  - **§Storage 第 1 / 4 / 6 条**（不入源码/构建产物、不存明文、**入库前用 KEK 包装**）
  - §Key Usage（三条理由；与 NIST §5.2 呼应）
  - §Accountability and Audit（least privilege，引 ASVS 5.0 §13.3.2）
  - §Cryptoperiods and Rotation（对称数据加密密钥 ≤2 年 origin / ≤3 年 recipient；**AES-GCM 随机 96-bit IV 下每把 key 限 2^32 次加密**，引 SP 800-38D §8.3；**retire KEK ⇒ re-wrap DEKs**）
  - §Escrow and Backup（「the database that is used to store the keys is encrypted …」）

**NIST（`nvlpubs.nist.gov` PDF 原件，2026-10-15 下载并抽取文本）**

- **SP 800-57 Part 1 Rev. 5**（`nist.sp.800-57pt1r5.pdf`，171 页，May 2020）
  - §5.1.1 对称密钥类型（p.31）：#6 Symmetric data-encryption key、#7 Symmetric key-wrapping key、#9 Symmetric master key/key-derivation key
  - **§5.2 Key Usage（p.33）**：「a single key **shall** be used for only one purpose」+ 三条理由；变更记录 p.151 第 23 条记录了 `should`→`shall` 的加强
  - §5.3 Cryptoperiods（p.34）：定义 + 四条理由
  - §5.3.3.1 Communications versus Storage
  - §5.3.6(3) Symmetric authentication key（p.40）：**「if a MAC key is compromised, it may be possible for an adversary to modify the data and then recalculate the MAC」**；originator ≤2y / recipient ≤+3y
  - §5.3.6(6) Symmetric data-encryption key（p.41）：originator ≤2y（小体量）/ ≤1 周（大体量）；recipient ≤+3y
  - §6.2.2 Integrity：「All key information requires integrity protection」
  - §8.2 Operational Phase / §8.2.2.1 Backup Storage
  - **§B.3.4 Symmetric Data-Encryption Keys（p.139）**：「In many cases, **the key is protected and stored with the encrypted data**. When archived, the key should be wrapped…」
  - 全文 `protection level` 出现 **0 次**（实测 regex 计数）
- **SP 800-131A Rev. 2**（`NIST.SP.800-131Ar2.pdf`，33 页，March 2019）
  - §1.2.1 Security Strengths（引用 SP 800-57 Pt1 的 2030 年 128-bit 迁移计划）
  - **Table 1（p.7）**：AES-256 Encryption and Decryption — **Acceptable**
  - §2 正文（p.8）：「AES-128, AES-192, AES-256 is acceptable … using the approved modes in the SP 800-38 series」
  - §7 / **Table 6（p.16）**：AES-128/192/256 **key wrapping and unwrapping** — Acceptable
  - §8 / Table 7：HMAC-based KDF — Acceptable（KDF 密钥 ≥112 bit）
  - **Table 8（p.19）**：SHA-2 family — Acceptable for all hash function applications
  - **§10 / Table 9（p.20-21）**：HMAC Generation/Verification — 密钥 **≥112 bits Acceptable**，**<112 bits Disallowed**（verification 侧 <112 为 legacy use）

**HashiCorp（官方文档，取于 2026-10-15）**

- `https://developer.hashicorp.com/vault/docs/secrets/transit`（v2.x）
  - 开篇：「Vault doesn't store the data sent to the secrets engine」「The primary use case for `transit` is to encrypt data from applications **while still storing that encrypted data in some primary data store**」
  - Usage 2：「Note that Vault **does not store** any of this data. The caller is responsible for storing the encrypted ciphertext.」
  - Usage 4（rewrap）：「This process **does not reveal the plaintext data**. As such, a Vault policy could grant almost an untrusted process the ability to "rewrap" encrypted data…」
  - §NIST rotation guidance：转述 SP 800-38D，AES-GCM 单 key version 应在约 2^32 次加密前轮换
  - §Convergent Encryption：「allow values to be stored encrypted in a database, but with limited lookup/query support, so that rows with the same value for a specific field can be returned from a query」

**Node.js（官方文档）**

- `https://nodejs.org/docs/latest-v22.x/api/crypto.html`（Node.js v22.23.3）
  - `crypto.createCipheriv(algorithm, key, iv[, options])` / `crypto.createDecipheriv(...)` —— 本仓 `field-crypto.ts:118,147` 用法正确
  - `cipher.getAuthTag()` / `decipher.setAuthTag(buffer[, encoding])` / `cipher.setAAD(buffer[, options])` —— `field-crypto.ts:119,121,148-149` 用法正确；文档明说 GCM/CCM/OCB/chacha20-poly1305 支持 `authTagLength` 选项
  - `crypto.createHmac(algorithm, key[, options])` —— `field-crypto.ts:172`、`:33` 用法正确
  - `crypto.randomBytes(size[, callback])` —— `field-crypto.ts:117`、`auth.ts:82`
  - **`crypto.hkdfSync(digest, ikm, salt, info, keylen)`**（RFC 5869）—— 若将来走「一个 root secret → HKDF 派三把子钥」，这就是对应的官方 API；`info` 上限 1024 字节，`keylen` 上限 255 × digest 字节数
  - `crypto.scryptSync(password, salt, keylen[, options])` / `crypto.timingSafeEqual(a, b)` —— `auth.ts:38,45`
  - **§Using strings as inputs to cryptographic APIs**：「Secret keys should **almost exclusively be random or pseudorandom byte sequences**」+ 「when a byte sequence of length `n` is derived from a string, **its entropy is generally lower** than the entropy of a random or pseudorandom `n` byte sequence」—— 这是 `MN_SESSION_PEPPER` **用字符串而非字节**时应当注意的官方提示

**本仓**

- `src/app/lib/server/crypto/field-crypto.ts`：`:25-27`（三键用途注释）、`:32-34`（「不加第三处密钥来源」）、`:44`（`IV_BYTES=12`）、`:47`（`KEY_BYTES=32`）、`:58`（AAD）、`:67-84`（`parseKeyMaterial`）、`:87-96`（`aesKey`/`hmacKey` 缓存）、`:98-101`（`keyVersion`，**无缓存**）、`:104-113`（`assertFieldCryptoConfigured`，**零调用方**）、`:116-123`（`encryptField`）、`:139-155`（`decryptField`）、`:158-175`（`blindIndex` 及其动机注释）
- `src/app/lib/server/auth/auth.ts`：`:21-23`（cookie/TTL）、`:26-30`（`pepper()`，**无缓存**）、`:32-34`（`tokenHashOf`）、`:37-39`（`derive`，**scrypt，无 pepper**）、`:81-94`（`createSession`）、`:96-105`（cookie）、`:107-115`（`destroySession`）、`:123-177`（`readActor`，`:143` 为验证点）、`:59-72`（`isSystemOwner` / `isAdmin`）
- `src/app/lib/server/http.ts:185-191`（`withActor` → `readActor`，每 handler）
- `src/app/lib/server/db/client.ts`：`:30-50`（`makePool`，`:33` `PGUSER`）、`:57-72`（启动断言）、`:75-97`（`getDb`）
- `src/app/lib/server/db/schema/hosts.ts`：`:436`（`idNumberHash varchar(64)`）、`:461`（`uk_mn_party_identity`）
- `src/app/lib/server/db/schema/ddl.ts`：`:12-24`（`sqlInList` 的 `sql.raw` + 正则白名单）
- `src/app/lib/server/services/notifications.ts:1115-1118`（`visibleHostExists`，`sql.raw` 取值来自三元）
- `src/instrumentation.ts:51-57`（`register`）
- `tools/migrate.mjs`：`:35-39`（与 app 同一个 `process.env.PGUSER`）、`:53-61`（`MN_DB_CONFIRM` 闸门）
- `.env.example`：`:3`（「任何密钥都不入库、不进镜像」）、`:24-26`（gitignore 规则）、`:37-38`、`:51-56`（pepper 段 + 生成命令）、`:57`
- `.github/workflows/ci.yml`：`:33-38`（三把的注入与回落占位）
- `deploy/docker-compose.yml`：`:3-7`（单副本）、`:10-13`（不拍托管口径）、`:34-76`（`x-app-env` 全量 env 块）、`:56-59`（字段加密段）、`:69-72`（pepper 段）、`:94`（pgdata 卷）、`:125`（**migrator 继承全量 env**）、`:128`（`MN_DB_CONFIRM`）、`:146`（app 等 migrator 成功退出）
- `deploy/Dockerfile`：不 `COPY .env`；`USER nextjs`；`CMD ["node", "server.js"]`
- `deploy/README.md`：`:103-115`（单副本裁定）、`:119-126`（部署安全项第 1 条）、`:146-155`（「不拍密钥托管口径」属 MATT-36；「**不验证起栈**」）
- `docs/tech-stack-decision.md:261,311-312`（原始口径「密钥从 env 注入，不入库」）
- `.trellis/spec/backend/database-guidelines.md:140`
- `node_modules/drizzle-orm/sql/sql.cjs`：`:306-322`（`Param`）、`:324-333`（`sql` 模板）、`:343-346`（`sql.raw` → `StringChunk`）；版本 `drizzle-orm@0.45.3`（`package.json`）
- `agent-work/*.mjs`：大量 `sql.unsafe` 字符串拼接（`probe-convert-form.mjs:222-235`、`smoke-batch.mjs:177` 等），均在 `src/` 之外、不进镜像；`smoke-parties.mjs:65-67` 读 env 三键
- `src/instrumentation-node.ts` 存在（`src/instrumentation.ts:2` 指向它）—— 顺带更正 `docs/research-croner-status-heartbeat.md:367`「`src/instrumentation.ts`：**当前不存在**（`Test-Path` 为 false）」这一条，该文件现已落地（2026-10-14/15）

---

## 9. 未解 / 无法核实

1. **真实部署环境未验证。** `deploy/README.md:152-155` 明说 `docker compose up` 没跑过、`Dockerfile` 构建也没跑过。本文的部署形态结论全部限定于**仓库内的配置契约**，不是实测。生产上 `app` 是不是真的单进程、`MN_SESSION_PEPPER` 是不是真的按 `.env.example:54` 生成、postgres 是不是真的与应用同机 —— 都需要在真实主机上确认。
2. **生产 `MN_AES_KEY` / `MN_HMAC_KEY` / `MN_SESSION_PEPPER` 的实际值与强度未知。** 本机 `.env` 三把均已设值（长度 43/43/31 字符），但我只测了长度，**没有读取、没有记录任何值**，也无法判断生产用的是不是同一形态。`docs/audit-authz-2026-10-12.md:335` 已记录过一次担忧：「`MN_SESSION_PEPPER` 在 `.env` 里是 dev 占位值。若生产沿用同一值……」，本次核实**无法证实也无法证伪**这一条是否已修。
3. **应用 DB 角色是否真是 schema 拥有者，只能从「仓内无 GRANT/REVOKE + migrator 与 app 共用 PGUSER」推出**，没有连上任何真实数据库执行 `SELECT current_user` / `\du` 核实。共享 dev 机上是否有人手工加过权限隔离，无从判断。
4. **`MN_AES_KEY` 的累计加密次数无任何记录。** §6 里「2^32 次 IV 碰撞风险量级约 2^23」是 birthday bound 的**算术推断**，不是实测，也未考虑 GCM 的其他失效模式。
5. **「认证类密钥保护等级必须高于数据密钥」这个命题，我没找到一手来源。** OWASP SM §2.3/§6.3 讲 least privilege 不区分密钥类别；NIST SP 800-57 Pt1 R5 全文无 `protection level`；§5.3.6 给对称认证密钥与对称数据加密密钥的 cryptoperiod 建议是同一量级（都是 ≤2y origin / ≤+3y recipient）。**如果项目内部有决策记录要求这个排序，需要单独回溯那个出处**——本文没有为它找到依据，也没有断言它错。
6. **方案 B 是否与 `field-crypto.ts:32-34` 的禁令冲突，取决于 MATT-36 怎么解释「加第三处密钥来源」这行字的意图。** 我读出的是「防多来源并存」而非「文件来源永久禁止」，但这是**我的解读**，作者原意需要确认。
7. **未评估零信任/机密计算场景。** 若将来部署到支持 Confidential VM / HSM 的环境，`src/app/lib/server/crypto/field-crypto.ts:14-19` 那条「`node:crypto` 只能在服务端、不得被客户端组件 import」的结构会与「密钥不出可信区」的要求相互作用。本文未展开。
8. **`MN_KEY_VERSION` 的设计缺陷未评估。** `field-crypto.ts:98-101` 明写它「只做记录与自描述，**不做密钥选择**」——即当前实现下版本号与实际密钥无绑定关系。这不在本题范围内，但任何轮换方案都会撞上它。
