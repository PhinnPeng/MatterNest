# Directory Structure

> How backend code is organized in this project.
> 来源：`docs/tech-stack-decision.md` §5（仓库拓扑，v5 现行）、§4（设计约束→落点对应表）、§13.1（落地形态）。

---

## Overview

**单个 Next.js 16 应用（App Router），同仓单语言 TypeScript。** 不存在 `apps/server` + `apps/web` 两棵树，也不引入 Python——枚举与 DTO 前后端共用一份是 `docs/PRD-phase1-enums-and-schemas.md` §5.1 的硬要求（技术选型 §13.1「不顺手换后端」）。

后端在三处：`src/app/api/**`（Route Handlers，唯一业务写入口）、`src/app/lib/server/**`（服务端专用）、`worker/**`（独立进程跑定时任务）。

---

## Directory Layout

```text
MatterNest/
├─ src/app/
│  ├─ api/**              Route Handlers —— 唯一业务写入口；每个 handler 内 withScope()
│  ├─ api/auth/**         双通道登录：/local、/yunzhijia/callback（技术选型 §3.4、§4 末两行）
│  ├─ (auth)/ (desk)/ …   页面壳（前端规范，见 ../frontend/directory-structure.md）
│  ├─ components/ui/      shadcn 复制件 + 自封装，前端唯一依赖层
│  └─ lib/server/         服务端专用：db、ScopeResolver、签名、session、云之家客户端
│                          —— 这一层可以 import Node API
│     ├─ db/schema/*.ts    schema 真相（`index.ts` 是唯一入口，漏挂 = generate 看不见）
│     ├─ db/migrations/    迁移真相：编号 SQL + `meta/_journal.json`，人审对象
│     └─ db/seed/*.sql     数据迁移：幂等重放，不记账本
├─ src/shared/            前后端唯一共用层，**纯 TS**：enums(E01–E37) · Zod schema · ids · time · crypto
├─ worker/                node-cron 四件：节点提醒 / 规则 4 无更新 / outbox 投递 / 云之家在职同步
├─ deploy/                compose、nginx.conf、minio 桶策略、备份脚本、migrator
├─ docs/                  规格件 + research（枚举表是取值权威源）
└─ .trellis/spec/         本目录
```

### 依赖方向（单向，违反即 CI 失败）

```text
src/app/**        →  src/shared/**      ✅
src/app/**        →  src/app/lib/server/**  ✅
worker/**         →  src/shared/** + src/app/lib/server/**  ✅
src/shared/**     →  任何一层           ❌
```

**禁令①**（技术选型 §13.5-1，逐字）：`src/shared/**` 只放纯 TS——不得 import `next/*`、`react`、Node API；它同时被客户端与服务端引用，污染了就会把服务端代码带进前端 bundle，CI 必须拦得住。

> **本文件里的 `src/app/lib/server/**` 于 2026-09-27 校正过一次**：本节原先写 `src/lib/server/**`，而 W0-1 实际建出来的层级、以及 `eslint.config.mjs` 里禁令① 的挂载点是 `src/app/lib/server/`（Next App Router 下 `lib` 在 `src/app/` 内）。旧箭头指着一个不存在的目录，派单时会被子代理照抄。技术选型 §5 注的同一处映射已一并改。

> 路径改名已发生两次（Nest 时代 → Nuxt 时代 → Next 时代）。§4 对应表里若出现旧路径，按本图读：`packages/domain/*` → `src/shared/*`，`packages/db` → `src/app/lib/server/db`，`server/api` → `src/app/api`。**以 §5 拓扑图为唯一准**（技术选型 §5 注）。枚举表 §5.1 的目录块仍写 `packages/domain/enums/`，落地位置是 `src/shared/enums/`。

---

## Module Organization

新增功能按"落点"归位，不按"模块名"新建顶层目录：

| 要写的东西 | 落在哪 | 依据 |
|---|---|---|
| 业务读写接口 | `src/app/api/<资源>/route.ts` | §13.5 禁令⑤ |
| 表单 mutation 的编排 | Server Function，但**不承载第二套权限判断** | §13.2 对禁令⑤的加强 |
| 数据范围判定 | `src/app/lib/server/scope/` + 仓储基类断言，显式 `withScope(event, handler)` | §4「ScopeResolver + 禁止裸表访问」行 |
| 状态机 / 规则求值 / 编号 / 期限计算 | `src/shared/`（纯 TS，可被前端复用） | 枚举表 §5.1；§4「期限计算」行。**注**：状态机与规则求值在 §4 无对应行，按 §5 拓扑归入 `src/shared/`（本轮新增口径，非引用） |
| 字段加密 + HMAC 索引列 | `src/shared/crypto`，密钥从 env 注入，**不入库** | §4「字段加密 + HMAC 索引列」行 |
| 审计写入 | 服务层单点包装（写成功后落 `activity_log`），不是 Interceptor/Guard | §4「`activity_log` 自动落审计」行 |
| 特权开关判定 | `requirePrivilege(event, 'can_unarchive')` 这类统一辅助函数 | §4「特权开关」行（原 `@RequirePrivilege()` 装饰器是 Nest 落点，已废） |
| 定时任务 | `worker/`，每条包 `withSingleFlight()` | §3.5、C1（§13.2） |
| 一次性补跑 | `docker compose run worker --task <name>` | C2 作废后的替代路径（§13.2） |

**禁止**：裸 `select()` 绕过 ScopeResolver（§4「ScopeResolver + 禁止裸表访问」行要求 CI 检查）；在 proxy/middleware 里做鉴权（§13.3-1，官方原文要求在每个 Server Function 内部校验）。

---

## Naming Conventions

来源：`docs/PRD-phase1-design-revision-r1.md` §8.3（命名与类型，本轮已定）+ 用户命名裁定。

- **领域命名不改**：案件 `Matter`、事项 `RiskMatter`；表名 `risk_matter_case`。
- **枚举值一律全称 `risk_matter`，禁止缩写 `risk`**（§8.3）。
- 展示字段统一 `name`（不是 `title`）；API 层出参用 `displayName`。
- 类型基线：id `bigint`、时间 `timestamptz`(UTC)、日期 `date`、金额 `numeric(18,2)`、枚举 `varchar + CHECK`（**不用 PG `enum` 类型**——加值要 `ALTER TYPE` 且有事务限制）、固定集合 `text[]`/`integer[]`、自由结构 `jsonb`。
- 项目标识：仓库 `matter-nest`、产品名 MatterNest、缩写 MN、DB 前缀 `mn_`、API 前缀 `/api/mn/v1/`——**这五条来自用户 2026-09-26 的口头口径，docs 里此前一处都没写**（`grep -rn matter-nest docs/` 零命中；`mn_` 只出现在基线 15.1，`/api/mn/v1/` 与禁令⑤的 `/api/**` 是父子关系但未成文）。已登记 master **P1-20** 待回写；`mn_` 前缀另撞 master **P1-15**（规格件全用裸名）。**两者拍定前不得往迁移与路由里自行加前缀。**
- **表名前缀未决，不得自行决定**：基线 15.1 全带 `mn_` 前缀，规格件（修订稿/枚举表/权限草案）全用裸名。现行按**裸名**读写；`mn_` 属 master §7.2 **P1-15** 未决项，任何票不得一边写 `mn_matter` 一边写 `matter`。拍定前若要出迁移，先把这条挂回给用户签字。
- 文件命名：Route Handler 固定 `route.ts`；React 组件 PascalCase（`DataTable.tsx`）；自定义 hook `useXxx`。〔**「其余 TS 模块 kebab-case」是本轮新增口径**——master §8 的 kebab-case 只管**路由**，没管文件名，别当引用用〕

---

## Examples

本仓当前无应用代码，以下为**待落地的目标形态**（M0/M1 出码后由后续票回填真实路径）：

```ts
// src/app/api/matters/[id]/route.ts —— 目标形态（未落地）
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withScope(req, { target: "matter", action: "read" }, async (scope) =>
    json(await matterRepo.findById(id, scope));   // 不可见 → 抛 NotFoundError → 404 JSON
  );
}
```

配套参考：`docs/tech-stack-decision.md` §5、§4；`docs/implementation-plan-v1.md` §1 目标形态图。
