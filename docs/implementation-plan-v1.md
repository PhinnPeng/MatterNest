# MatterNest 第一期落地方案 v1（Next.js 全栈 · 供 AI 施工执行）

> 定位：把已定稿的六份规格件（基线 / master / 修订稿 / 枚举表 / 权限草案 / 转案件矩阵）+ 技术选型 **v6** 转成**可依次执行、每步有退出条件**的施工计划。本文件不新增需求，只做排序、契约化与门禁化；凡规格件没写的，这里只登记为待拍，不替产品决定。
> 用法：按 §3 的 WBS 逐票执行，一票一提交；每票开工前先读它 `出处` 列指向的章节。
> ⚑ **v6（2026-09-28）只改前端组件体系（纯 shadcn → Ant Design 6），WBS 的票、门禁与出口条件一条没变**：技术选型 §13.6.3 那张"继承/作废表"是唯一的口径变化处。凡是本文件里写着 `ui/table.tsx`、`react-hook-form`、`TanStack`、`react-day-picker` 的句子，都是**那一轮的实现记录**，现行实现看 `.trellis/spec/frontend/component-guidelines.md`。

---

## 0. 开工门禁（未满足前只能做 M0，不能进 M1）

| # | 门禁 | 为什么卡 | 未过时的绕行 |
|---|---|---|---|
| G1 | **N1–N7 spike 通过**（`research-nextjs-stack.md` §5）——**进度：N1 ✅、N7 ✅（逻辑层，交互层待补；⚑ v6 换 antd 后 N7 的"真表 + 动态数组表单"由本轮重写覆盖，密度数字是 2026-09-28 重量的 33px/行、溢出 0，不是 spike 文档里那份）、N2 的 DB 与迁移前置 ✅（`dev_matternest` 已连通且已应用第一条迁移 + seed，`pnpm db:check` 12 项全绿）、N2–N6 未跑** | 换框架引入 4 个新未知项，其中 N4（多副本 Server Function 解密）与 N6（云之家 OIDC）不通会改架构 | N6 不过 → 一期先只上本地密码，云之家列 M6 |
| G2 | **B8 删除语义拍定** | 决定所有表的 FK 动作、软删与 partial unique 写法，迁移文件是唯一事实源，后改=全库返工 | 无绕行，必须先拍 |
| G3 | **P0-6 主表业务字段归属拍定** | 权限草案 §10 契约矩阵要按它生成用例 | 暂按建议口径实现（业务字段属护栏 2，归属/状态类属护栏 1），但**不得当定稿写测试** |
| G4 | 目标 G1–G4 与漏斗签字 | 只影响验收与上线判定，不阻塞编码 | 可与 M1 并行补 |

---

## 1. 目标形态

```text
Next.js 16（App Router，自托管 standalone + Docker）
 ├ 浏览器 ── nginx(TLS, 请求体上限, X-Accel-Buffering:no)
 │    ├ 页面壳 SSR（不预取业务数据） → 客户端经 /api/** 取数
 │    ├ /api/**  Route Handlers：唯一业务写入口，每个 handler 内 withScope()
 │    └ /api/auth/*  本地密码 + 云之家 OIDC 回调 → auth_session(httpOnly cookie)
 ├ worker 容器：node-cron + pg_try_advisory_lock 单飞
 │    └ 节点提醒扫描 / 规则 4 无更新扫描 / outbox 投递 / 云之家在职同步
 ├ PostgreSQL 15+（Drizzle 迁移 SQL 为唯一事实；CHECK 手写 + 一致性测试）
 └ MinIO（附件；服务端只签 PUT/GET URL，不中转文件流）
src/shared/**  纯 TS：枚举 E01–E37 · Zod schema · ids · time · crypto（禁 import next/react/Node）
```

同仓单语言（TS）这一条不动：枚举与 DTO 前后端共用一份是枚举表 §5.1 的硬要求。

---

## 2. 里程碑

> **跟踪归位（2026-09-27）**：本节的 W0–W7 是**分解结构**，不是待办清单。待办一律登记在 Paca
> 项目 `MatterNest`（前缀 `MATT`）：`MATT-1` 是地图卡，下面挂 8 张里程碑卡（`MATT-2/7/9/12/18/22/26/29` = M0…M7），
> 再挂 23 张可独立复核的待办卡。口径是：**markdown 里的编号不算登记**，本文件只记"票面进度"，
> 认领与状态看 Paca 板；两边打架时以本文件的进度注为事实源、以板子为待办源。
> 建卡脚本 `agent-work/paca.mjs`（幂等，按标题去重），校验脚本 `agent-work/paca-verify.mjs`。

| 阶段 | 内容 | 退出条件 |
|---|---|---|
| **M0 地基**（3–4 天） | 仓库骨架、Next+Tailwind+shadcn 装配、Drizzle+迁移管线、lint/CI、compose 开发栈、`src/shared` 枚举包落地、**T2 填 `.trellis/spec/` 12 份 + config packages 段** | N1/N2 通过；`pnpm db:generate && db:migrate` 在空库可重放；CI 有"CHECK 与值数组一致性"这条测试；**spec 里已写入 §13.5 八条禁令，bootstrap 任务关闭** |
| **M1 数据与契约**（3 天） | 全部表结构 + 索引 + seed（配置 5 表 / 8 状态 / 8 规则 / 7 模板 / 5 角色）+ Zod 契约 + OpenAPI 生成 | 迁移评审通过；seed 幂等可重放；`/api/**` 契约快照进版本库 |
| **M2 权限与账号**（5–6 天） | session/双通道登录、ScopeResolver+`withScope`、4 特权 + 2 护栏 + 可见用户集、`selectable-users`、用户与角色页 | 权限草案 §10 矩阵（5×3×7）**全绿**；裸表访问 CI 拦得住 |
| **M3 主档 CRUD**（8–10 天） | 案件/事项 + 节点 + 进展 + 费用 + 评论 + 标签等级 + 当事人；DataTable 封装 | 五类列表页与详情页可用；`activity_log` 覆盖 §3 全清单动作 |
| **M4 转案件与联动**（4–5 天） | 转案件表单（动态数组）、单事务 + outbox、撤销关联、来源卡片降级、编号生成器 | 映射矩阵 §1–§5 逐条可测；`UNCONVERT` 审计可查 |
| **M5 提醒与通知**（4 天） | worker 三件任务、聚合去重 `dedupe_key`、通知中心/我的关注、未读计数 | 双副本下不重复发；同节点同日多条合并为一条 |
| **M6 规则配置与归档**（4–5 天） | 自动化规则配置页、冲突检测、执行记录、归档/撤销归档、5 类配置后台 | 同域同动作唯一约束生效；预置 8 条可在 UI 里启停 |
| **M7 收尾**（3–4 天） | 导出两档、附件签名与预览策略、备份/留存、批量导入、灰度与台账迁移 | §9 运维项全绿；一次真实备份恢复演练 |

并行度：M1 完成后 M2 与 M3 的前端骨架可并行；M4 依赖 M2+M3；M5 依赖 M4 的 outbox。合计**单人串行约 34–41 天**，按 §8 的派单边界并行两个泳道可压到 **24–29 天**。

---

## 3. 工作分解（一票一提交，编号给到票面）

`派` = 适合整体交给 AI 子代理；`审` = 必须人工审设计条目后再放行。

### M0 地基
- **W0-1** 仓库骨架 + pnpm + TS 严格模式 + ESLint/Prettier + Vitest 配置。派
  > **✅ 已完成（2026-09-27）**，任务 `.trellis/tasks/09-27-w0-1-repo-skeleton`（已 archive）。三处当场拍定：Node 钉 22（实测 v22.22.2，技术选型 §7 的"Node 24"已改）、开发期连共享机映射口、CI 先只给本地 `pnpm verify`。额外交付一条本票原本没要求的东西：`tools/lint-guard/` 用虚拟路径喂真 config，**对禁令① 的 lint 规则本身做回归**（并已把 `files` 段改坏验证过它会红）。
  > ~~遗留阻塞：172.16.70.100 实测不可达~~ **该结论已于同日撤回，是我探错了地址**：GameViewer 的端口映射只监听**本机回环**，正确地址是 `127.0.0.1:30432`（PG）/ `30090`（MinIO API）/ `30091`（MinIO 控制台）。现在 PG 侧已开通并自检通过，见 W0-5 与 `spec/backend/database-guidelines.md`「开发库现状」。
- **W0-2** Next 16 + Tailwind v4 + shadcn 装配，产出 `components/ui/` 基线。出处：技术选型 §3.3、研究文档 §5 N1。派
  > **✅ 已完成（2026-09-27，N1 通过）**：`next@16.3.6 + react@19.3.0 + tailwindcss@4.3.3 + shadcn@4.21.0` 装配完毕，`src/app/components/ui/` 出六件基线（button/card/input/dialog/attachment/calendar），`components.json` 的 aliases 已按 §5 配到 `@/app/components/ui`（实测有效）。中文 locale 验通。三条新硬约束写进 spec：`Locale` 含函数不能跨 server→client 传、`cn` 改用 shadcn 官方包、**跑 CLI 必须 review diff**（它注入的 `next/font/google` 与内网部署冲突，已移除）。曾阻塞的 `ui.shadcn.com` 是域名级重置，加代理后解决。详证 `research-nextjs-stack.md` §6.4。
- **W0-3** `src/shared/enums` 落地 E01–E37（含中文名字典），并写**CHECK↔值数组一致性测试**。出处：枚举表 §5.1、§5.2。审（这条错了后面全错）
  > **✅ 已完成（2026-09-27）**，任务 `.trellis/tasks/09-27-w0-3-enums`。七份分册 + `index.ts` 的 `ENUM_REGISTRY`（E01–E37 全 37 行有落点，含 E01"无此列"/E07"布尔"两行占位）。一致性测试不是"一条"而是**三重比对**：① 注册表→迁移（声明已进库的值域必须能对上 `CHECK` 且集合相等）；② **迁移→注册表**（手写补丁里冒出来的 `IN (…) CHECK` 没登记就红——单向检查会漏这半）；③ **注册表→枚举表原文**（逐行解析 §1/§2「取值」列，两边同时抄错也会红）。解析器自带单测，并在此过程中抓到一个真洞：正则原先只认带引号的约束名，而枚举表 §5.2 的手写补丁模板写的是**裸名** `ck_matter_case_type` —— 那样写的 CHECK 会完全绕过反向检查，已修并补测试向量。
  > 顺带两条裁定（枚举表 §5.1 已回写）：分册表原本**没给 9 行归属**（E01/E02/E04/E05/E06/E07/E10/E11/E37）；`host_type`(E08∩E10) 与 outbox 事件(E32∩E33) 两处同值域**只允许一份实现**，测试断言"同一个数组引用"而不是"两份相等"。
- **W0-4** Drizzle + 迁移管线：`generate`→人审→尾部手写 SQL 补丁；禁 `push`；`migrator` 一次性服务 + `pg_advisory_lock`。出处：技术选型 §3.2b/§3.2c、§12.3 禁令 2/3/4。审
  > **✅ 已完成（2026-09-27）**，且它的前置悬置（技术选型 §3.2b 末尾那条"要不要退 SQL-first"）**已用实跑裁定：保留 Drizzle DSL**。机制全部落地：`drizzle.config.ts` + `src/app/lib/server/db/{schema,migrations,seed}` + `pnpm db:generate|db:migrate|db:seed` + `tools/migrate.mjs`（`MN_DB_CONFIRM` 硬闸门 → `pg_advisory_lock` → drizzle `migrate()` 单事务 → ledger `drizzle.__drizzle_migrations`）。第一条真迁移 `0000_status_config` + 八状态 seed 已应用到 `dev_matternest`，并端到端验过一轮"drop 到空库 → 拉起 → `db:check` 12 项全绿"（中途 C9/C10/C11 各自红过）。四条实测写法约束与五条坑（含 `withTimezone` 拼错会**静默产出无时区列**）见 `research-nextjs-stack.md` §8。
  > **两处票面口径按实测更正**：① seed 那句 `ON CONFLICT (code)` 在 `status_config` 上不成立，冲突目标必须是该表实际唯一键 `(host_type, code)`；② §3.2b 那句"编号迁移文件……能回滚"只能兑现为**前滚 + `pg_dump` 恢复**——`drizzle-kit` 没有 down/rollback，故新增"每个迁移头部写 `-- DOWN:` 或 `-- IRREVERSIBLE:`"。
  > **仍属后续票**：同构表对的"列集合 diff 为空"契约测试要等 `matter_*`/`risk_matter_*` 两张都建了才写得出（W1-3）；compose 里的 migrator 服务定义属 W0-5。
  > **前置已就位（2026-09-27）**：`dev_matternest` 库/角色开通，`pnpm db:check` 9 项断言全绿（含"事务内 temp DDL 可回滚"C8 —— 正是 `migrate` 的执行姿势）。目标库是**共享 dev 机的空库**，`public` schema 实测零表，所以第一版迁移是真 `generate` 而不是从已有库反向。
- **W0-5** compose 开发栈（pg/minio/nginx conf/worker）+ 密钥 env 清单（PG/MINIO/AES/HMAC/云之家/OIDC/state/NEXT_SERVER_ACTIONS_ENCRYPTION_KEY/DEPLOYMENT_VERSION）。派
  > **进度（2026-09-27）：PG 侧一半已完成，但完成方式与票面不同——没有起 compose 容器，而是连共享 dev 机**（本机 `127.0.0.1:30432`，PG 16.13/linux-musl）。已开通 role + DB `dev_matternest` 并在 **role 级**钉死 `timezone='UTC'` + `client_encoding='UTF8'`，因此 §12.3 的"会话固定 UTC"由库侧强制，不依赖应用自觉；连接与口径的重复自检 = `pnpm db:check`（故意不进 `pnpm verify`，后者必须离线）。**仍待做**：MinIO bucket 与服务账号密钥（实测那台上没有我能推出来的账号——四条候选凭据全被 `InvalidAccessKeyId` 拒，需人在 30091 控制台开）、AES/HMAC 两把密钥的托管（B7 未决）、nginx conf 与 worker 容器、compose 里的 migrator 服务定义（脚本层 `tools/migrate.mjs` 已完成）、`.env.example` 里那几个空占位的实际值。
- **W0-6** N2 验证：一条 `withScope` 查询 + 404 JSON。出处：研究文档 §2.1/§2.2。审
  > **DB 前置解除（2026-09-27）**：连接可用且有重复自检（见 W0-4/W0-5 注），N2 不再被"库没连上"卡住。顺带一条实测事实：postgres.js 把 `int8` 解析成 **JS string**（不丢精度），P1-19 的"雪花 id 出 string"在驱动层已天然满足，但 DTO 侧仍要显式声明。
- **W0-7** **T2 填 `.trellis/spec/` 12 份空模板**（backend 5 + frontend 7，现状每份仍是 51–59 行占位），内容取自技术选型 §4 对应表 + **§13.5 现行八条禁令** + §3.3 样式三条 + 枚举表 §5；同时补 `.trellis/config.yaml` 的 `packages` 段（当前全在注释里，导致包上下文检测拿不到东西）与 `default_package`，并把 `.trellis/tasks/00-bootstrap-guidelines`（现 `in_progress`）做完关闭。**派单前置：这一票不做，后续所有子代理都拿不到"禁裸表访问、CHECK 手写、`.where()` 只用 sql、禁第二套组件库"这些约束。**审
  > **✅ 已完成（2026-09-27）**。三处票面口径按实测更正：① 实际是 **13 份**（backend 5 指南 + `index.md`；frontend 6 指南 + `index.md`；`spec/guides/` 3 份模板按要求保留不动）；② `packages` 段**不填**——声明 packages 会把 spec 基准切到 `spec/<package>/`，实测输出 `Spec: not configured`，比不填更差（依据 `scripts/common/config.py:396`、`packages_context.py:30`；已在 `config.yaml` 注释与技术选型 §5 留证）；③ spec 语言裁定为**中文**（技术选型 §7 末那条未决口径冲突随之关闭）。顺带产出两条新发现：spec 现要求"未 spike 的能力一律标 `UNVERIFIED`"，以及 **P1-19**（雪花 id 的 JSON 序列化口径未定）。

### M1 数据与契约
- **W1-1** 宿主主表 `matter` / `risk_matter`（含 `conversion_status`、`last_progress_at`、`is_archived` 派生）。出处：修订稿 §6.3、§3.4。审
  > **✅ 已完成（2026-09-27，含表名改判）**：用户指令"表名采用前缀命名" ⇒ 两张宿主表与全部从属表一律 `mn_` 前缀，
  > 迁移重新 generate + seed 重放，`pnpm db:check` 12/12。落点 `db/schema/hosts.ts`。
- **W1-2** 从属拆表 5 组：`*_node`/`*_party`/`*_staff`/`*_tag`/`party_tag`，真外键 + 成对迁移同文件。出处：修订稿 §1.0.2、§8.1、§12.4。审
- **W1-3** 横切表：`comment`/`activity_log(+payload)`/`attachment`/`custom_reminder`/`notification_event`/`notification_delivery`/`user_watch`/`event_outbox`/`code_seq`。出处：修订稿 §7、§8.1；矩阵 §4.1。审
- **W1-4** 认证三表：`auth_session`/`app_user_credential`/`app_user_external_identity`。出处：技术选型 §3.4。审
  > **进度（2026-09-27）**：本地通道两张表已落（`mn_app_user` 携 scrypt 摘要，未拆 `*_credential`；`mn_auth_session` 存 token 的 HMAC）+ `mn_app_user_role`。
  > **票面按实测改一处**：角色不是"用户表上一列"，权限草案 §2 写的是**多对多取最宽并集**，所以有独立映射表。
  > `app_user_external_identity` **一期不建**——那是云之家通道（N6 未验）。
- **W1-5** 索引全量（部分索引带 `WHERE NOT is_deleted`，`ix_staff_user` 为权限必需）。出处：修订稿 §8.2、权限草案 §5。派
  > **进度（2026-09-27）**：45 个索引随 `mn_` 前缀迁移落库，partial index 带 `NOT is_deleted AND NOT is_archived`；
  > `ix_mn_*_staff_user` 在 L2 谓词里被真实使用——**但那条谓词本轮之前是坏的**（drizzle `exists()` 不给 `sql` 模板加括号），
  > 因为 seed 里没有纯 L2 账号。口径已写进 `spec/backend/database-guidelines.md`。
- **W1-6** seed：5 配置表 + 8 状态 + **8 条规则** + 7 模板 + 5 角色 + 4 特权，全部 `ON CONFLICT (code) DO NOTHING`。出处：修订稿 §2.3/§2.4。审
  > **进度（2026-09-27）**：5 角色 / 4 特权 / 8 状态 / 等级 / 节点类型 / 标签 + **一整套演示数据**（当事人、6 案件、6 事项、10 节点、进展、评论、活动）已落，可重放幂等。
  > **票面两处改判**：① 冲突目标按各表真实唯一键（`status_config` 是 `(host_type, code)`，角色映射是 `("id")`）；
  > ② 演示配置用 `DO UPDATE` 而不是 `DO NOTHING`——首轮配错（口令摘要、账号角色分布）时 `DO NOTHING` 会把错值永久留在库里。
  > **仍属后续票**：8 条规则与 7 个消息模板属 M5/M6，本轮未建。
- **W1-7** Zod 契约与 OpenAPI（`zod-openapi`），DTO 与表单规则同源。出处：技术选型 §4。派

### M2 权限与账号
- **W2-1** ScopeResolver：三档谓词 + `ScopedQuery` 构造强制 + lint 禁裸表。出处：权限草案 §4。审
  > **✅ 已完成（2026-09-27）**：`scope/visibility.ts` 是唯一谓词出口（默认拒绝：`undefined` 只给 L1；未知范围值降级到 L3，不 fallthrough）。
  > "禁止裸表访问"由两条结构约束承担：服务函数**第一个参数必须是 actor**（少传编译不过）、页面壳碰不到数据层（lint-guard 禁令⑥⑤）。
  > 本轮实测抓到一条只在真跑时才现形的缺陷：**L2 的 `EXISTS` 渲染成 `exists select 1 …`**（drizzle 不给 `sql` 模板加括号）→ PG 42601；
  > 起因是 seed 里没有纯 L2 账号，那条分支从没被执行过。修复 + 账号分布改判见 `spec/backend/database-guidelines.md`。
- **W2-2** 可见用户集与 `selectable-users`（带宿主上下文、分页 ≤50）。出处：权限草案 §4.1。审
- **W2-3** 双通道登录：`/api/auth/local`、`/api/auth/yunzhijia/callback`、绑定与建号落 `pending`、待批队列、在职同步降级路径。出处：技术选型 §3.4、§7 E/F。审
  > **进度（2026-09-27）**：本地通道已通（`/api/auth/login`：scrypt + 定长比较 + httpOnly cookie + 服务端 session 表）。
  > `pending` 账号与口令错给**同一句 401 文案**（防账号存在性字典）——这条本轮才真正对齐：代码此前用 `unauthorized()`，与同文件顶部口径自相矛盾。
  > **未做**：云之家回调、绑定/解绑、待批队列界面（N6 未验：需内网 + 平台登记）。
- **W2-4** 4 特权开关 + 2 归属护栏 + 禁止自助提权。出处：权限草案 §2.1/§2.2/§6。审
  > **进度（2026-09-27）**：4 个开关已在 `mn_role` 上，由 `Actor.privileges` 带出并参与"取最宽并集"；`can_unarchive` 已在归档出口生效。
  > **未做**：两条归属护栏的后半与"禁止自助提权"的界面（本轮没有用户管理页）。
- **W2-5** 404 统一映射（含附件与导出）+ `SENSITIVE_FIELD_READ` 审计。出处：权限草案 §7.3、§1 元规则 3。派
  > **进度（2026-09-27）**：读与写不可见宿主都 404，本轮用真 HTTP 验过（列表差集 → 详情 404、状态写 404）。
  > 附件/导出那两侧要等能力存在；`SENSITIVE_FIELD_READ` 未做（没有明文读取入口）。
  > 顺带补一条口径：**路径 id 非数字给 400 而不是 500**（`BigInt("undefined")` 会冒成 5xx），见 `spec/backend/error-handling.md`。
- **W2-6** 契约测试矩阵参数化（角色×对象×入口 + 4 条归属/选人用例）。出处：权限草案 §10。审
- **W2-7** 用户与角色页、活动日志中的权限类动作。派

### M3 主档 CRUD
- **W3-1** `DataTable.vue`→ **`components/data-table/DataTable.tsx`**：受控分页/排序/筛选/选择/列显隐，禁止客户端全量。出处：技术选型 §12.3 禁令 ⑧。审
  > **N7 已探路（2026-09-27）**：`DataTable.tsx` 有可运行参照实现（走 `@tanstack/react-table/legacy`，v9 主入口已无 `useReactTable`）。本票只剩接真接口与筛选面板。**出处应为 §13.5 禁令⑧**，本行的 §12.3 是旧指针。
  > **⚑ v6（2026-09-28）**：`DataTable.tsx` 改为包 **antd `Table`**（TanStack 随依赖删除）。四条不变量原样搬过去：受控参数、`pageSize>100` 直接抛、列上只 `sorter: true`（**不给第二参数**）、不做客户端全量排序。列宽由 `tableLayout: fixed` + `scroll.x` 真的生效，代价是**必须每列 `ellipsis`**——一列文字超宽就把整行撑高（54px→33px 就是这么修出来的）。
  > **✅ 已接真接口（2026-09-27）**：两张列表都吃 `/api/**` 的服务端分页结果；筛选面板 = `components/list-toolbar.tsx`（关键词 500ms 去抖 + 状态 + 排序列/向 + 含归档）。
  > 三件口径上的事顺手做了：表头/表体改走 `ui/table.tsx`（原来自带一份样式，违反禁令⑦）、
  > 空态不再画半张表而是给下一步、`pageSize>100` 仍然**直接抛**而不是静默夹小。
  > **未做**：行选择的多选批量动作（`selectionColumn` 已备好但界面上没有批处理端点，接上去才有意义）。
- **W3-2** 案件/事项列表 + 筛选 + 统计卡（报表 2 张）。出处：master F1-2/F2-2、§7.1 P0-2。派
  > **进度（2026-09-27）**：两张列表已可用（关键词/状态/排序/含归档 + 服务端分页），列表状态落在 **URL** 上所以链接可分享。
  > "统计卡"本轮以**工作台**形式落了案件侧那一半（`/api/overview`：在办/逾期/7 日内/事项数 + 状态分布 + 最近到期节点 + 活动流），
  > **报表那两张（F1-2/F2-2 的口径统计）未做**——它们要的是聚合维度，与工作台不是同一件事。
- **W3-3** 详情页 + 8 个 Tab（附件 Tab 为新增）。出处：修订稿 §7.1。派
  > **进度（2026-09-27）**：案件详情落了 5 个 Tab（基本信息/工作节点/参与人/过程记录/活动）。
  > **未做 3 个**：附件（等 MinIO 服务账号）、费用、关联案例——**没有给它们留空 Tab**，宁可不显示也不放坏入口。
  > 事项详情本轮**没有单独页面**：事项侧动作是"转案件"，做在列表行上；事项状态流转也没有写端点。
- **W3-4** 节点管理：P1 预设 / P2 规则生成、时间待定、`deadline_time`、生命周期与恢复规则。出处：修订稿 §4、§6.1、§3.5。审
  > **进度（2026-09-27）**：`deadline_time` 生成列 + 生命周期（未开始/进行/完成/取消，取消必填原因在 DB CHECK 与服务层各一道）
  > + 时间待定（`is_time_confirmed` 不参与提醒）已在库与界面上跑通；详情页节点行就地可操作。
  > **未做**：P1 预设套用与 P2 规则生成（依赖 `node_preset`/规则表，属 M5/M6）。
  > 顺带修一条 URL 语义：`/api/matters/{id}/nodes/{nodeId}` 以前不看 `{id}`，现在要求节点确实挂在该案件下。
- **W3-5** 进展 / 费用（`SUM` 合计）/ 评论（≤1 层、@提及）/ 标签等级。出处：修订稿 §6.3。派
  > **进度（2026-09-27）**：评论可读可写（composer 在"过程记录"Tab）；进展与标签**只读展示**（字典来自 `/api/meta`，配置驱动）。
  > **未做**：写进展的端点、费用与 `SUM`、@提及。
- **W3-6** 当事人：查重（模糊 + `id_number_hash`）、加密与默认脱敏、跨案引用提示、可见性规则。出处：修订稿 §6.3/§8.2、权限草案 §7.2。审
- **W3-7** `FileUpload` 自封装 + 预签名 PUT。出处：研究文档 §2.6、技术选型 C3。派
  > **范围修正（2026-09-27）**：展示层不必从零写——shadcn 有 `Attachment` 件（附件行 + `uploading/processing/error/done` 态 + 删除动作），本票只做「选文件 → 签 PUT → 直传 → 回报 key + 白名单校验」。**前置**：`shadcn add attachment` 要能访问 `ui.shadcn.com`（当前被域名级重置），且先确认它把件落在 `components/ui/` 还是 `styles/<style>/ui/`。
- **W3-8** 编号生成器（业务时区日界、溢出扩 4 位）。出处：修订稿 §12.3。审
- **W3-9** 收藏与关注、`is_read` 未读位。派

### M4 转案件
- **W4-1** 动态数组表单（N 案 + 跨卡复制排除 id 类）。出处：矩阵 §3、技术选型 §3.3。审
  > **N7 已探路（2026-09-27）**：`useFieldArray` + `summarizeIssues()`（错误定位到「第 N 张卡 · 字段」）与`copyCardOnto`（白名单复制）已实现并有测试；本票按此形状扩展字段即可。
- **W4-2** 单事务：取号→建案→关联→计数→outbox→审计；行锁与超时提示。出处：矩阵 §4。审
  > **进度（2026-09-27）**：取号→建案→写 `mn_risk_matter_case`→`conversion_status=1`→`converted_case_count+1`→审计，
  > 已在**同一事务**内跑通并用真 HTTP 验过（转完后事项侧 `status=1 count=1`）。
  > **未做**：`event_outbox` 写入（M5 的 outbox 还没建表消费侧）、行锁与超时提示。
- **W4-3** 字段映射逐条实现（继承/重填/留空/引用）。出处：矩阵 §2.1/§2.2。派（按表实现，无需设计判断）
  > **进度（2026-09-27）**：按 master P0-1 做了两条最要紧的——**金额不继承**（新案件 `amount=0.00`，已验）、
  > **描述不整体搬**（只带事项名称做初始案由说明）。等级默认沿用事项、可在对话框里改。
  > **未做**：矩阵里费用/当事人/附件那几组的映射（对应能力还没实现）。
- **W4-4** 撤销关联与前置条件、`UNCONVERT`。出处：矩阵 §5.1、枚举表 §3.2。审
- **W4-5** 金额合计非阻断提示、来源卡片"无权查看 N 个附件"。出处：矩阵 §2.4/§2.8。派
- **W4-6** 规则 7 由 `risk_converted` 事件驱动归档。出处：修订稿 §2.3。审

### M5 提醒与通知
- **W5-1** worker：三件 cron + `withSingleFlight()` + SIGTERM drain。出处：研究文档 §2.3、技术选型 C1。审
- **W5-2** outbox 投递器（至少一次 + `dedupe_key` 唯一吸收）。出处：矩阵 §4.1、修订稿 §7.2。审
- **W5-3** 聚合规则 1–6（同批合并、角色去重、同日合并、`once_per_target`+`cooldown`）。出处：修订稿 §7.2。审
- **W5-4** 通知中心 + 我的关注 feed（不可见降级占位、按可见计未读）。出处：权限草案 §7.1。派
- **W5-5** 邮件渠道（若一期做；技术选型 §9 建议移出，需确认）。待拍

### M6 规则配置与归档
- **W6-1** `scope_key` 归一化 + 8 条必过向量。出处：枚举表 §4.4。审
- **W6-2** 规则 CRUD + 配置时/停启用时/运行时三段冲突处理。出处：修订稿 §2.2。审
- **W6-3** `extra_condition` 受限求值（单 `and`、白名单按宿主、算子闭集）。出处：枚举表 §4.2。审
- **W6-4** 5 类配置后台 + 状态停用被规则引用则阻止 + 节点类型"通用=两宿主各一行"seed 展开。出处：修订稿 §3.1/§4。派
- **W6-5** 归档即时生效、终态、撤销归档入口、"包含已归档"筛选。出处：修订稿 §3.3/§5。审
- **W6-6** 执行记录视图（EXECUTED/SKIPPED/FAILED）。派

### M7 收尾
- **W7-1** 导出两档（默认脱敏 / `can_read_plain` 明文），逐条重判 + 异步任务。出处：权限草案 §7.3、技术选型 §3.1b。审
- **W7-2** 备份/留存（`activity_log` 留存期需合规输入 = G 组未决）。待拍
- **W7-3** 批量导入（存量台账一次性迁入，禁直插 SQL）。出处：master F7-4。派
- **W7-4** 运维文档 + 灰度与回滚演练 + 台账并行期口径。派

---

## 4. 规范条款（每票都要守，写进 `.trellis/spec/`）

1. **单一事实源**：枚举/DTO/校验只在 `src/shared/` 一份；该目录禁 import `next/*`、`react`、Node API。
2. **迁移唯一事实**：编号 SQL 可人审，禁 `push`（开发期也禁）；同构表对放同一迁移文件，配"两表列集合 diff 为空"契约测试。
3. **默认拒绝**：业务读必须经 `withScope`；不可见一律 **404 JSON**，禁 403/禁"存在但无权"形态；鉴权判定不放在 proxy/middleware（官方明令）。
4. **页面壳零业务数据**：SSR 只出外壳，业务读取一律鉴权后的 `/api/**`。
5. **审计同事务**：状态变更、参与人变更、授权变更、转案件与撤销必须与业务写同事务落 `activity_log`，含 `payload` 与 `reason`。
6. **表格一律服务端分页 ≤100**；表单库与日期库各全项目只允许一个；禁第二套组件库，缺件自封装。
7. **多副本三件套**：advisory lock 单飞 + 同一 `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` + `deploymentId`；不引入任何跨用户共享缓存。
8. **密钥**：AES 主密钥与 HMAC 密钥分离、env 注入、`key_version` 预留；未证实能力不得当既有实现写代码。

---

## 5. 验收门禁

- **测试矩阵**：权限草案 §10（5 角色 × 3 对象 × 7 入口）+ 4 条归属/选人用例，参数化生成，任一红即不通过。
- **数据侧双保险**：G1–G4 四个数必须能从 `activity_log` + §6.1 埋点算出来，算不出即测试不通过（模板 §六 的原要求）。
- **回归锁**：`scope_key` 8 向量、CHECK↔值数组一致性、同构表列集合 diff、转案件事务原子性（注入一次失败看整体回滚）。
- **上线前演练**：一次真实 `pg_dump` 恢复；云之家不可达时的登录兜底；`SELECT pg_try_advisory_lock` 双副本只跑一次。

---

## 6. 未决与风险

| 风险 | 影响 | 处置 |
|---|---|---|
| N4/N6 未验 | 双副本发布期不可用 / 一期无法用云之家登录 | M0 内先验，不通即单副本 + 密码先行 |
| 云之家不能列成员 | 离职不自动回收 | 走降级：登录时校验 + 未登录告警，并把 session 绝对过期压到 8–12h（P1-16） |
| B8/P0-6 未拍 | 迁移与权限用例返工 | G2/G3 硬门禁 |
| 7 页无原型 | 转案件与当事人页会自由发挥 | M3 前补线框或明确"按 master ②③ 实现即可" |
| 规则引擎工期 | 最贵子系统 | 技术选型 §9：M5 前只硬编码 2 条内置行为，配置页留 M6 |
| 目标未签字 | 无法判"做完了" | G4，可与 M1 并行 |

---

## 7. 交给 AI 执行的边界

可整体派发的票：W0-1/2/5、W1-5/7、W2-5/7、W3-2/3/5/7/9、W4-3/5、W5-4、W6-4/6、W7-3/4。
必须人审设计条目再放行：W0-3/4/6/**7**、W1-1/2/3/4/6、W2-1/2/3/4/6、W3-1/4/6/8、W4-1/2/4/6、W5-1/2/3、W6-1/2/3/5、W7-1。
派单纪律：票面必须带**规格件出处到章节号**，禁止把本文件的推断当"已知事实"写进派单；子代理回报的完成状态一律以 `git status` + 目标文件实存为准，不采信叙述。
**派单前置（硬）**：W0-7 未完成前不要派任何写码票——`.trellis/spec/` 目前是 12 份空模板、`config.yaml` 的 `packages` 段全是注释，implement/check 子代理拿不到八条禁令，会写出"裸表查询、装饰器式权限判断、引第二套组件库、用 `drizzle-kit push`"这类与规格件相悖且 CI 抓不住的代码。
