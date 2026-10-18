# deploy

反向代理与 Node 服务的最小可用配置：技术选型 §6、落地方案 **W0-5**。

| 文件                 | 是什么                                               | 谁核对              |
| -------------------- | ---------------------------------------------------- | ------------------- |
| `nginx.conf`         | TLS 终结 + 反向代理（当前只听 80，TLS 未启用，见下） | `verify-deploy.mjs` |
| `Dockerfile`         | 应用镜像（`output: "standalone"`）                   | 构建由 CI 核对      |
| `docker-compose.yml` | 单副本栈：postgres / minio / migrator / app / nginx  | 本票不验证起栈      |
| `verify-deploy.mjs`  | 解析 `nginx.conf` 并断言关键值                       | 它自己              |

## 怎么跑核对

```bash
node deploy/verify-deploy.mjs
```

不需要数据库、不需要 Docker、不需要构建——纯文本解析，所以它能进任何一次提交前检查。
退出码 0 = 通过，1 = 有断言失败。

> **它今天挂在 `pnpm verify` 里了**（`deploy:check`，第 7 道）。
> 2026-10-15 写下这行时没挂，理由记的是「`package.json` 不在本票改动面内」；
> 后来接上了，本行按事实改写。它满足「verify 必须离线」这条约束——纯文本解析。

### 构建与起栈，各自归谁验（2026-10-18 更新）

原先这张表写 `Dockerfile` 与 compose 都「本票不验证」，**构建那一半现在有归属了**：

| 事                                 | 谁验                                    | 怎么验                                 |
| ---------------------------------- | --------------------------------------- | -------------------------------------- |
| `next build` 能不能产出 standalone | **CI**（`pnpm build` 那一步）           | 反向红实测过：注入类型错 ⇒ 退 1        |
| standalone **起不起来**            | 人眼（2026-10-18 实测过一次，见下）     | 原地 `node .next/standalone/server.js` |
| compose 能不能拉起整套             | **仍未验**（Docker 引擎起不来，需提权） | —                                      |

⚠ **standalone 必须原地起，不能拷走再起。** 2026-10-18 实测：`pnpm build` 产出的
`.next/standalone/node_modules/next` 是**指向仓库 `node_modules/.pnpm/...` 的绝对符号链接**
（pnpm 布局），把它 `cp` 到别处后符号链接全部断掉，起服报
`Cannot find module '@swc/helpers/_/_interop_require_default'`。
原地起则正常：`login=200`、定时器打日志、`/` 也 200。

⇒ 这条对 Dockerfile 是不成立的（容器里 `COPY --from=builder` 在同一文件系统内搬，
且 builder 阶段的 `node_modules` 与 `.next` 同处 `/app`），但**对本机手工部署成立** ——
别把 `.next/standalone` 拷到别的目录去跑。

⚠ **`.next/static` 与 `public/` standalone 不会自带**，必须手工搬（Dockerfile 里那两行
`COPY` 就是干这个的）。原地起服时它们恰好都在旁边，所以**看起来**没问题 ——
那是巧合，不是产物自足。手工部署照样要搬。

---

## 不能不改的值

**`proxy_read_timeout` 的默认值 60s，就是会 504 的那个值。** 它不是"保守一点的安全余量"，
它是一个精确的、会触发故障的阈值：

- MATT-44 实测：批量导入 **1000 行 = 81.0s**（81ms/行，逐行一事务的代价）。
- nginx 默认 `proxy_read_timeout 60s` ⇒ 这条请求**必然 504**。
- **而服务端会把那 81 秒跑完、事务照常提交。**

于是发生的是：客户端看到失败 ⇒ 用户重试 ⇒ **第二个请求再跑 81 秒、再写一份库**。
导入有内容幂等键兜底，不会重复建记录——但时间是实打实再花一遍。
「客户端看起来失败、服务端其实成功」是最难排查的那一类形状：没有报错、没有脏数据、
只有一条"用户说导不进去"的工单。

所以 `nginx.conf` 里 `location = /api/import` 的 `proxy_read_timeout 180s`
**是一条不能改回去的值**，改回去等于把一个已知故障装回去。

| 值                        | 在哪                     | 改成什么会坏                                                                                                                                |
| ------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `proxy_read_timeout 180s` | `location = /api/import` | 改到 < 120s ⇒ 81s 的导入 504 而服务端跑完。**默认的 60s 就在这条线上。**                                                                    |
| `client_max_body_size 8m` | `location = /api/import` | 改到 < 6MB ⇒ 合法的大 CSV 在**开始前**就被 413，1000 行上限形同虚设                                                                         |
| `client_max_body_size 1m` | `http{}`                 | 删掉 ⇒ 框架侧按设计也不设 body limit ⇒ **没有任何一层限制请求体**，一个匿名可发的巨大 body 就是内存/带宽放大器                              |
| `proxy_next_upstream off` | `location = /api/import` | 删掉 ⇒ 默认 `error timeout`，nginx 超时后自己重试。单副本时是空操作，**加第二个副本那一刻**就变成用户没点、nginx 自己把 81 秒的导入跑了两遍 |
| `proxy_read_timeout 90s`  | `http{}`                 | 降回 60s ⇒ 任何新加的慢接口默认继承那个会 504 的值                                                                                          |

> **180s 为什么不是 120s？** 裁定的下限是 120s。81.0s 是在**开发机**上量的，
> 生产机更慢的概率大于更快——而且超时的后果不是"慢一点"，是"用户以为失败了"。
> 2.2 倍余量买的是这个不对称。

### 请求体上限为什么导入要单独放开

应用自己的 schema 允许 `MAX_IMPORT_CSV_CHARS = 2_000_000` **字符**
（`src/shared/schema/import.ts:195`）。中文在 UTF-8 里 3 字节/字符 ⇒ 光 `csv` 字段上界
就是 6,000,000 字节 ≈ **5.72 MiB**。

`docs/research-nextjs-stack.md:68` 当时写的是「nginx 侧上限可以设得很小（如 2MB）」——
**那条建议会 413 掉合法的大导入**，而且是在它跑起来之前。1000 行上限和 81s 实测
都是按 6MB 这个 body 上界定的，所以 2MB 与已生效的裁定直接冲突。
`8m` = 6,000,000 × 1.4 的余量。

`verify-deploy.mjs` 不信任这里写的数字：它**从 `src/shared/schema/import.ts` 现读**
`MAX_IMPORT_CSV_CHARS`、现算 UTF-8 下界、再断言 nginx 的值够。
改 schema 忘了改 nginx，那条断言会红。

---

## 为什么只有导入需要 180s

票面要求「顺手核一下其他慢接口」。逐个核过，结论是**其余全都有代码里的硬上界**，
撞不到 60s：

| 接口                                                                               | 实测/推导                                                              | 撞 60s？                |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------- |
| `POST /api/import`                                                                 | **81.0s 实测**（MATT-44）                                              | **会** ⇒ 唯一配 180s 的 |
| `GET /api/notifications`（内含 `pumpNotifications()` + `scanArchiveIncomplete()`） | `OUTBOX_BATCH = 50`、`SCAN_BATCH = 500`；MATT-35 实测积压 50 行约 3.5s | 否                      |
| `GET /api/{matters,risk-matters}/[id]/export`（整卷）                              | `EXPORT_SECTION_LIMIT = 1000` 行/区段，区段数固定 ⇒ 上界固定           | 否                      |
| `POST /api/{matters,risk-matters}/batch`                                           | `MAX_BATCH_IDS = 50`                                                   | 否                      |
| `POST /api/risk-matters/[id]/convert`                                              | `MAX_CASES_PER_CONVERT = 20`，单事务                                   | 否                      |

两个值得记的判断：

- **整卷导出不是长请求。** 它返回的是一个 CSV 文本，大小受 `EXPORT_SECTION_LIMIT = 1000`
  封顶且区段数固定。它的问题从来不是"跑得久"，而是"跑得久的同时还在攒内存"——
  而那是单副本的资源问题，不是超时问题。别拿超时去治它。
- **通知泵是"在用户读请求里跑批处理"，形状比导入更值得警惕，但今天还够不着线。**
  MATT-35 已实测 3.5s，且裁定一期把它搬到应用外的触发器（systemd timer / croner）。
  搬走之后它根本不在 HTTP 路径上——**那才是正确的修法**，
  超时只是没有搬迁之前的临时挡板。

> 如果将来有接口真的变慢，**先查它有没有硬上界**。
> 导入慢是因为「1000 行 × 逐行一事务」——没有上界的是一个接一个的往返。
> 给后者配更长的超时，是把症状当病因治。

---

## 部署形态：单副本（MATT-35，2026-10-13 裁定）

一期单副本。**`docker-compose.yml` 里 `app` 没有 `deploy.replicas`，也不该有。**

单副本下不需要的东西，逐条记在 `nginx.conf` 与 compose 的注释里，免得下一个人又去加：

- `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` / `deploymentId` —— MATT-35 已证伪：
  `src/` 全域对 `use server` / `useActionState` / `useFormStatus` / `<form action=`
  **零命中**（2026-10-13 复核仍为 0），全走 `/api/*` route handler。
  没有 Server Function 闭包可供加密，也就没有滚动发布窗口。
- 多 upstream 负载均衡。

**唯一为「将来加副本」准备的东西**是 `proxy_next_upstream off`（理由见上表）。

---

## 四件部署期安全项的现状

原 README 列的四条，逐条交代：

1. **AES 主密钥与 HMAC 密钥两把分离，env 注入，不入库不进镜像，`key_version` 列先留。**
   → `MN_AES_KEY` / `MN_HMAC_KEY` / `MN_KEY_VERSION` 三个键在 `docker-compose.yml`
   与 `.env.example` 里都是**分离的两项**；`Dockerfile` 刻意不 `COPY .env`。
   ✅ 位置已留。
   → **2026-10-15 追加（MATT-36 收紧）**：三处最小权限已落地 ——
   ① `migrator` 不再继承 `*app-env`（它对三把密钥零引用），
   ② `MN_SESSION_PEPPER` 改为模块级缓存（原先每个鉴权请求重读一次 `process.env`），
   ③ 三把密钥的启动期自检挂在 `instrumentation-node.ts` 的 `registerNode()` 上，
   **缺任何一把都在 server ready 之前 `exit 1`**，而不是等某人第一次打开当事人详情。
   后两条各由 `src/instrumentation.spec.ts` 与 `deploy/verify-deploy.mjs` 断言钉住。

2. **云之家 `appId`/`appSecret` env 注入；回调登记以云之家侧规则为准，
   所以部署域名必须在联调前定死。**
   → 四个键已在 compose 中列出。**域名未定死**（MATT-34 联调前置），
   所以 `nginx.conf` 只听 80、TLS 段是注释。⚠ 改域名要重走一次登记。

3. **请求体上限由 nginx 设死**（框架侧不设 body limit，附件走预签名 PUT 直传，
   后端不中转文件流）。
   → **本票落地。** `http{}` 级 1m、`location = /api/import` 级 8m，
   并由 `verify-deploy.mjs` 断言存在性与下界。补一句：导入是 JSON 传 CSV 文本，
   **不是 multipart**——`importRequestSchema` 收 `{hostType, fileName, csv}`，
   浏览器读文件已经过了一道 `FileReader`。附件走预签名 PUT，不经本层。

4. **明文导出与 `SENSITIVE_FIELD_READ` 审计同链路**；
   **云之家不可达时保留哪些本地密码账号可用（至少一个 `sys_admin`）**。
   → **本票未落地，也落不了。** 前者在 `src/` 侧（`exports.ts` 已实现，本票不碰），
   后者是**运营口径**，不是配置项：它需要在云之家不可达时仍有一条人能进去的密码通道。
   要定这件事需要人的判断（留哪个账号、口令怎么管），不属部署面。

## 本票不做的

- **不接真实部署**（无服务器、无域名）。产出是配置工件 + 可机械核对的断言。
- ~~**不拍密钥托管口径。**~~ ✅ **已拍（MATT-36，2026-10-15）**：三把密钥只经
  `environment:` 注入，不入库、不进镜像、不进 git；另做三处最小权限收紧。
  依据与被否决的两个变体见 `docs/research-secret-storage.md`。
  仍未拍的是**证书托管**（跟着 TLS 那一项）。
- **不启 TLS。** 域名未定死（MATT-34）+ 证书托管未定（属 MATT-36 未拍部分）。
  `nginx.conf` 里 443 段是注释，写全了也只是"看起来能用"。
- **不验证起栈。** `docker compose up` 本票没跑过（本机 Docker daemon 未运行），
  `docker build` 也没跑过。compose 与 Dockerfile 是**按契约写的**，
  不是**按实测跑通的**——用之前先自己起一次。
  （**应用本身的构建**不在这一条里：2026-10-18 起 CI 跑 `pnpm build`，
  且 standalone 已在本机原地起过一次，见上「构建与起栈，各自归谁验」。）
- **不写 `worker` 服务。** MATT-35 裁定一期不引调度进程（通知泵由外部触发器驱动），
  且 `worker/` 下当前只有 README、没有实现。留一个指向不存在代码的服务比不写更糟。

## 三把密钥怎么产出（MATT-36）

**别手抄。** 仓库里有一把工具，它生成、给出校验值、并在你要覆盖正在用的密钥时拦住你：

```bash
# 1. 在你自己的机器上（clone 之后）
node tools/keys.mjs gen

# 2. 把输出**整段**贴进 deploy/.env（每把上方的注释行要一起贴，见下）

# 3. 核对
node tools/keys.mjs check
```

`gen` 只打印，**从不写任何文件**。它读 `deploy/.env` 与 `.env`：发现三把里已经有值就
**拒绝运行**并退出码 1 —— 因为在已部署的机器上重跑一遍、覆盖正在用的值，
会让**全库 PII 永久不可读**（`decryptField` 抛 GCM 认证失败，没有兜底路径）。
确实要重来才加 `--force`（新建环境、或应急轮换）。

### 为什么校验值单独占一行、而不是跟在值后面

每把的 `sha256 前 8 位` 注释行必须在 `MN_AES_KEY=` 的**上一行**，不能写成行尾注释 ——
dotenv 对行尾 `#` 的处理在版本间变过，而「粘贴时被吃掉一个字符」正是这个工具要拦的
事故类型，不能因为工具自己引入一个新的。

它抓的是 `parseKeyMaterial` 抓不到的那一类：**43 个字符里颠倒两个位置，仍是 43 字符、
仍解出 32 字节，长度校验通过** —— 要到读当事人详情时 GCM 认证失败才暴露，
而那与「服务没配好」极难区分。

### 起点：deploy/.env 从哪来

`deploy/` 下**没有** `.env.example`（全仓只有根目录那一份）。从仓库根目录：

```bash
cp .env.example deploy/.env
```

然后填数据库 / MinIO / 云之家那几组，并在其中贴上 `keys:gen` 的三段输出。

### ⚠ 升级后起不来？多半是存量 pepper 的形状不对

自检里 pepper 的长度校验是本轮新增的（此前它是三把里**唯一**只查「非空」的）。
所以**早于这次变更创建的部署**可能带着一把短 pepper —— 升级后第一次启动就会：

```
Error: An error occurred while loading instrumentation hook:
MN_SESSION_PEPPER 解出来 23 字节，需要 32 字节（base64url 或 hex 两种写法都认）。
```

这是**预期行为**，不是回归 —— 那把值一直在，只是不再被放过。处置：

```bash
node tools/keys.mjs gen --force     # 换一把 32 字节的
# 手工换掉 MN_SESSION_PEPPER 那一行
node tools/keys.mjs check
```

代价：**全员重新登录**（会话 token 的 HMAC 全变）。开发库上通常无所谓
（顺手还会清掉攒下来的测试会话）；生产库上按「换密钥前必读」那节的通知流程走。

⚠ 别为了绕过它把 pepper 改短 —— 自检拦的就是这个。NIST 对 HMAC 密钥的门限是
≥112 bit，而口径取 32 字节是为了与另两把**同形**（一个生成器、一个校验器）。

### 三把互不相同，缺一把就起不来

启动期自检挂在 `instrumentation-node.ts` 的 `registerNode()` 上（排在起定时器之前），
它会验三件事：

```text
三把都在        缺任何一把 ⇒ server ready 之前 exit 1，端口不监听
形状对          AES / HMAC / pepper 都是 32 字节（43 字符 base64url 或 64 字符 hex）
三把互不相同    违反 NIST SP 800-57 Pt1 R5 §5.2 的 shall（一条 key 只做一个用途）
                ⇒ 拿到它的人一次就同时拿到「解密全部 PII」与「伪造任意会话」
```

## 换密钥前必读：三条不可逆

托管口径已裁定为「**只经 `environment:` 注入，不入库、不进镜像、不进 git**」
（依据 `docs/research-secret-storage.md`）。轮换**一期不做**，但下面三条现在
就该知道 —— 它们都不是「回滚一下就好」的形态：

| 换哪一把            | 后果                                 | 为什么不可逆                                                                                                                                     |
| ------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MN_AES_KEY`        | **全库 PII 永久不可读**              | 历史密文全部解不开。`decryptField` 抛 GCM 认证失败、**不会**静默给乱码 —— 这是好事，但它表现为「一打开当事人详情就 500」，而不是「数据慢慢变错」 |
| `MN_HMAC_KEY`       | 盲索引全变 ⇒ **同一人查不出同一人**  | `mn_party.id_number_hash` 的唯一索引（`db/schema/hosts.ts:461`）会拒收任何重复行 ⇒ 要么插不进去，要么查不出关联                                  |
| `MN_SESSION_PEPPER` | **全部会话立即失效**，所有人重新登录 | 这是**预期**行为（换 pepper 就是让旧会话作废），但要提前通知                                                                                     |

⚠ **换 pepper 必须改 env 并重启** —— `pepper()` 是模块级缓存，不重启新值不生效，
而失败是静默的（服务照常、会话照常、只是没换）。

真要轮换时，`MN_KEY_VERSION` 只做记录、**不做密钥选择** —— 所以「先把新密钥写进去、
旧密文之后再迁」这条路**现在还走不通**，得先有密钥版本簿记。NIST 对对称密钥的
cryptoperiod 建议 ≤2 年，所以这是要**提前排期**的决定，不是「想起来就换」。

**即便轮换完了，旧密钥也不能真删**：历史备份仍然需要它
（OWASP Cryptographic Storage CS：「old keys should generally be stored for a
certain period after they are retired」）。

## 密钥泄露了怎么办（本仓唯一会真正触发轮换的事件）

256-bit AES 不存在「算法失效所以必须换」的压力，NIST 的 cryptoperiod 也只是建议
（OWASP KM CS：cryptoperiod 是**风险评估的产物**，不是固定期限）。
所以本仓会真正要求你换密钥的只有一件事：**泄露**。此时按下面走，别自己即兴发挥：

```text
1. 判定哪一把
   只看到 DB 备份 / pgdata 被拷走
     ⇒ AES 与 HMAC 视为已泄露（密文与钥匙都在同一台机器上的常态）
     ⇒ pepper 视为**未**泄露：会话校验是 WHERE token_hash = ? 的等值查表，
        拿到只读备份造不出可用会话（token 是 randomBytes(32)，本就不可爆破）
   MN_SESSION_PEPPER 的值出现在任何别处 ⇒ 视为全部三把都泄露

2. 立即
   docker compose stop app
   把泄露的那几把从所有部署机与备份里移除

3. 恢复顺序（**先 pepper，后 AES**，因为 pepper 换掉最便宜且立刻堵住权限提升）
   · pepper：keys:gen 出新值 → 换 env → **重启** → 所有人重新登录（预期）
   · AES / HMAC：**没有一行安全的应急路径**。这是本仓已知的短板 ——
     要么全表重加密（一次性脚本，参照迁移 0009 的回填形状），
     要么接受这批历史 PII 已失密并按合规流程处置。
     ⚠ 换 AES 密钥本身**不能**让旧密文重新可读 —— 两件事是两件事。
   · 换完之后按上一节「旧密钥也不能真删」处理历史备份。

4. 记一笔
   OWASP KM CS：轮换事件应留痕（时间、操作人、授权来源）。
```

⚠ 第 3 步里「AES 没有一行安全的应急路径」是**如实写的**，不是留白。
`docs/research-key-rotation.md` 把两个候选（预建 keyring / 写重加密批处理）与各自的
代价都算了：本次裁定**不预建**（N7=B），理由是该文档 §3 —— 本仓的现实风险是泄露，
而泄露的正确响应是上面这份清单，不是优雅迁移。

## 跑起来

```bash
cp ../.env.example .env      # 从仓库根目录拷；deploy/ 下没有 .env.example
node ../tools/keys.mjs gen    # 三把密钥
node ../tools/keys.mjs check  # 核对
docker compose up -d --build
```

`.env` 被 `.gitignore` 的 `.env` 规则排除（`deploy/.env` 也一样，
已用 `git check-ignore -v` 核实）。`docker-compose.yml` 与 `nginx.conf` 在仓里，
**`.env` 不在**。

迁移不随 `app` 起来：`migrator` 是一次性服务，`app` 等它**成功退出**
（技术选型 §3.2c——应用副本不跑迁移，多副本抢跑的问题因此结构性消失）。
