# Quality Guidelines

> 收工判据与禁止项。**这一页是 `trellis-check` 的对照表**，也是派单票面必须引用的约束清单。
> 来源：`docs/tech-stack-decision.md` §13.5（现行八条禁令 + 两条部署级）、§13.3、§12.4；`docs/implementation-plan-v1.md` §4（八条规范）、§5（验收门禁）、§0（门禁）、§7（派单边界）。

---

## 现行八条禁令（逐字取自技术选型 §13.5；**不要抄 §12.3 的 v4 版**）

1. **`src/shared/**` 只放纯 TS**：不得 import `next/*`、`react`、Node API——它同时被客户端与服务端引用，污染了就会把服务端代码带进前端 bundle，CI 必须拦得住。
2. **Drizzle partial index 的 `.where()` 只用 `sql` 模板，禁用 `eq()/and()`**（0.45.3 实测生成非法 `$1`，open issue #4790）；锁 `drizzle-orm`/`drizzle-kit` 精确版本，升级时复验。
3. **生成列写法**：`generatedAlwaysAs(sql\`…\`)` 或回调形式，**pg 侧没有 `.stored()`**；PG 只有 STORED，生成列不可进 PK/FK/unique、不可引用其他生成列。
4. **schema 演进只用 `generate` + `migrate`，开发期也不用 `push`**：`push` 检测不到已有索引 `.where()`/表达式变化，而软删 partial unique 是权限模型骨架，用 push 会出现"代码改了、库没改、CI 还绿"的静默漂移。
5. **业务读写一律 `/api/**` Route Handler**，且**鉴权必须在每个 handler 内部 `withScope()`**——Next 官方明令不得只依赖 proxy/middleware（matcher 排除路径会连带跳过该路径上的 Server Function）。Server Function 只做编排，不承载第二套权限判断。返回体一律 JSON，不可见资源 **404**。
6. **页面壳不得预取业务数据**：SSR 只出外壳与静态文案，一切业务读取发生在鉴权后的 `/api/**`。否则行级数据范围被页面壳绕开。（替代原"整站 SPA"那条。）
7. **前端只允许一套组件体系：shadcn + Tailwind。** 禁止为单个控件引入第二套带样式的库（MUI / AntD / Chakra 等）；清单里没有的件一律自封装进 `components/ui/`。业务组件不得直接 import 原语包（Radix UI），必须经 `components/ui/` 那层，将来换原语只改一层。
8. **表格一律经 `components/ui/data-table/DataTable.tsx` 封装并强制服务端分页/排序/筛选**（每页上限 100）——理由不是性能而是权限：客户端全量拉取再本地筛等于绕过 `ScopeResolver`（权限草案 §4）。表单库**只用 react-hook-form + Zod resolver**（与 `shared/schema` 同源），日期库全项目只允许一个；组件内不得自带第二套校验规则。

外加两条部署级：**(a)** 多副本必须共配 `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` 与 `deploymentId`，且不使用 `'use cache'`/跨实例共享缓存；**(b)** worker 与 app 都要处理 SIGTERM，留 10–30s drain，outbox 投递不得在关闭时被掐断。

**落点分布**：① 在 [Directory Structure](./directory-structure.md)（依赖方向）；②–④ 在 [Database Guidelines](./database-guidelines.md)；⑤ 在 [Error Handling](./error-handling.md)；⑥⑦⑧ 在前端目录（该三份为**摘编**，全文以本节为准）；(a)(b) 在 `deploy/` 与 `worker/`。

---

## CI 必须拦得住的东西（人工审不算拦）

| 检查 | 判据 |
|---|---|
| 裸表访问 | 宿主表读取未经 `ScopedQuery` 构造 → 失败（权限草案 §4 防漏机制 1：仓储基类断言 + lint） |
| `shared/` 污染 | `src/shared/**` 出现 `next/*`/`react`/`node:*` import → 失败 |
| CHECK↔值数组一致性 | 迁移 SQL 的 `CHECK` 取值与 `src/shared/enums` 值数组集合比较，不等 → 失败 |
| 同构表列集合 diff | `matter_*` 与 `risk_matter_*` 列集合差异非空 → 失败 |
| `scope_key` 归一化 | 枚举表 §4.4 的 8 条必过向量逐条断言 |
| 转案件原子性 | 注入一次失败，整体回滚（矩阵 §4） |
| 鉴权漏挂 | `/api/**` handler 无 `withScope()`（或显式白名单：配置 5 表、登录入口） → 失败 |
| lint / typecheck / test | `pnpm lint && pnpm typecheck && pnpm test` 全绿 |

---

## 验收门禁（什么时候算"做完"）

- **权限矩阵**：权限草案 §10（5 角色 × 3 对象 × 7 入口）+ 4 条归属/选人用例，参数化生成，**任一红即不通过**（落地方案 §5）。
- **判定"是否达标"要用规格件自带的验收章节**，不要用"我以为还差什么"的清单——半实现与"不可测的验收基准"最容易被漏掉。
- **上线前演练**：一次真实 `pg_dump` 恢复；云之家不可达时的本地密码兜底登录；双副本下 `pg_try_advisory_lock` 只跑一次（落地方案 §5）。
- 上线判据按技术选型 §9 的 P0 集合：**主流程不闭合就不算上线**，模块完整度不是判据。

---

## 未证实项纪律（本项目最重要的一条）

未跑 spike 或未从官方域名核到的能力，**不得当作既有实现写进代码或设计**。当前挂账：

| 项 | 状态 | 出处 |
|---|---|---|
| N1 spike（Next+Tailwind+shadcn 装配、组件落点、`cn` 包、中文 locale） | **✅ 已通过（2026-09-27）** | `docs/research-nextjs-stack.md` §5/§6.4 |
| N2–N7 spike（`withScope` 404 / worker+锁+drain / 双副本加密键 / 预签名 PUT+nginx / 云之家 OIDC / 真表+动态数组表单） | **门禁 G1 剩余项，未跑** | `docs/research-nextjs-stack.md` §5 |
| 原版 shadcn 的 React 组件清单（有没有现成上传件） | **抓取失败，未核到** → `FileUpload` 按自封装排期 | 技术选型 §13.4、P1-18 |
| 中文 locale（Calendar / Date Picker 月份、星期、周起始） | 未证实，必须实测 | 技术选型 §12.4 |
| 云之家能否列举在职成员 | 未确认 → 离职回收可能退化为"登录时校验 + 未登录告警 + 人工停用"，**这是要签字接受的风险，不是已具备能力** | P1-16、技术选型 §3.4 |
| `node:worker_threads` 类方案 | 原 Nitro 时代的待验项；Next 下 `worker/` 是独立进程，别再引这条 | 技术选型 §12.4 / §13.2 |

**来源卫生**：只有代理域名（如签名 OSS 对象）支撑的结论一律记为未证实；先前"官方已列 Vue 为一等实现"就是因此撤回过。

---

## 明确不做（第一期）

**已定不做**（技术选型 §3.6、§12.5）：Elasticsearch/全文检索、消息队列、Redis、微服务拆分、ORM 软删插件、monorepo 构建缓存（turborepo/nx）、pgbouncer、任何跨用户共享缓存；案例模块与外部/访客只读账号一期出局（master 裁定）。

**§9 只是"建议移出"、尚未裁定，不要当定案执行**：邮件渠道（落地方案 W5-5 仍标"待拍"）、全局搜索、批量导入。其中**批量导入仍在一期**——master F7-4 / P14 / 票 W7-3 都带着它，只是缺原型；别按"已移出"把它删掉。

---

## 派单纪律（写给"用 AI 施工"这件事本身）

- 票面必须带**规格件出处到章节号**；禁止把落地方案里的推断当"已知事实"写进派单。
- 子代理回报的完成状态一律以 `git status` + 目标文件实存 + 命令实际输出为准，**不采信叙述**。我自己说"已落盘/已结案"同样按这条办——本项目真出过一次口头宣布 517 行研究文档、实际文件不存在的事。
- W0-7（本票）未完成前不派任何写码票。
- **可整体派发的票**（落地方案 §7 原样）：W0-1/2/5、W1-5/7、W2-5/7、W3-2/3/5/7/9、W4-3/5、W5-4、W6-4/6、W7-3/4。
- **必须人审后才放行的票**（同处原样）：W0-3/4/6/**7**、W1-1/2/3/4/6、W2-1/2/3/4/6、W3-1/4/6/8、W4-1/2/4/6、W5-1/2/3、W6-1/2/3/5、W7-1。
