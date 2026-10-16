# MATT-91 会话 UTC 前提由代码拥有：ALTER ROLE SET timezone 落进 provision 路径，处置装饰变量 PG_SESSION_TIMEZONE

> Paca 票 #91（父票 #2「M0 地基与门禁」）。调研出处：`docs/research-env-portability-2026-10-16.md` §A（在一次性分支 `research/env-portability-2026-10-16` 上，**不合并、不 cherry-pick**）。

## Goal

「连库后 session timezone 必须是 UTC」是本仓的硬前提，但**它今天没有任何代码拥有**：真兜底只有
`src/app/lib/server/db/client.ts` 的起池断言与 `tools/db-check.mjs` 的 C4，而两者都只是**探针**——
真正让会话是 UTC 的那条 role 级 `ALTER ROLE … SET timezone='UTC'` 只在共享 dev 库上**被人手工执行过**，
新库 / CI / 部署都没人重放。于是「换一台 server default timezone ≠ UTC 的库就红」不是代码 bug，
而是前提没人拥有。本票让前提由代码拥有，并把给人「已覆盖」错觉的装饰变量处置掉。

## Requirements

- `ALTER ROLE <应用角色> SET timezone='UTC'` 落进**代码拥有的路径**（候选：`tools/ci-provision-role.mjs`
  建角色时一并设；**迁移路径是否也该兜需主会话裁定**，本票只交事实不下结论）。
- `PG_SESSION_TIMEZONE` 二选一：接上真消费者，或删除并同步三处声明点（`.env.example` / `ci.yml` /
  `deploy/docker-compose.yml`）——**不留假覆盖**。
- 先搜清「凡是代码拥有的建应用角色路径」有几处，同形处理；漏一处就是下一个「只在开发机成立」。
- **可复现验收**：用一个 server 默认时区 = PRC 的 PG16 库跑 `pnpm db:check`，**修复前 C4 必红**
  （先反向红一次），修复后 C4 绿。
- 结论回写 `.env.example` 那段注释（现在写的是人工 `ALTER ROLE` 的做法，要改成指向代码拥有的路径）。
- 改动最小：本票是「让前提有人拥有」，不是重构部署；能一行 ALTER 解决就不引入新机制。

## Acceptance Criteria

- [ ] `tools/ci-provision-role.mjs` 建/更新角色时一并下发 role 级 `timezone='UTC'`，
      且该性质进**工具自带复核**（`APP_ROLE_MUST`）与离线 spec，删掉它必须当场红。
- [ ] `PG_SESSION_TIMEZONE` 在三处声明点同步处置（删除），改后 `grep -rn PG_SESSION_TIMEZONE` 零命中
      （或接上真消费者 —— 二选一，本票按「删除」办，理由见 prd Notes）。
- [ ] **反向红**：修复前，对 server default timezone = PRC 的库跑 `pnpm db:check`，贴出 **C4 红的原文**
      （并说清是 C4 红还是 `client.ts` 起池就抛）。
- [ ] **修复后**：同一套流程重跑 `pnpm db:check`，C4 绿，贴原文。
- [ ] **角色级设置真的生效**：以应用角色连上去 `SHOW timezone;` 得 `UTC`，
      且 `pg_roles.rolconfig` 里有 `timezone=UTC`（贴原文）。
- [ ] `pnpm verify` 全绿。
- [ ] `.env.example` 那段注释新旧对照，指向代码拥有的路径。
- [ ] 「迁移路径要不要也兜」的**事实证据**（迁移跑在哪个角色上、它有没有权限 ALTER 另一个 role）
      写进交付报告，**不下结论**，留给主会话裁定。

## Notes

- 为什么 `PG_SESSION_TIMEZONE` 走「删除」而不是「接上消费者」：本仓的真前提是**role 级默认 + 起池断言**，
  而 `client.ts` 起池时发现不是 UTC 就**直接抛**——等于**拒绝**了「连上再 SET 兜」这条路。
  留一个没有消费者的变量只会让人以为已覆盖（这是本票要消掉的错觉本身）。
- 交付边界：**不 git commit、不 push、不写 Paca**；不碰另一会话正在改的
  `src/app/(desk)/users/users-view.tsx`、`workbench.tsx`、`matters/[id]/matter-detail.tsx`、
  `src/app/lib/server/services/reports.ts`、`public/`。
- 参考文档在另一条一次性分支上（本工作区看不到该文件），故不进 implement/check manifest；
  需要时用 `git show refs/heads/research/env-portability-2026-10-16:docs/research-env-portability-2026-10-16.md` 读。
