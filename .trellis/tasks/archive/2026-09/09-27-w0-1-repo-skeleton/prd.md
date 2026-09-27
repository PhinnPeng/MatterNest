# W0-1 仓库骨架 PRD

票面出处：`docs/implementation-plan-v1.md` §3 M0 的 **W0-1**（标"派"），退出条件对齐 §2 的 M0 行。

## 目标

建出"能装东西的壳"：包管理、TS 严格模式、lint/format、测试器、目录树，以及**八条禁令里属于骨架阶段的那条 CI 断言**。本票**不含** Next 装配（W0-2 = N1 spike）、不含迁移管线（W0-4）、不含容器与真实 env 值（W0-5）。

## 用户已定（2026-09-27 三问三答）

| 决定 | 内容 |
|---|---|
| Node | **钉 22**：`engines: ">=22.0.0 <23"`，技术选型 §7 假设 A 的"本机 Node 24"按实测 `v22.22.2` 改正 |
| 开发期数据服务 | **连共享 dev 机映射口**（PG `:30432` / MinIO `:30090`），不在本机起有状态容器 |
| CI | **本票只写本地校验脚本 `pnpm verify`**，CI 平台后定；落地方案 §2 的"CI 有 CHECK 一致性测试"由后续票在 verify 里承担 |

## 约束（来自规格件与刚落地的 spec）

- 目录树按 `docs/tech-stack-decision.md` §5 单 app 拓扑；`components/ui/` 与 `lib/server/` 画在 `src/app/` 下。
- **不建 `pnpm-workspace.yaml`**：§5 明写"仍是一个 app"，§3.6 否了 turborepo/nx，`.trellis/config.yaml` 的 packages 段昨日已实测裁定不填。
- `src/shared/**` 禁 import `next/*`、`react`、Node API（`.trellis/spec/backend/directory-structure.md` 禁令①）。
- Next 16 起 `next build` **不再自动跑 lint**（官方安装页 VERIFIED）→ `lint` 必须是独立脚本并由 `verify` 显式调用。
- 命名前缀未拍（master P1-15 / P1-20）→ 目录与表名一律**裸名**，`package.json` 的 `name` 用 `matter-nest` 并在 prd 记为"待 P1-20 回写"。

## 验收（本票自证）

1. ✅ `pnpm install` 可重放（lockfile 已入库）；`pnpm verify` = format:check → lint → typecheck → test → lint-guard，实测全绿（vitest 2 passed）。
2. ✅ **shared 纯净性断言被证伪过**：`pnpm verify` 里有一步对故意写坏的 fixture 跑 eslint，**必须拿到 ≥1 条 error** 才算通过——证明禁令① 真拦得住，而不是规则文件里躺着一条永不触发的配置。
3. ✅ 目录骨架落盘（`src/app`、`src/app/components/ui`、`src/app/lib/server`、`src/shared`、`worker`、`deploy` 各带一句用途说明的 README，不放业务代码）。`src/shared/` 下唯一实体是 `dirs.ts` + `purity.spec.ts`（tsc/vitest 需要输入文件才跑得起来）。
4. ✅ `.env.example` 只给键名与占位值，零凭据；共享机不可达这条写在文件头注释里。
5. 未新增 `docs/` 结论性改动，除：技术选型 §7 A 的 Node 数值按实测更正（append-only 标注）。

## 已发现的阻塞（不在本票内解决，但必须上报）

- 共享 dev 机 **172.16.70.100 当前完全不可达**：ping 100% 丢包，`30432` / `30090` / `30306` 三端口 TCP 全部 TIMEOUT（2026-09-27 实测，node `net.connect` + `ping` 双向确认）。→ W0-5 之前需要用户确认机器是否开机、GameViewer 映射是否在、IP 是否变。**本票的 `.env.example` 因此只写占位 host，不写"已验证端点"。**
- `pnpm install` 需外网 registry；若离线即上报，不改用其他包管理凑。
