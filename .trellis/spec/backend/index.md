# Backend Development Guidelines

> MatterNest 一期后端（Next.js 16 Route Handlers + Drizzle/PG + 独立 worker 进程）的硬性约束。
> 本目录是派单前置：`trellis-implement` / `trellis-check` 子代理的上下文清单从这里取。

---

## 现状声明（读之前必须知道）

- 本仓**当前零应用代码**：仓库根只有 `docs/`、`CHANGELOG.md`、`AGENTS.md`、`.trellis/`（实测 `ls`：无 `src/`、无 `worker/`、无 `package.json`）。
- 因此下列规范是**规格件已裁定的约束**，不是从既有代码归纳出的模式。Trellis 引导任务原本要求"document reality, not ideals"，本仓的 reality 是"M0 尚未开工"，所以这里记的是**开工即生效的约束**。
- 凡未跑过 spike 的能力一律标 `UNVERIFIED`，不得当既有实现写代码（`docs/research-nextjs-stack.md` §5、`docs/tech-stack-decision.md` §12.4）。

---

## Guidelines Index

| Guide | Description | 主要来源 |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | 单 app 拓扑、依赖方向、命名 | 技术选型 §5、§4 |
| [Database Guidelines](./database-guidelines.md) | Drizzle/迁移/软删 partial unique/CHECK 一致性/编号/加密 | 技术选型 §13.5 禁令①–④、§3.2b/§3.2c；枚举表 §5；修订稿 §12 |
| [Error Handling](./error-handling.md) | 404 而非 403、JSON 契约、`withScope` 默认拒绝 | 技术选型 §13.5 禁令⑤、§13.3-1；权限草案 §4 |
| [Logging Guidelines](./logging-guidelines.md) | `activity_log` 同事务、动作闭集、应用日志与脱敏 | 权限草案 §7.3；枚举表 §3/§5.4；技术选型 §7 |
| [Quality Guidelines](./quality-guidelines.md) | 八条禁令 + 验收门禁 + CI 必须拦得住的东西 | 技术选型 §13.5/§13.3；落地方案 §4/§5 |

---

## Pre-Development Checklist（开工前逐条过）

1. [ ] 读 `docs/tech-stack-decision.md` §13.5（现行八条禁令）。**不要读 §12.3**——那份含 Vue/Nitro 措辞，已标过时。
2. [ ] 确认门禁状态：G1（N1–N7 spike）/ G2（B8 删除语义）/ G3（P0-6 字段归属）是否已过（`docs/implementation-plan-v1.md` §0）。G2 未拍之前**不要写任何 FK 与软删迁移**。
3. [ ] 枚举取值以 `docs/PRD-phase1-enums-and-schemas.md` 为权威源，不在别处再抄一份。
4. [ ] 新目录必须落在 [Directory Structure](./directory-structure.md) 的依赖方向里；`src/shared/**` 里出现 `next/*`/`react`/Node API 即 CI 失败。
5. [ ] 涉及权限的读取，先想清楚"不可见时返回什么"——答案是 **404**，且必须能落到 `/api/**` 的 JSON。

## Quality Check（收工前逐条过）

- [ ] 业务读写全部经 `/api/**` Route Handler；Server Function 只做编排，没有第二套权限判断。
- [ ] 每个 handler 内部有 `withScope()`，鉴权不依赖 proxy/middleware。
- [ ] 无裸 `select()` 绕过 ScopeResolver；分页 ≤100。
- [ ] 状态/归属/授权/转案件类写操作与 `activity_log` **同一事务**，含 `payload` 与需要时的 `reason`。
- [ ] 迁移只用 `generate` + `migrate`；CHECK 手写进迁移 SQL，且 CHECK↔值数组一致性测试通过。
- [ ] 未证实能力没有被当成既有实现（grep 自己的 diff 找 `worker_threads`、`'use cache'`、"官方 session"这类词）。
- [ ] `pnpm lint && pnpm typecheck && pnpm test` 绿。

---

**语言**：本目录统一中文（裁定记录见 `docs/implementation-plan-v1.md` §3 W0-7 与本任务 `prd.md`「本票的两条裁定」第 1 条；覆盖模板默认的 English）。
