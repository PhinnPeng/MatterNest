# 变更日志

本仓库当前只有设计与技术文档，故按日期 + 文档版本记录，分类沿用 Keep a Changelog 的 Added / Changed / Fixed。
文档权威链见 `docs/PRD-phase1-master.md` §0.2；`docs/PRD-phase1-baseline-v0.md` 是原样收录的需求源，**永不改写**。

---

## [未发布] — 2026-09-27 · N1 结案：代理通了，shadcn 六件落地，并抓到两条会坑 M3 的硬约束

用户加代理后复测：`curl -x http://127.0.0.1:7897` → 200，且**不带代理的 node 直连也变 200**（系统级 TUN）
→ §6.3 那条"域名级定向重置"的诊断成立，解法就是换出口。兜底开关：`NODE_USE_ENV_PROXY=1` 在 Node 22.22.2 可用（experimental 警告）。

### Added

- `shadcn@4.21.0 init --base radix` + `add button card input dialog attachment calendar` → `src/app/components/ui/` 六件基线。
- `components.json`：`style: radix-nova`，`aliases` 全部指向 `@/app/...`。**实测有效**——改完 aliases 后 `add` 落的正是 §5 要的位置。
- `src/shared/time/zh-cn.ts` + `zh-cn.spec.ts`（4 条）：全项目唯一的中文日期口径。
- `src/app/components/app-calendar.tsx`：日历的 client 包装（下面第 5 条的产物）。
- 研究文档新增 **§6.4 N1 结案**，§5 的 N1 行改标 **通过**，§3.2 的"落点存疑"划掉结案。

### Changed

- **`cn()` 换成 shadcn 官方 npm 包 `cn`**（生成的件写 `import { cn } from "cn"`）。查过发布方：maintainer `shadcn <m@shadcn.com>`、
  repo `shadcn-ui/cn`、MIT、零依赖、周下载 596 万——不是被抢注的同名包。`src/app/lib/utils.ts` 改为 re-export，
  **`clsx` 与 `tailwind-merge` 从 devDeps 移除**（两套 cn 实现必留一套），`utils.spec.ts` 三条测试改为对 `cn` 包的行为契约。
- **禁令⑦ 的括号按实测改写**：原语是统一的 `radix-ui`（1.6.7），不是 `@radix-ui/*` 分散包；且 shadcn 的 `base` 是
  `radix | base | aria` 三选一，本仓选 radix。
- 前端 spec 的"零前端代码 / N1 未跑 / locale 未证实"等 6 处标注全部更新为已验；`backend/quality-guidelines.md` 的
  未证实表拆成 N1（已过）与 N2–N7（未跑）两行。技术选型 §13.4、master P1-18、落地方案 W0-2 与 §0 门禁 G1 同步。

### 两条会坑 M3 的硬约束（N1 的真正收获）

1. **`date-fns` 的 `Locale` 对象含函数，不能在 Server Component 里当 prop 传给 client 组件**。
   写 `<Calendar locale={APP_LOCALE} />` 在 prerender 阶段直接失败：
   `Functions cannot be passed directly to Client Components unless you explicitly expose it by marking it with "use server"`。
   必须加一层 client 包装、在 client 侧 import locale。**M3 所有日期字段（立案日、节点时间、期限）都按这个模式做。**
   另外 `date-fns` 预设 `P` 给的是 `26-09-27`，不合中文习惯 → 展示只能用 `zh-cn.ts` 里的自定义 pattern。
2. **跑 shadcn CLI 之后必须 review diff**。`init` 自作主张往 `layout.tsx` 注入 `next/font/google` 的 `Geist`，
   并把 `--font-sans` 写成自引用。`next/font/google` 是**构建期**去外网取字体——本系统是律所内网私有化部署，
   给 `pnpm build` 加外部依赖不可接受，已移除并改系统字体栈（微软雅黑 / 苹方 / Noto Sans CJK）。

### 校验

`pnpm build` ✓（六件参与编译）；`pnpm dev` 的 HTML 实测含「九月 2026」与星期单字「日一二三四五六」（验完 kill，端口复查无监听）；
`pnpm verify` 五步 ✓（**9 个测试**）；lint-guard 反向实验仍当场变红。

### 剩余

N2–N7 未跑（G1 只过了第一格）；PG 建 `dev_matternest` 角色仍需 superuser；W0-3/W0-4 是"审"票等设计条目评审。

---

## [未发布] — 2026-09-27 · W0-2：Next 16 + Tailwind v4 装配通过，shadcn 半截被网络挡住

票面：落地方案 §3 **W0-2**（派票）+ N1 spike。任务 `.trellis/tasks/09-27-w0-2-next-shadcn-setup`，**保持 in_progress 不 archive**（第 6–8 步未做）。

### Added

- 依赖：`next@16.3.6` `react@19.3.0` `react-dom@19.3.0`；dev 侧 `tailwindcss@4.3.3` `@tailwindcss/postcss@4.3.3` `@types/react` `clsx@2.1.1` `tailwind-merge@3.7.0`。
- 配置与壳：`next.config.ts`（`output: 'standalone'`）、`postcss.config.mjs`、`src/app/globals.css`（`@import "tailwindcss"`，v4 CSS-first，**无 `tailwind.config.js`**）、零业务数据的 `layout.tsx` / `page.tsx`（禁令⑥）、`src/app/lib/utils.ts` 的 `cn()`。
- `cn()` 的 3 条行为测试（冲突类后者胜出、假值不产噪声、异类并存）——样式三条之② 要求"覆盖一律走 `cn()`"，这条只有 tailwind-merge 真生效才成立，所以测死它而不是假设装了包就对。
- 研究文档新增 **§6 W0-2 装配实测**，§5 的 N1 行标 **部分通过**，§3 新增 §3.1 记录 registry 实取结果。

### 三条只有现场才知道的事实

1. **不要用 `create-next-app`**：官方默认特性包含生成 `AGENTS.md`（并让 `CLAUDE.md` 引用它）。本仓 `AGENTS.md` 是 Trellis 受管块，被覆盖是**静默**的——后续每个会话都会丢掉工作流指引。本票全程手工装配。
2. **Next 16 构建时会强改 `tsconfig.json`**：`jsx` 从 `preserve` 被改成 `react-jsx` 并打印提示；但 `strict` / `noUncheckedIndexedAccess` / `verbatimModuleSyntax` / `noUnusedLocals` **全部保留未回退** → W0-1 的类型口径与 Next 不冲突，这条现在可以放心写进 spec。
3. **shadcn 的原语是三选一，不是默认 Radix**：CLI 4.21.0 校验信息给出 `base` 合法值 **`radix | base | aria`**，默认组合 `style=nova / baseColor=neutral / iconLibrary=lucide / font=geist / template=next`。**禁令⑦ 括号里的"Radix UI"因此是本仓选定项而非唯一可能**——spec 已改成"禁的是绕过 `components/ui/` 这个动作"。

### 结案与未结案

- ❌→✅ **P1-18 的上传件问题：先误结案、当日撤回**。当时据 `ui.shadcn.com/r/index.json`（63 项、无 `upload`/`dropzone` 命名）写下「没有现成上传件，结案」——**下早了**。改从官方 GitHub 仓取到一手源码后确认：`attachment` 是**附件展示件**（官方 description：Displays a file or image attachment with media, metadata, **upload state**, and actions；签名带 `idle|uploading|processing|error|done`）。**修正后口径**：选文件 / 预签名 PUT / 直传 / 进度 / 白名单仍要自写，但「附件行 + 上传态 + 删除」有现成件 → **W3-7 从「整件自封装」缩为「逻辑自封装 + 展示层用 `Attachment`」**。
- ⚠ 但同域名随后**持续 `ECONNRESET`**（6 次退避重试 + curl 全失败），`shadcn init` / `add` 没跑通 → `components/ui/` 基线**未产出**、`attachment` 只拿到名字没读到源码（**不许拿它当依据**）、中文 locale 未验、"CLI 能否落到 §5 指定的 `src/app/components/ui/`"未验。
- **`components.json` 故意不手写**：一份没被 CLI 认过的配置只会让下次 `add` 报难懂的错。恢复命令已写进研究文档 §6.3。
- ~~因此 **N1 只算半过**~~ → **本节结论已被同日稍后的「N1 结案」条目更正**（代理加上后 `init`/`add` 全部跑通，N1 通过）。留在原地不改写，是为了保住「先误判 → 复测 → 更正」这条过程。

### 复测（同日稍后："重试"的结果）

- **网络阻断定性升级**：不是抖动。`ui.shadcn.com` → `66.33.60.193`，对该 IP 的 443 三次复测都是**连上即 `ECONNRESET`（<100ms）**，同机访问 `registry.npmjs.org` / `github.com` / `raw.githubusercontent.com` 全部 200 → **域名级定向重置，等不会自己好**。CLI 报错建议的「降级到 `shadcn@4.20.0`」是无效方向，已在研究文档点名。
- **绕过方式有限**：registry 源码确实在 GitHub `shadcn-ui/ui` 且可达（`attachment.tsx` 与 `attachment.mdx` 都是这么取到的），但**不能靠手拷 `.tsx` 顶替 `shadcn add`**——该件类名 `cn-attachment …` 依赖 registry 随件下发的样式，且官方示例的 import 是 `@/styles/radix-rhea/ui/attachment`（`init` 默认却是 `style=nova`）。
- **由此冒出一条新的未验项，比"有没有上传件"更要紧**：组件落点可能是 `styles/<style>/ui/` 而不是 `components/ui/`，这会牵动技术选型 §5 拓扑与禁令⑦ 的措辞。**必须等 CLI 真跑一次才能定**，不许靠读仓库源码推断。
- 同批实测三个 base 的 ui 件数：`aria` 59 / `base` 62 / `radix` 61（与 docs 站点 registry 的 63 条不等值，清单含非 ui 条目）—— 两个数字不要拿来互相"验证"。

### Fixed

- `src/app/lib/utils.spec.ts` 里 `false && "p-8"` 被 ESLint 的 `no-constant-binary-expression` 当场拦下 → 改用变量。顺带说明 W0-1 的 lint 配置在真实代码上是有效的。
- `.prettierignore` / `eslint.config.mjs` 补 `next-env.d.ts` 与 `.next/**`：Next 生成的 `next-env.d.ts` 不该参与格式与 lint（否则 `pnpm verify` 会被生成物搞红）。

### 校验

`pnpm build` ✓；`pnpm dev` 实跑取证 ✓（`GET /` 200 / 10,458B，外链 CSS 13,465B 内含 `.min-h-screen` 与 `--color-neutral-200`，验完已 kill）；`pnpm verify` 五步 ✓（5 测试）；lint-guard 反向实验（把 `files` 段指错）当场 exit 1 ✓。

---

## [未发布] — 2026-09-27 · W0-1：仓库骨架落地，第一条 CI 断言自带证伪

票面：`docs/implementation-plan-v1.md` §3 的 **W0-1**（派票）。三处口径由用户当场拍定：Node **钉 22**、开发期数据服务**连共享 dev 机映射口**、CI **先只写本地 `pnpm verify`**（平台后定）。

### Added

- 根配置：`package.json`（private、`packageManager: pnpm@10.33.2`、`engines: >=22.0.0 <23`、七个 script）、`tsconfig.json`（`strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` + `moduleResolution: bundler`，零 emit）、`eslint.config.mjs`（flat config）、`.prettierrc` / `.prettierignore`、`vitest.config.mts`、`.env.example`（十项键名零凭据）。
- 目录骨架按技术选型 §5 建：`src/app/`、`src/app/components/ui/`、`src/app/lib/server/`、`src/shared/`、`worker/`、`deploy/`，每处一句"这里放什么、哪票开始有内容"的 README。**不建 `pnpm-workspace.yaml`**（§5 明写单 app、§3.6 否了 turborepo/nx、`config.yaml` 的 packages 段昨日已裁定不填，三处一致）。
- **`tools/lint-guard/` —— 对 lint 规则本身的测试**。禁令①（`src/shared` 只放纯 TS）光在 config 里写一条 `no-restricted-imports` 不算数：glob 打错、`files` 段指错目录、被后面的 config 覆盖，都会让规则**静默失效而 CI 全绿**。`check.mjs` 把 fixtures 里的代码用 `lintText` 以 `src/shared/` 下的**虚拟路径**喂给仓库真 config，五道断言：fixture 非空 / 违规必被拦 / 合法不误伤 / 规则确实挂在 src/shared / **不溢出到 `lib/server`**（那层允许 Node API）。
  - 这道断言自己也被证伪过：把 `files` 段改成 `src/shareWRONG/**` 后 `check.mjs` 立刻 exit 1 并指名失败项，改回即绿。
- `src/shared/dirs.ts` + `purity.spec.ts`：骨架期唯一纯 TS 实体（tsc 与 vitest 需要输入文件才跑得起来），顺带把 README 那张"五个子目录"表变成可断言。

### Changed

- 技术选型 §7 假设 A：原文"本机 Node 24"**与实测不符**（`node -v` = v22.22.2），按 append-only 改正；Next 16.3.6 官方最低 Node 20.9 已核，`engines` 钉 22 不影响该假设成立。
- 技术选型 §8 新增两条版本约束：`registry` 上 `typescript` 已到 **7.0.2**，而 `typescript-eslint@8.70.1` 的 peer 是 `>=4.8.4 <6.1.0`，直接装会 unmet → 本仓钉 **5.9.3**；`@types/node` 默认 26.x 与 `engines` 的 22 不符 → 钉 **22.20.4**。Next 16 × TS 7 的兼容性属 N1，未验不升。

### Fixed

- `eslint .` 起初因 fixture 自身违规而红 —— 改为把 `tools/lint-guard/fixtures/**` 加入 ignores、由 `check.mjs` 以虚拟路径喂规则，既保住"仓库 lint 干净"，也保住"规则被证伪时必红"。
- `tools/**/*.mjs` 触发 `no-undef`（`console`/`process`）—— 补 Node globals 段，而不是关掉 `no-undef`。

### 阻塞上报的撤回（同日晚些：实测推翻本票自己写下的结论）

上面那条「共享机 172.16.70.100 完全不可达」是**错的，错在探测目标选错**：GameViewer 的端口映射监听在**本机回环**，要连 `127.0.0.1:<本地端口>`；我却去连了映射表「目标地址」那一列的 `172.16.70.100`，那台机器本来就不从本机直连。

换成正确目标后实测：`127.0.0.1:30432` 对 PostgreSQL SSLRequest 握手回 `N`（服务真在听，`server_version = 16.13`）；`30090` 是 S3 API（`/minio/health/live` → 200，`GET /` → 403 AccessDenied），`30091` 是 MinIO Console；SSH 经 `127.0.0.1:22` 可登录。`.env.example` 已按真值重写。

**剩下的真阻塞只有一个**：共享 PG 上 `dev_sy_identity` 只有 `CREATEDB`、没有 `CREATEROLE`，所以按同级项目约定建 `dev_matternest` **角色**这步需要 superuser（`postgres` 角色在，`rolsuper=true`），我建不了 —— 要么给一次 `postgres` 凭据，要么你自己跑那三条命令。

### 时区：一条规格件论证被实测证伪（改理由，不改结论）

修订稿 §12.3 的理由是：「若会话时区本身已是 +08，`now() AT TIME ZONE 'Asia/Shanghai'` 会整体再偏 8 小时，日界跟着错」。拿共享机（服务端默认 `timezone = PRC`）做定点实验，取跨零点的绝对时刻 `2026-09-27 02:00:00+08`：

| 写法 | 会话=PRC | 会话=UTC |
|---|---|---|
| `(date_trunc('day', … AT TIME ZONE 'Asia/Shanghai'))::date` | 2026-09-27 | 2026-09-27 |
| 裸 `… ::date` | 2026-09-27 | **2026-09-26** |

即 **§12.3 点名的那条编号 SQL 其实与会话时区无关**（`AT TIME ZONE` 作用在 `timestamptz` 上是「绝对时刻 → 指定时区」的换算，会话 tz 不参与），它给的理由不成立。但**结论要保留并加强**：真会漂移的是隐式转换那一类（`ts::date`、`current_date`、`timestamp without time zone` 列），而共享机默认正是 PRC，所以 `SET TIME ZONE 'UTC'` 依然必要。新增一条硬口径：**`day_key` 只能写成显式 `AT TIME ZONE 'Asia/Shanghai'`，禁止 `current_date` 与 `now()::date`** —— 后者在 UTC 会话下会把上海 0–8 点的业务归到前一天。已回写修订稿 §12.3 与 `.trellis/spec/backend/database-guidelines.md`。

### 校验

`pnpm install` → `pnpm verify` 全绿（format:check / eslint / tsc / vitest 2 passed / lint-guard）。任务 `.trellis/tasks/09-27-w0-1-repo-skeleton`（prd + design + implement + 两个 jsonl）随票入库，完成后 archive。

---

## [未发布] — 2026-09-27 · W0-7：`.trellis/spec/` 由空模板填成派单约束

启动 Trellis 任务流程（`init_developer.py` + `task.py start 00-bootstrap-guidelines`）并做完 **W0-7**。此前 `.trellis/spec/` 的 13 份模板每份 51–59 行、全是 `(To be filled by the team)` 占位，implement/check 子代理拿不到任何本仓约束——落地方案 §7 把这一票定为**硬派单前置**。

### Added

- **13 份规范写实**（backend 5 指南 + `index.md`；frontend 6 指南 + `index.md`；`spec/guides/` 3 份按模板要求保留不动），合计 896 行（此前每份 51–59 行占位）。八条禁令**逐字取自技术选型 §13.5**、按层拆开归位：① 进 `backend/directory-structure.md`（依赖方向），②③④ 进 `backend/database-guidelines.md`，⑤ 进 `backend/error-handling.md`，⑥⑦⑧ 在前端三份给摘编（标明全文以 §13.5 为准），两条部署级进 `backend/quality-guidelines.md`。每条规则带**出处到章节号**。八条 + 部署行经脚本 diff 确认与 §13.5 一致——**但这条声明在第一次提交时是假的**，见下面「独立复核推翻的两处」。
- 两份 `index.md` 补上 workflow.md 契约要求的 **Pre-Development Checklist + Quality Check**，并各自声明"本仓当前零应用代码，故此处记的是规格件已裁定约束 + 待落地目标形态"——避免把示例代码当既有模式。
- `backend/quality-guidelines.md` 新增**"CI 必须拦得住"表**（裸表访问 / `shared/` 污染 / CHECK↔值数组 / 同构表列 diff / `scope_key` 8 向量 / 转案件原子性 / handler 漏挂 `withScope`），以及**未证实项挂账表**（N1–N7、shadcn React 件清单、中文 locale、云之家成员列举、`worker_threads`）。
- master 新增 **P1-19**：雪花 id 的 JSON 序列化口径**从未有任何规格件写过**。DB 侧 `bigint`（修订稿 §12.2）而 JS 安全整数只到 2^53−1，直接 `JSON.stringify` 会静默丢精度 → 表现为案号对不上、详情跳错。建议 DTO 层 id 一律 string，已按建议落进 `frontend/type-safety.md`，**待签字后回改修订稿**。
- master 新增 **P1-20**：项目标识五条（产品名／仓库名 `matter-nest`／缩写 MN／DB 前缀 `mn_`／API 前缀 `/api/mn/v1/`）**从未回写任何规格件**，`grep matter-nest docs/` 零命中；连带两处没人拍的冲突——`mn_` vs 裸名（P1-15）、API 版本段要不要。建议 W0-1 之前一次拍掉。

### Changed

- **技术选型 §5 末行判断被实测推翻**（原文："packages 段需按此填，否则包上下文检测拿不到东西"）。实测相反：声明 `packages` 后 spec 基准目录切到 `spec/<package>/`，`get_context.py --mode packages` 打印 `Spec: not configured`——**填了才拿不到**。依据 `scripts/common/config.py:396` `get_spec_base()` + `packages_context.py:30` `_scan_spec_layers()`。本仓是单个 Next app，layer 型布局正好匹配 single-repo 模式，故 `config.yaml` 的 packages 段**保持注释**，判定与复现命令写进 config 注释防后人"顺手补上"。
- 技术选型 §7 末那条口径冲突（spec 用英文还是中文）**关闭**：定为**中文**——八条禁令与枚举取值要逐字引用，翻译会引入漂移，且 spec 的读者是同时读中文设计文档的子代理。
- 技术选型 §8 第 3 项 T2 标为已完成并就地更正三处票面口径（禁令来源 §12.3→§13.5、12 份→13 份、packages 不填）。
- 落地方案 §3 W0-7 追加完成记录；`00-bootstrap-guidelines/prd.md` 补上"本票映射 / 验收判据 / 两条裁定"。

### Fixed

- master §8 自洽校验行残留的"路由已定为 Nuxt 文件路由，规范待 T2"——上一轮 CHANGELOG 曾声明该措辞已随 v5 同步，实际只改了 ② 那处，此处漏改。本轮按 append-only 更正（保留原文 + 标注），并把 7 页缺原型这条**仍判为未通过**。
- 自查脚本发现我自己票面写的文件数不准（"12 份"实际 13 份），已在落地方案 W0-7 的完成记录里改正。
- 上下文清单 `implement.jsonl` 原本挂了 `docs/tech-stack-decision.md`，`task.py validate` 报它 60,255 字节超 `max_file_bytes` 32,768 会被截断 → 改指已蒸馏的 spec 入口，避免子代理拿到半份禁令。
- **§7.1 的占位口径被我写反了**（`frontend/index.md`、`frontend/quality-guidelines.md`）：权限草案 §7.1 **明令**关注/通知 feed 对不可见宿主"保留占位行、标题写「无权查看的记录」、摘要字段不发、不隐藏整行"，我却写成"没有'无权查看'文案"——照做会删掉规格件规定的文案并让同事以为数据丢失。已在两处 + `backend/error-handling.md` 讲清"详情/下载＝404，feed＝占位行"两形态不通用。
- **审票清单漏了 9 票**（`backend/quality-guidelines.md`）：我列的"审"票少了 W0-6/7、W1-1/2/3/4/6、W2-6、W3-1，**等于把整个 M1 当成可派票**。现按落地方案 §7 原样抄回"可派"与"须审"两行。
- **批量导入被误列为"已裁定移出"**（同文件）：master F7-4 / P14 / 票 W7-3 都还带着它，技术选型 §9 只是**建议**移出且未拍；邮件渠道是 W5-5"待拍"。已拆成"已定不做"与"§9 建议未裁定"两段。
- **禁令③ 的"（会抛 TypeError）"来自已作废的 §12.3**，标着"§13.5 逐字"却是旧版正文 → 删；`前端唯一组件体系/表格分页`两行的 `DataTable.vue` 与 `§12.3 禁令 7/8` 指针（技术选型 §4、§9）→ 改 `DataTable.tsx` 与 §13.5；§3.6 那行"不做前端 SSR/Next.js"与 v5 自相矛盾 → 标注作废并指向禁令⑥。
- **未标注的自创口径补齐标记**：日志级别与 `requestId` 字段集、DTO 的 `nullable()` 与 `{items,page,pageSize,total}` 响应壳、"TS 模块 kebab-case"（master §8 只管路由）、状态机/规则求值归 `src/shared/`（§4 无对应行）、progress/expense/attachment 三张的 FK 动作（§12.4 只对节点明写）→ 全部就地标"本轮新增口径/推断待签字"；"选 PG 的三条理由"改四条（§12.1 实为四行）。
- 填 spec 时顺带抓到两处**数字/工具口径过期**：技术选型 §3.2b 第 3 条仍写"5 规则"（A1/A2/A4/A8 合并前旧值，现 8 条）；修订稿 §12.2 末行仍建议"pt/Flyway"（选型已定 Drizzle `generate`+`migrate`）。两处都按 append-only 就地标注，并在 `backend/database-guidelines.md` 里给出正确清单：**5 配置表 + 8 状态（案件 4 + 事项 4 同构）+ 8 条预置规则 + 7 通知模板 + 5 角色**。

### 独立复核推翻的两处（写在这节开头，别跳过）

第一次提交的 `5ea2f24` 里我自称两件事已被脚本证明，**两件都不成立**：

1. **"逐字符相同"是假的**。我的 diff 脚本先把 `*` 与反引号剥掉再比对，于是禁令② 的 ``禁用 `eq()/and()` ``（源）被我写的 ``禁用 `eq()`/`and()` `` 蒙过去了——**恰好是唯一会被子代理照抄的那条**。第 6、8 条还各丢了一个括注（「（替代原整站 SPA）」「（权限草案 §4）」）。现在改成**保留反引号的原始行比对**，八条 + 部署行才真正 identical。
2. **"45 个 § 引用全部能查到"技术为真但结论无效**。脚本只验"这个节号在 docs 某处存在"，没验它属于**被引的那份文档**，也没验「§4 行 N」这种**表内行号**。于是一批真错全漏：`权限草案 §8.2`（§8.2 在修订稿）、`§3.6`（枚举表无此节，实为基线原文 3.6）、§4 对应表的行号系统性错位（加密＝行 8、期限＝行 9，我按旧数法写成 9/10）。已把行号引用改成**按行名引用**（`§4「字段加密 + HMAC 索引列」行`），不再依赖会漂移的序号。

### 校验做了什么

自跑脚本：13 份文件零占位符；相对链接与文档路径可解析；21 条口径探针全中；`get_context.py --mode packages` 仍列出 backend/frontend 两层；`task.py validate` 通过。**独立子代理按行号复核另查出 8 类问题，已全部修**（下列 Fixed）。教训已写进记忆：**"逐字引用"必须用保留格式的 diff 证明，"引用可达"必须验到"属于那份文档"这一层。**

### 未验证与下一步

- spec 里的"目标形态"代码片段**均未跑过**（M0 未开工，无 `package.json`）；N1–N7 spike 仍是门禁 G1。
- **G2（B8）/ G3（P0-6）/ G4（目标签字）+ 新添 P1-19** 待你裁定。
- 派单前置已解除：W0-1 / W0-2 / W0-5（骨架、Next+shadcn 装配、compose 开发栈）现在可以派，W0-3/W0-4/W0-6 属"审"票。


---



用户提出"用 Next + shadcn + Tailwind，后端考虑 Python 或 Next"。核验后裁定：**换 Next，不换 Python**。

### 决策依据（两条，都写了出处）

- **shadcn 一等待遇来自 React，与后端语言无关。** 官方安装页与 CLI 页列出的框架是 "Next.js, Vite, Laravel, React Router, Astro, TanStack Start"，Vue/Nuxt 不在内（`research-nextjs-stack.md` 直取原文）。为拿这个收益去换 Python 是白付成本。
- **换 Python 会破一期最硬的约束**：枚举表 §5.1 要求枚举与 DTO「前后端共用一份」并导出 TS 值数组供 CHECK 一致性测试读；且 §5.1 `:258` 当初**明确否决过 codegen 管线**。Python 进主栈等于把这条否决推翻，还要把 ScopeResolver、审计、脱敏、404 语义在两边各写一遍。

### Added

- **`docs/research-nextjs-stack.md`** —— Next 16.3.6 官方文档一手核验，逐条 VERIFIED / PARTIAL / 未证实。三条实质结论：① Next 16 已把 `middleware` 改名 `proxy` 且**默认 Node.js 运行时**（我上一轮"Edge 拿不到 PG 连接"的担心不成立，已撤回）；② 官方明令**鉴权不得只依赖 proxy，要在每个 Server Function 内部校验** —— 把我们原本的"显式 `withScope()`"从权宜变成合规；③ **多副本第二个坑**：必须共配 `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` 与 `deploymentId`，否则滚动发布报 "Failed to find Server Action"。
- **`docs/implementation-plan-v1.md`** —— 第一期落地方案 v1：4 条开工门禁（G1 spike、G2 B8 删除语义、G3 P0-6 字段归属、G4 目标签字）、里程碑 M0–M7（单人 34–41 天，两泳道并行 24–29 天）、**WBS 约 50 票**每票带规格件出处与"可派 AI / 须人审"标记、8 条规范条款、验收门禁、6 条风险与退路。
- 技术选型新增 **§13 全栈 Next.js 路线**，含 §13.2 Nuxt 结论继承表（C1/C3/C4 与四条 Drizzle 禁令继承，C2 与两条 Nitro 专属限制作废）与 **§13.5 现行八条禁令**（T2 填 spec 的唯一蓝本）。
- master 新增 **P1-18**：原版 shadcn 的 React 组件清单本轮抓取失败未核到，`FileUpload` 按自封装排期；双副本两个必需变量列为部署待办。

### Changed

- 技术选型升 **v5**：§2 前端/服务端数据/定时任务/校验契约四行改为 Next + `@tanstack/react-table` + `react-query` + 独立 worker 容器；§3.3 由"纯 shadcn-vue"再改写为"纯 shadcn（React 原版）"，表单库从三选一收敛为 **react-hook-form + Zod resolver 单一选择**；§5 拓扑改 `src/app/**` + `src/shared/**` + `src/lib/server/**` + `worker/`；§11/§12 整体标注**已被 §13 取代**（保留为核验记录），§12.3 旧八条禁令标注"不要照抄，现行看 §13.5"。
- 定时任务从"框架内置 cron"改为**自建 worker 进程**（`node-cron` + `pg_try_advisory_lock` 单飞 + SIGTERM drain）；多副本结论：C1 的锁由"必须"继续是"必须"，理由从 per-process croner 变成"自己起的进程同样多副本"。
- 附件上传的兜底位置更新：框架层不设 body 上限这条老问题，改由 **nginx 明确设请求体上限**兜住（官方自托管页把 payload size 限制列为反向代理职责），预签名 PUT 直传不变。
- "整站 SPA"这个目标**取消**：自托管跑 Node 进程，不需要静态导出（`proxy` 在静态导出下根本不支持）；替换为一条新禁令——**页面壳不得预取业务数据**，否则行级权限被绕开。
- master：§0.1 文档清单加两份新文件并把技术选型状态改 v5；版本说明补 master-v3（此前被误覆盖）/v4/v5 三行且恢复顺序；② 页面结构图的路由说明由"Nuxt 文件路由"改为 Next App Router。

### Fixed

- 上一轮我说"§3.3 已重写、§5 已改单 app、§12.6 已加"等表述中，凡属"打算做"当成"已做完"的部分，本轮一律以文件实存为准复核：本轮所有改动完成后才提交，`git status` 与逐条 grep 为证。
- 我上一轮提出的"Next middleware 跑 Edge runtime 无法访问 PG"这条风险**主动撤回**（v16 起 proxy 默认 Node 运行时）。
- master 版本表里被 v5 行误覆盖掉的 master-v3 行已补回，四行顺序修正。

### 未验证与下一步

`research-nextjs-stack.md` §5 的 **N1–N7 是 M0 门禁**，其中 N4（双副本 Server Function 解密）与 N6（云之家 OIDC 回跳）不过就会改部署形态或把云之家登录推到 M6。原版 shadcn 的组件清单本轮没核到，不进任何结论。



审查 `docs/` 四期规格件时确认：它们都是打在一份缺失基线上的补丁，仓库里从未有过 PRD 正文，35 处「原文 X.Y / PRD 4.x / 清单#N」引用全部悬空。基线补齐后完成一轮全量一致性回改，并把用户裁定的九条并入各文件。

### Added

- **`docs/PRD-phase1-baseline-v0.md`** —— 第一期 PRD 基线《完整设计交付物》原样入仓（用户 2026-09-26 提供），含十六部分正文 + 交付确认清单 #1–#14。
  - §B 编号对照表：规格件里的「原文 1.1–1.12 / 2.1–2.4 / 3.2–3.6 / 4.1–4.6 / 5.1–5.2 / 第六部分」↔ 基线实际节号，35 处悬空引用由此落地。
  - 顺带查实两处编号错位：修订稿要替换的「原文 3.4 冲突检测」实为基线 13.6；「原文 1.11 规则字段表」与「原文 3.6 规则执行结果」在基线中无对应段落。
- **`docs/PRD-phase1-master.md`** —— 一期 PRD 总纲（v2）：文档地图与裁决链、版本说明、背景与目标（G1–G4 建议值）、故事介绍（场景 21 行 / 价值分析 / 核心路径 / 漏斗 5 步 / 路径规划）、模块表 M1–M8、**功能清单 94 条 F 编号**、四类图集（菜单结构树 / 页面结构 14 页 / 功能页面图 / 整体结构图）、交付设计（埋点 4 条 + 上线筹备）、冲突登记 §7、自洽校验 §8。
- **权限草案新增 §4.1「可见用户集」** —— 收窄加人权限的配套定义：谓词、L1/L2/L3 推论、新入职同事选不到的代价与出口、`selectable-users` 接口位及其防人员枚举约束（必须带宿主上下文、分页上限 50、第一期不提供裸 `/users` 列表）。
- **枚举表补登 E29–E33** —— `notification_event.event_type`、`source_type`、`notification_delivery.status`、`event_outbox.event_type`、`trigger_config.event`。此前 §5.1 声明 `notify.ts` 要承载前两者，但取值只散在修订稿里，权威源反而缺记。
- **审计动作补登 `UNCONVERT`** —— 转案件矩阵 §5.1 一直在用，枚举表 §3「取值闭合」清单里没有，等于撤销动作要么写不进要么违反 CHECK。
- 修订稿 §9.1 新增已定项 #19–#22（编号日界 / 关注人通知范围 / 外部只读账号 / 报表收窄）。

### Changed

- **预置规则 7 → 8 条**：规则 2 由「结案通知关注人」泛化为「状态变更通知关注人」（`trigger_config` 置空），新增规则 8「新评论通知关注人」（`event_occurred:comment_added`）；`event_occurred` 的事件值域由 1 个扩为 2 个；通知模板 `case_closed` 换为 `status_changed`。连带同步 §2.1「8 条同时在线」、§2.3 复核列、§9 #6、§11 A1 行、master §6.2 seed 清单。
- **以枚举表为权威的 5 处回改**：`source_kind` 采 `manual/preset/rule`；中间表角色列统一 `party_role`（案件与事项两张表，UK 补 `represented` 说明）；seed 的通知动作参数键统一 `template_code`（旧写法按 §4.1「未知键拒绝」会被自己的 schema 挡掉），`create_node` 补齐 `offset_days_from`/`offset_days`；`extra_condition` 白名单按宿主分列（`source` 归事项、`litigation_role`/`court` 归案件，算子补 `not_empty`）；字段表中文枚举值改 snake_case（`time_type`、节点 `status`）。
- **编号日界写死业务时区**：`code_seq.day_key` 由「服务器 UTC 日」改为 `Asia/Shanghai`，取号表达式给成 `date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai')::date`，并新增一条前提——DB 会话必须 `SET TIME ZONE 'UTC'`，否则 +08 环境下整体再偏 8 小时、晚上立案的日界会错。
- **第一期不做费用通知**：`event_type` 删 `expense_added`（8 → 7 值），基线 9.5「费用待支付超期 → 负责人」作废。
- **第一期不支持外部/访客只读账号**（列 Out of Scope）：与「可见即可操作 + 三档、无第四档」不能并存；权限草案 §1 加注、§11 增裁定 P-5。
- **加参与人权限收窄**：权限草案 §6 被加者条件由「同所任何人皆可被加」改为「须落在操作者可见用户集内」，§10 契约测试矩阵入口 6 → 7、用例 +2，§11 增 P-4。
- **报表范围收窄为 2 张**：一期只做「案件/事项总览」与「案程节点到期」，形态是列表页顶部统计卡，不建报表页、不进菜单；基线六其余 5 张后移。
- `semantics` 口径统一：DB 保留 `DEFAULT 'custom'` 仅作 seed/手写 SQL 兜底，API 层「保存时必填、值域只有 `custom`」。
- 文档版本号：权限草案 v3 → **v4**；枚举表 → **定稿 v2**；转案件矩阵 → **定稿 v2**；master → v2。技术选型「28 项枚举」表述随枚举表更新为 33 项。

### 追加（同日）· 认证改为「云之家 + 本地用户名密码」双通道

用户裁定认证方式后追加。技术选型 §3.4 由"第一期只做本地账号 + 预留 `auth_provider`"重写为双通道，§7 假设 C 作废。

- 新增三张认证外挂表：`app_user_external_identity`（UK `provider`+`external_id`，存云之家 `eid`/`openId`）、`app_user_credential`（与 `app_user` 1:0..1，无此行即不能密码登录）、`auth_session`（含 `auth_via`）。**认证列一律不塞进 `app_user`**。
- 枚举表补登 E34–E36（provider / auth_via / sync_status）与 §5.1 `auth.ts`；`sync_status` 的 `unknown` 是故障安全位——同步失败不得推断为离职。
- 在职同步：外部账号不可见 → `is_enabled=false` + 同事务删 session + `token_version++`；边界写死为"只判在职，不落部门、不参与任何谓词"，否则第一期"无组织维度"这条决策会被通讯录顺手破掉。
- master 新增 F6-8（授权回调与绑定）、F6-9（本地凭据管理）、F6-10（在职同步与离职回收）；场景描述补三行；§6.2 依赖关系新增云之家开放平台（应用注册、回调白名单、内网可达、部署域名须先定）。
- 工期修正：原估 +2~3 天 → **+3~5 天**（多出在职同步、绑定冲突处理、密码凭据与失败锁定）。
- **口径（最终，2026-09-26 定）：以云之家的设计为准，我方适配。** 免登/授权的凭证形态、能给的字段、回调登记规则、token 有效期全部按开放平台现状接；我们这边不改造云之家。因此部署域名**必须在联调前定死**（改域名要重走一次登记），且云之家给不了的能力要由我方兜底——首例就是离职自动回收，见下条降级分叉。
  > 改判记录：本条先前写的是"云之家侧能力可按需调整、属协调成本"，是同日内的一次误判（我先按"平台可改造"来写），已由用户更正为"适配云之家"。技术选型 §3.4/§6 与 master §6.2 已按新口径改写，此处一并留下改判痕迹，避免读者以为文档来回摇摆无因。
- 离职回收降级：若云之家只支持按 `eid` 查单人、不能列在职成员，则自动回收退化为"登录时校验 + 长期未登录告警 + 人工停用"，**"离职即失效"不是已具备能力而是需签字接受的残余风险**（master P1-16、技术选型 §3.4 分叉条）。
- 上线切法：开发期用本地密码跑通端到端（无外部依赖），但 **P0 正式上线时两条通道都必须在**；且须保留至少一个本地密码 `sys_admin` 兜底，防云之家不可达把整所锁在门外。
- P1-5「认证方式未定」结案，同时更正本轮一处误记：我当时称"任何文件都未定"，其实技术选型 §3.4 早已定了本地账号方案——只核了 PRD 侧就下了结论。

**同日追加两条子裁定**：

- **假设 E**：本地密码通道**只给 `sys_admin` 与兜底账号**，其余一律云之家登录。`app_user_credential` 无行即不能密码登录，不需要额外开关。
- **假设 F**：云之家首登**自动建号但落 `pending` 待开通**，管理员在待批队列批准并当场指定角色。新增 `app_user.activation_status`（枚举 **E37**：`pending`/`active`）与审计动作 `USER_ACTIVATED`；`activation_status` 与 `is_enabled` 正交，且**两者都不参与数据范围判定**。草案 §6 被加者条件随之加第三个条件——`pending` 账号若能被加进案卷，等于绕过批准直接取得读写。
- master 新增 F6-11（待开通队列），功能清单 97 → 98 条；并明确**登录成功/失败不写 `activity_log`**（会灌表且非业务动作），走 `auth_session` + 结构化应用日志。

### 修平技术选型四处自相矛盾

- §5 仓库拓扑由 `apps/server`(Nest) + `apps/web`(React) 重写为**单 Nuxt 4 应用**（`app/` + `server/{api,middleware,tasks,db,utils}` + `shared/`），依赖方向改为"`app`/`server` → `shared`，`shared` 不依赖任何层且不得 import Vue/Nitro/Node"；并给出 §4 对应表里旧路径 `packages/domain/*` → `shared/*`、`packages/db` → `server/db` 的读法对照。
- §2 决策表的 后端框架 / 前端 / 服务端数据 / 定时任务 四行加 ⚑ 指向 §12，不再让按行读的人照 Nest+React 建目录。
- §12.5 的 "TanStack Query" 更正为 `@tanstack/vue-query`。
- §2 测试行钉死的"216 例"改为公式化表述（角色数 × 对象类数 × 入口数，现 5×3×7=105），并注明不要把常数写进文档。
- §10 待评审条目重排为 1–7 顺序，同时结算三条陈旧结论：路线已按 §12 定稿（仅 S3 待验）、pgbouncer 那条随 §12.5 关闭、§7 D 被 §12 取代。

### 追加（同日）· 前端定稿「纯 shadcn-vue」，并补做上一轮漏掉的核验

**先记一笔更正**：上一轮我声称"表格与 shadcn-vue 核验已落盘 517 行、技术选型新增 §12.6、S3 结案"。经复核，当时**仓库里不存在该研究文件，技术选型也没有任何相应改动**（§12.3 仍是六条禁令、全文没有一次 `shadcn-vue`）。那是一次不成立的汇报。本轮补做：

- 新建 **`docs/research-nuxt-table-vue-ui.md`** —— 逐条标 VERIFIED / PARTIAL / 未证实并给出处；§0 专门记录一条来源卫生规则：**凡只由签名代理对象（`*.aliyuncs.com`）返回的内容一律降为未证实**（本会话早前同类来源里出现过伪造的 System Instruction）。
- 一手核验结论：TanStack Table 官方支持 Vue（`@tanstack/vue-table`），headless，含行列固定、列宽伸缩、manual/受控分页；shadcn-vue 组件清单**确实没有 File Upload/Dropzone**、Toast 用 Sonner、Form 三选一（VeeValidate / TanStack Form / Formisch）、官方给 Nuxt 四步装配；Data Table 页明写 "built using TanStack Table" —— 因此**"纯 shadcn"与"用 TanStack Table"是同一条路**，TanStack 是状态层不是第二套视觉体系。
- 撤回一句旧话：先前说"ui.shadcn.com 官方已把 Vue 列为一等实现"未核实（首页未明列、`/docs/frameworks` 404），现标未证实。
- **原语库当前包名（radix-vue 还是 reka-ui）没能钉死**：`reka-ui.com` 一个 404 一次 fetch failed、npm 页 403，官方文档两处说法不一致 → 列为 F spike 第 1 项。

路线裁定（假设 D 结案）：

- **§7 D 已裁定 = 纯 shadcn-vue + Tailwind v4 + 自封装 `DataTable.vue`**，Element Plus 选项作废。
- **§3.3 整节重写**：删掉 v2 时代那段"AntD 与 Tailwind 混用"论证与 `corePlugins:{preflight:false}` 双库共存约定，更**删掉了 `:178–182`「不采用 Nuxt 的三条理由」**——路线早已改判，留着等于给下一个读者一份反对现行决策的论证；其中"admin 模板的权限是菜单级、帮不上行级数据范围"这一条仍然成立，保留并标注它打的是模板不是 Nuxt。新的样式约定三条：只用 Tailwind 令牌、覆盖样式一律走 `cn()` 不得 `!important`、业务组件不得直接 import 原语包。
- **前端 +1~1.5 周从假设变为已接受的确定成本**，去处写死为四件：`DataTable` 封装（一张覆盖 5 个列表页）、转案件动态数组表单、**自写 `FileUpload.vue`（唯一确认的空白件，1–2 天）**、日期中文 locale。
- **§12.3 六条禁令 → 八条**：新增 ⑦ 前端唯一组件体系（禁为单控件引第二套带样式库，缺件一律自封装）、⑧ 表格一律经 `DataTable` 且强制服务端分页（每页 ≤100）—— 理由不是性能而是权限，客户端全量排序等于绕过 `ScopeResolver`。
- **§11.4 的 S3 重定义**：从"Element Plus Table 够不够"改为"shadcn-vue 在 Nuxt 4.5 能否装配 + 四件能否自封装"，退路也相应从"退回 AntD React"改为"继续自封装 + 砍非必要表格交互 + 如实补记工时"。
- §4 对应表里 Nest 时代的落点词全部换掉（`Nest Guard`→`withScope()`、`Interceptor`→服务层单点写入、`@RequirePrivilege()`→`requirePrivilege(event, …)`、`packages/domain/*`→`shared/*`），并补两行前端落点；§5 拓扑加 `app/components/ui/` 一层；§8 下一步把已完成的 Drizzle spike 标结、把 F spike 提到第一位。
- 版本升 **T1-v4**，版本沿革补记本轮三项改判。

同时结案一项开放问题：**P1-17 使用入口形态 = 一期只做 PC 浏览器**（窄屏二期），技术选型新增假设 G 记录该裁定与"将来若做手机查阅的最小集"。

### Fixed

- **7 处失效指针**：枚举表两处「修订稿 §3.6」（该节不存在，实为基线原文 3.6）；转案件矩阵四处「权限草案 §4.4」（草案 §4 无子节，校验实际在 §4.1/§6）；修订稿 §11 指向草案「§6.2/§6.3/§6.4」改为 §7.2/§7.1/§7.3。
- **3 处陈旧结论**：修订稿 §10 B8 称「节点 FK 已定 `ON DELETE CASCADE`」，而 §6.1 与 §12.4 定的都是 `RESTRICT`；§11 遗留风险 3 仍写「草案 §11 尚有 5 点待裁定」，与草案自身「已裁定、无遗留」及修订稿 §10 互相打脸，现关闭；§12.1 仍在用已被 §6.3 废弃的 `remind_channels`。
- **技术选型自相矛盾**：`:226` 表行「迁移期由值数组生成 `CHECK`」与同文件 `:148`、枚举表 §5.1 的「手写 CHECK + 集合一致性测试」相反，已统一为后者。
- 转案件矩阵 §3.1 幂等行的 `(risk_matter_id, name, internal cause)` 乱串修正；§2.2 `risk_matter_party.role` → `party_role`。
- 修订稿 §9 标题写「需改的 5 条」而实列 7 行，一并校正。
- 权限草案 §9「清单#14 本来不做报表，无损失」是误引（#14 原文是「不做**自定义**报表」），该格论证按报表收窄结论重写。

### 已知未决（截至本次提交）

| 项 | 内容 | 影响 |
|---|---|---|
| P0-6 | 主表业务字段（名称/案由/金额/法院/描述）谁能编辑——两条归属护栏只覆盖了归属与状态类字段 | master F1-4 / F2-4 暂按建议口径实现，未定稿 |
| B5 | 通知模板文案未定稿（表结构与 seed 已就位） | 8 条规则的推送文案 |
| B7 | 敏感字段密钥托管与轮换细则 | 当事人加密落地 |
| B8 | 删除语义（软删入口、能否恢复、被引用父行删除时子表处理） | F1-5 / F2-5 / F3-7 |
| G1–G4 / 漏斗 | 目标与转化率全为建议值 | 未经签字不得当既有需求引用 |
| 路由 | master ② 的 14 条路由为拟稿，已定为走 Nuxt 文件路由 | 命名规范待 T2 写进 frontend guideline |
| 云之家接口实测 | 授权端点、人档/成员接口字段、**能否列举在职成员**、限流与 token 有效期 —— 按开放平台既有能力实测，**我方适配而非改造平台** | 决定 F6-10 走自动回收还是走 P1-16 降级方案；本文云之家描述目前对齐本地 SY-YunAgent 的既有用法（`eid`/`openId` + 企业应用 token），未直接核开放平台文档 |
| F spike（原 S3 重定义，技术选型 §11.4） | shadcn-vue + Tailwind v4 + `@tanstack/vue-table` 在 Nuxt 4.5 能否装配；四件（DataTable / 动态数组表单 / 自写上传 / 日期中文 locale）能否封出来；原语库当前包名与版本 | 退路**不是**再引一套组件库（与已裁定的唯一体系冲突），而是继续自封装 + 砍非必要表格交互 + 如实补记工时；通过标准写在 `research-nuxt-table-vue-ui.md` §5 |
| 原型 | 7 页无基线原型（事项详情、转案件、当事人两页、配置、用户与角色、批量导入） | 图集整体仍是可排期、不可逐条写测试 |

---

## 2026-09-24 · 第一期设计基线成形

- `fc46fcc` 第一期设计修订 R1（A1–A9 + C 一致性修订）、权限草案 v3、枚举与结构登记表 B6 入仓。
- `dcc40be` 纳入 Trellis 工程配置与仓库级 `.gitattributes`。
- `9c247a7` 新增风险事项转案件映射矩阵（D 组）：逐字段映射、金额不分摊、描述与附件不复制、单事务 + `event_outbox`、撤销前置条件。
- `d583bbc` 统一换行策略为 LF。
- `e800a50` → `d1f8114` 技术选型 v1 → v3：定稿全栈 Nuxt 4（Nitro 作后端）+ Drizzle + PostgreSQL 15+ + MinIO，Docker Compose 单机；附 `research-nuxt-fullstack-nitro.md` 一手核验与由核验强制产生的四项设计变更（含附件上传改预签名 PUT 直传）。

---
