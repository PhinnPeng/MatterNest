# deploy

反向代理与 Node 服务的最小可用配置：技术选型 §6、落地方案 **W0-5**。

| 文件                 | 是什么                                               | 谁核对              |
| -------------------- | ---------------------------------------------------- | ------------------- |
| `nginx.conf`         | TLS 终结 + 反向代理（当前只听 80，TLS 未启用，见下） | `verify-deploy.mjs` |
| `Dockerfile`         | 应用镜像（`output: "standalone"`）                   | 本票不验证构建      |
| `docker-compose.yml` | 单副本栈：postgres / minio / migrator / app / nginx  | 本票不验证起栈      |
| `verify-deploy.mjs`  | 解析 `nginx.conf` 并断言关键值                       | 它自己              |

## 怎么跑核对

```bash
node deploy/verify-deploy.mjs
```

不需要数据库、不需要 Docker、不需要构建——纯文本解析，所以它能进任何一次提交前检查。
退出码 0 = 通过，1 = 有断言失败。

> ⚠ **本票没有把它接进 `pnpm verify`。** 原因：`package.json` 不在本票的改动面内
> （多 lane 并行，改共享清单会撞车）。接线只差一行，接的时候记得连同
> 「`pnpm verify` 必须离线」这条既有约束一起看——`verify-deploy.mjs` 满足离线，
> 但 `pnpm test` 之外的部分不满足。

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
- **不拍密钥托管口径。** B7 三把密钥怎么存、证书放哪，属 **MATT-36（HITL）**。
  配置里只留占位并标清，没有自选方案。
- **不启 TLS。** 域名未定死（MATT-34）+ 证书托管未定（MATT-36）。
  `nginx.conf` 里 443 段是注释，写全了也只是"看起来能用"。
- **不验证起栈。** `docker compose up` 本票没跑过（本机 Docker daemon 未运行），
  `Dockerfile` 的构建也未跑过。compose 与 Dockerfile 是**按契约写的**，
  不是**按实测跑通的**——用之前先自己起一次。
- **不写 `worker` 服务。** MATT-35 裁定一期不引调度进程（通知泵由外部触发器驱动），
  且 `worker/` 下当前只有 README、没有实现。留一个指向不存在代码的服务比不写更糟。

## 跑起来

```bash
cp .env.example .env      # 填真实值
docker compose up -d --build
```

`.env` 被 `.gitignore` 的 `.env` 规则排除（`deploy/.env` 也一样，
已用 `git check-ignore -v` 核实）。`docker-compose.yml` 与 `nginx.conf` 在仓里，
**`.env` 不在**。

迁移不随 `app` 起来：`migrator` 是一次性服务，`app` 等它**成功退出**
（技术选型 §3.2c——应用副本不跑迁移，多副本抢跑的问题因此结构性消失）。
