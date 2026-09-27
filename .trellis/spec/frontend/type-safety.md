# Type Safety

> 类型组织与校验单源。
> 来源：`docs/PRD-phase1-enums-and-schemas.md` §5.1/§5.3、§8.3（修订稿）；`docs/tech-stack-decision.md` §13.1、§13.5 禁令①⑧；`docs/PRD-phase1-design-revision-r1.md` §12.2/§12.3。

---

## 单一事实源：类型只有一份

```text
src/shared/
├─ enums/    targets.ts · status.ts · business.ts · notify.ts · auth.ts · audit.ts · automation.ts
│            每个文件同时导出：TS 联合类型 + 值数组 + 中文名字典（枚举表 §5.1）
├─ schema/   Zod schema —— DTO 类型由它 .infer 出来，接口出入参与表单规则同源
├─ ids/      雪花生成（应用侧，技术选型 §2「ID」行）
├─ time/     期限计算（`date` 与 `timestamptz` 的边界）
└─ crypto/   字段加密 + HMAC 索引列
```

- **禁止**在 `src/app/**` 里再声明一份业务枚举或 DTO 形状。换 Python/换后端语言之所以被否，第一条理由就是它会破掉这份共用（技术选型 §13.1）。
- 枚举表取值权威：E01–E37 共 37 行、**34 项为真实取值**；`CHECK` 手写进迁移 SQL，配 CHECK↔值数组一致性测试（§5.1，本仓 CI 必查项）。
- 废弃值**保留在联合类型里**并标 `@deprecated`，前端不再展示但历史数据要能反查中文名；**禁止**从 CHECK 删值（枚举表 §5.3）。
- 枚举值一律全称：`risk_matter` 不得写成 `risk`；`target_type` 取值是 `{matter, risk_matter, matter_node, risk_matter_node, matter_progress, matter_expense}`（修订稿 §8.3）。

---

## 校验规则只有一套

禁令⑧后半：表单库**只用 react-hook-form + Zod resolver**（与 `shared/schema` 同源），日期库全项目只允许一个；**组件内不得自带第二套校验规则**。

```ts
// 目标形态（未落地）
import { matterCreateSchema } from "@/shared/schema/matter";
const form = useForm<z.infer<typeof matterCreateSchema>>({
  resolver: zodResolver(matterCreateSchema),
});
```

服务端同一份 schema 再跑一次（客户端校验只是体验，不是防线）。跨字段规则（如 `ck_node_time_shape` 的 range/point 形态约束）在 schema 里用 `superRefine` 表达一次，DB 侧 CHECK 与之对齐——**不要在前端另写一套 if**。
- **表单 schema 不要用 `.default()`**（N7 实测）：Zod 的 `.default()` 会让 input 类型带 `?`、output 类型不带，`useForm<T>` 与 `zodResolver` 的类型因此对不上。默认值写进 `defaultValues`，schema 里用 `.optional()`。

---

## `strict` 与几条具体口径

- `tsconfig` 开 `strict`（落地方案 W0-1）。禁 `any`（确需时用 `unknown` + 收窄），禁 `@ts-ignore`（用 `@ts-expect-error` 并写原因）。
- **id 在 DTO 层必须是 `string`。** 这是本轮填 spec 时发现、**规格件尚未裁定**的一条：DB 侧 id 是 `bigint` 雪花（修订稿 §12.2），而 JS `Number` 安全整数只到 2^53−1，直接 `JSON.stringify` 会**静默丢精度**（案号对不上、跳错详情）。处置：`shared/schema` 里 id 一律 `z.union([z.string().regex(/^\d+$/)])` 形态出入，服务端序列化时把 `bigint` 转 string。已登记为 master §7.2 **P1-19** 待签字，签字前按本条实现比按"数字"实现更容易改回来。
- `bigint` 只在 `shared/ids` 与服务层内部出现，不进前端组件。
- 时间：`timestamptz` 读出即 UTC ISO 字符串；`date` 列在前端**必须**保持 `YYYY-MM-DD` 字符串，不要 `new Date(...)` 再格式化（会按时区漂一天，修订稿 §12.2 已点名这条最容易错）。
- 金额：`numeric(18,2)` → 前端拿 **string**，展示时才格式化；不做浮点运算（§12.2 禁 `float`）。
- （本条与下一条的**具体形状是本轮新增口径**，规格件未定）`null` vs `undefined`：DB 侧可空列在 DTO 里显式 `nullable()`，不要用可选属性 `?` 含糊掉——`field_diffs` 与审计要能区分"没填"和"填了空"。
- 联合返回：列表接口返回固定形状 `{items, page, pageSize, total}`，不要有的接口返数组有的返对象。
- **外部身份字段不得进 DTO**：`eid`/`openId` 只在 `app_user_external_identity` 与服务端，禁止出现在 `app_user` 或前端可读 DTO（技术选型 §4 末行）。

---

## 未证实项的处理方式

需要第三方库的类型但能力未核（例：N2–N7 涉及的行为；**shadcn 件清单与 react-day-picker 中文 locale 已于 N1 核完**，见 `research-nextjs-stack.md` §6.4）→ 先在 `docs/research-nextjs-stack.md` 补核或跑对应 spike，**不要**先写 `as any` 占位再"回头补"。历史教训：本会话曾把代理域名抓来的结论当已核事实，最终撤回。
