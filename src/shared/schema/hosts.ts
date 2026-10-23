import { z } from "zod";
import { PROGRESS_TYPES } from "@/shared/enums/business";
import { commentAttachmentIdsSchema } from "./attachments";
import {
  CASE_TYPES,
  ID_TYPES,
  LITIGATION_ROLES,
  PARTY_TYPES,
  PROCEDURES,
  RISK_MATTER_SOURCES,
  RISK_MATTER_TYPES,
} from "@/shared/enums/business";

/**
 * 宿主相关的 DTO（技术选型 §4「校验/契约」行：一处定义 → DTO 校验、表单规则、OpenAPI 三方复用）。
 *
 * 三条约定来自 N7 spike 的实测，不是偏好：
 *   · **id 一律 `string`**（master P1-19）：64 位雪花进 JS `number` 会静默丢低位，
 *     所以校验层就拒绝数字形态，报错发生在入口而不是"案号对不上"的现场；
 *   · **表单 schema 不用 `.default()`**：Zod 的 `.default()` 会让 input/output 类型不一致，
 *     直接把 react-hook-form 的 resolver 类型打断；默认值放 `defaultValues`；
 *   · 枚举值域引自 `@/shared/enums`，与迁移里的 `CHECK` 由 `enum-check.spec.ts` 保证同源，
 *     所以这里拒绝的值 DB 也一定拒绝，反之亦然 —— 不会出现"前端能选、后端 500"。
 */

/** 数据库 `bigint` 对外只有 string 一种形态；DDL 侧另有 CHECK 挡格式 */
const idField = (label: string) => z.string().regex(/^\d+$/, `${label}必须是数字字符串`);

/**
 * 一行当事人挂接（F2-15「关联 + 快速新增」）。案件与事项**共用同一个定义**。
 *
 * 为什么抽出来而不是各写一份：两条宿主线的写入都走 `planPartyLinks`，
 * 值域一旦漂移就会出现"案件侧能填某角色、事项侧填不了"的错位，
 * 而这种错位在代码里长得一模一样，只有用户撞上才知道。
 *
 * 两种写法并存：
 *   · 带 `partyId` —— 引用库里已登记的这一行，不新建；
 *   · 不带 `partyId` —— 快速新增，此时名称与类型必填（由 `superRefine` 保证，
 *     字段本身放宽成可选，是为了让"缺什么"报在**当事人那一行**上，而不是笼统一条 enum 失败）。
 * 服务端还会在 `(type, id_number)` 精确命中时自动复用既有行，见 `services/parties.ts`。
 */
export const partyLinkSchema = z
  .object({
    partyId: idField("当事人").optional().or(z.literal("")),
    name: z.string().trim().max(200).optional().or(z.literal("")),
    type: z.enum(PARTY_TYPES).optional().or(z.literal("")),
    /** E06 复用 E12 诉讼地位取值 —— 事项侧与案件侧同一套，不另立值域 */
    partyRole: z.enum(LITIGATION_ROLES, { message: "请选择诉讼地位" }),
    /** ⚠ E07 `represented` 已随 IQ-15 软作废，不再进入 DTO；我方立场看案件的 `litigation_role` */
    idType: z.enum(ID_TYPES).optional().or(z.literal("")),
    idNumber: z.string().trim().max(64).optional().or(z.literal("")),
  })
  .superRefine((p, ctx) => {
    if (p.partyId) return;
    if (!p.name || p.name.trim().length < 2)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["name"],
        message: "新建当事人要填名称（至少 2 个字），或改成选择已登记的当事人",
      });
    if (!p.type)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["type"],
        message: "请选择当事人类型（它决定证件号的校验规则）",
      });
  });

export type PartyLinkInput = z.input<typeof partyLinkSchema>;

export const matterCreateSchema = z.object({
  name: z.string().trim().min(2, "请输入案件名称").max(200),
  cause: z.string().trim().min(2, "请输入案由").max(200),
  caseType: z.enum(CASE_TYPES, { message: "请选择案件类型" }),
  procedure: z.enum(PROCEDURES, { message: "请选择审级/程序" }),
  litigationRole: z.enum(LITIGATION_ROLES, { message: "请选择诉讼地位" }),
  court: z.string().trim().max(200).optional().or(z.literal("")),
  level: z.string().trim().min(1, "请选择风险等级").max(32),
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, "金额最多两位小数")
    .optional()
    .or(z.literal("")),
  caseNo: z.string().trim().max(100).optional().or(z.literal("")),
  filingDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "立案日期格式为 YYYY-MM-DD")
    .optional()
    .or(z.literal("")),
  description: z.string().trim().max(5000).optional().or(z.literal("")),
  ownerId: idField("负责人").optional(),
  /**
   * 创建时的关注人（IQ-5：处理人与关注人在表单上可选填）。
   *
   * 走 **IQ-14 的创建期例外**：全体在册且已开通的用户，不受 §4.1 共现集限制
   * （首次上报的业务同事共现集为空，不放开的话这个字段对新上报人根本不可用）。
   * 但"在册可用"这条不免——服务层用 `assertAssignable` 真的跑一遍，不靠下拉挡。
   */
  followerIds: z.array(idField("关注人")).max(20).optional(),
  /** 当事人区。定义见 `partyLinkSchema` —— 案件与事项同源，两条线共用一套值域与校验 */
  parties: z.array(partyLinkSchema).default([]),
});
export type MatterCreateInput = z.input<typeof matterCreateSchema>;

/**
 * 案件主表字段的**行内编辑**（2026-10-22 用户要求：列表里点单元格直接改经办人 / 程序）。
 *
 * 只收两个可逆、无副作用的字段：
 *   · `ownerId` —— 变更处理人，记 `OWNER_CHANGED`（GLOSSARY：它是普通字段编辑，不新造动作）；
 *   · `procedure` —— 程序/审级，记 `MATTER_UPDATED`。
 *
 * **状态不在这里**：它有自己的 `/api/matters/{id}/status`（要归档就绪、要原因、要特权判定）。
 * 把状态并进这条通用编辑就等于把那三件事分到两处判。
 *
 * `.strict()`：键名拼错在 400 上暴露，而不是被 zod 剥掉、回一句"改成功了"。
 * `ownerId` **不可空**：案件必有负责人（IQ-6），与事项侧 `null = 退回未指派` 正好相反。
 */
export const matterPatchSchema = z
  .object({
    ownerId: idField("负责人").optional(),
    procedure: z.enum(PROCEDURES, { message: "请选择审级/程序" }).optional(),
  })
  .strict();
export type MatterPatchInput = z.infer<typeof matterPatchSchema>;

export const riskCreateSchema = z.object({
  name: z.string().trim().min(2, "请输入事项名称").max(200),
  type: z.enum(RISK_MATTER_TYPES, { message: "请选择风险类型" }),
  level: z.string().trim().min(1, "请选择风险等级").max(32),
  source: z.enum(RISK_MATTER_SOURCES).optional().or(z.literal("")),
  description: z.string().trim().min(2, "请填写描述").max(5000),
  /**
   * 「预估影响」与「已采取措施」两栏已于 2026-10-22 从事项侧整体撤下（表单、列表、
   * 详情、导入导出、搜索、转案件对账到库列一条链），所以这里**没有**对应字段：
   * 事项的金额敞口由费用台账承载，处置过程由处置记录承载。
   */
  discoverDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "发现日期格式为 YYYY-MM-DD")
    .optional()
    .or(z.literal("")),
  /**
   * 负责人。**可为 null**：事项侧"未指派处理人"是一等状态（IQ-5），
   * 新建时允许先不指派、改派时也允许退回未指派。
   * `.optional()`（可省略）与 `.nullable()`（可为 null）是两件事，
   * 少了后者，提交 `ownerId: null` 会被判 422。
   */
  ownerId: idField("负责人").nullable().optional(),
  /** 创建时的关注人；与案件侧同源同规则，见 `matterCreateSchema` 上那条注释 */
  followerIds: z.array(idField("关注人")).max(20).optional(),
  /**
   * 当事人区。**这是转案件能走通的前提**——`convertToCase` 的前置是"事项至少 1 个当事人"，
   * 而在本字段出现之前 `riskMatterParty` 全仓只有读没有写，所以任何走 UI 建的事项
   * 必然当事人=0，转案件必然 422 `parties_required`，而那条 422 正在叫用户
   * 「请先在事项上添加再转」——**那个入口当时不存在**。
   *
   * 与案件侧共用 `partyLinkSchema`：两条宿主线的值域、校验、快速新增与
   * `(type, id_number)` 去重全部同一条代码路径。
   */
  parties: z.array(partyLinkSchema).default([]),
});
export type RiskCreateInput = z.input<typeof riskCreateSchema>;

/**
 * 建事项后**追加**当事人（`POST /api/risk-matters/[id]/parties`）。
 *
 * 与建事项那次走同一个 `partyLinkSchema`，所以"建的时候没填也能事后补"这件事
 * 在校验口径上与"建的时候填"完全一致——不然会出现两条路径对同一份数据给出不同结论。
 */
export const riskPartyAppendSchema = z
  .object({
    parties: z
      .array(partyLinkSchema)
      .min(1, "至少添加一个当事人")
      .max(20, "一次最多添加 20 个当事人"),
  })
  .strict();

/** 转案件：**一次提交 N 张案件卡**（映射矩阵 §1 基数 1→N，N ≥ 1，可追加） */
export const convertCardSchema = matterCreateSchema
  .omit({
    parties: true, // 当事人从事项侧**引用**同一批 party 行，不随卡传（映射矩阵 §2.6）
    description: true, // 描述不复制，改引用来源（§2.5）
    ownerId: true, // 经办人从事项 owner 继承默认值，可逐案改（§2.2）
  })
  // 内层也要 strict：`.omit()` 出来的是普通对象 schema，zod 默认静默剥离未知键。
  // 不加的话 `description` 会被无声丢掉——正是「描述不复制」要防的"以为带过去了"。
  .strict();

export type ConvertCard = z.infer<typeof convertCardSchema>;

/**
 * 跨卡复制的**白名单**（MATT-19 / 矩阵 §3）。
 *
 * **为什么是白名单而不是"spread 一下再删掉案号"**：黑名单会随字段增长而漏——
 * 将来给案件卡加一个新字段（比如"保全金额"），黑名单写法会**默认把它复制过去**，
 * 而新字段是不是 id 类只有加字段的人知道。白名单反过来：新字段默认不复制，
 * 漏了当场就能在表单上看见（"我填了怎么没带过去"比"案号被悄悄抄了"好查得多）。
 *
 * 这也是前端 spec 点名的口径（`component-guidelines.md`：跨卡复制用白名单
 * `COPYABLE_FIELDS`，不是靠约定）。
 * ⚠ 仓库里另有一份 `shared/schema/convert-form.ts` 是 N7 spike 的遗留模块
 * （**无生产代码引用**，只有它自己的 spec 在跑），那里的同名常量对不上活表单的
 * 字段名，别照抄它。
 */
export const CONVERT_CARD_COPYABLE_FIELDS = [
  "name",
  "cause",
  "caseType",
  "procedure",
  "litigationRole",
  "court",
  "level",
  "amount",
  "filingDate",
] as const;

/**
 * 明确**不参与**复制的字段。列出来是为了让测试能断言「白名单 ∩ 黑名单 = ∅」——
 * 少了这条断言，"两边都写了同一个字段"会静默按实现顺序决定结果。
 *
 * 本表单里只有案号与关注人：
 *  · `caseNo` 是 id 类。把一张的案号抄给 N 张，就是给 N 个案卷安同一个法院案号；
 *    库层「非唯一、重复只提示不阻止」是给「不同法院案号体系重号」留的口子（§6.3），
 *    不是给「复制粘贴批量重号」用的。
 *  · 内部编号不在卡里（服务端事务内取号），事项外键也不在卡里（路由从 URL 拿）。
 *  · `followerIds`（MATT-49 加）是**人**：关注谁是逐案成立的判断，不是"这批案卷共享的事实"。
 *    复制过去等于一次点击静默地把同一批人加进 N 个案卷——而"把谁加进案卷"是 §4.1 管的事，
 *    用户没有对它做过决定。白名单默认不复制，但**"默认"要写下来才算数**（这条断言就是干这个的）。
 */
export const CONVERT_CARD_NON_COPYABLE_FIELDS = ["caseNo", "followerIds"] as const;

/**
 * 跨卡复制：只搬白名单字段（矩阵 §3）。写成函数而不是在组件里 spread，
 * 是为了让「复制不带走 id」这件事**可测**（单测 + 浏览器探针各一条）。
 * 目标卡**自己的案号不清空**：排除的语义是"不抄过来"，不是"抹掉你原来填的"。
 */
export function copyConvertCard<T extends Record<string, unknown>>(source: T, target: T): T {
  const picked: Record<string, unknown> = {};
  for (const f of CONVERT_CARD_COPYABLE_FIELDS) {
    if (f in source) picked[f] = source[f];
  }
  return { ...target, ...picked } as T;
}

/**
 * 转案件请求：`cases` 是数组。
 *
 * 两处口径与旧版不同，都是规格要求的：
 *  · `amount` **不再 omit**——映射矩阵 §2.4 说"留空逐案填"，是**允许填**而不是禁止填。
 *    之前整列 omit 掉，等于把"金额不继承"错做成"金额不能填"。
 *  · `caseNo` **不再 omit**——§6.3 说案号默认取内部编号、**可改**、非唯一。
 *
 * 上限 20 与 `MAX_CASES_PER_CONVERT` 同源，两处都改。
 */
export const convertSchema = z
  .object({
    cases: z.array(convertCardSchema).min(1, "至少建一个案件").max(20, "一次最多转 20 个案件"),
  })
  // `.strict()` 不是洁癖：zod 默认**静默剥离**未声明字段。若转案件请求里带了
  // `description`（或任何被 omit 的列），默认形态会把它悄悄丢掉——用户以为填了、
  // 实际没进库，而「描述不继承」要防的恰恰是这种"以为带过去了"。
  // 显式拒才能让它在联调时就红。
  .strict();

/**
 * 撤销转案件关联（修订稿 §3.4 / 映射矩阵 §5.1）。
 *
 * `reason` 在 schema 就 `.min(1)`，不是留给服务层兜：枚举表 §3.2 把 `UNCONVERT`
 * 列为**原因必填**，而 schema 是前后端共用的同一道门——放服务层就意味着前端
 * 能让用户空着提交、再靠一次 422 才发现。
 */
export const unconvertSchema = z
  .object({
    caseId: idField("案件"),
    reason: z.string().trim().min(1, "撤销必须填原因").max(500, "原因别超过 500 字"),
  })
  .strict();

export type UnconvertInput = z.infer<typeof unconvertSchema>;

export const statusChangeSchema = z.object({
  to: z.string().trim().min(1, "请选择目标状态").max(32),
  /**
   * 「什么时候必须填」由 `shared/schema/status-transition.ts` 的 `needsChangeReason` 判
   * —— 前后端同一个谓词，前端据此决定要不要把原因输入框亮出来，服务层据此拒收。
   * 这里只管长度；配置表可以随时改 `next_status_codes`，写死在 DTO 里就是第二次定义一遍配置。
   */
  reason: z.string().trim().max(500).optional().or(z.literal("")),
});

export const commentSchema = z.object({
  body: z.string().trim().min(1, "评论不能为空").max(2000),
  parentId: idField("父评论").optional().or(z.literal("")),
  /** §7.1 / §1.7：评论的附件——只收服务端发过的草稿 id（见 `schema/attachments.ts`） */
  attachments: commentAttachmentIdsSchema,
});

export const nodeStatusSchema = z.object({
  /**
   * 2026-10-23 起节点只有三态。`pending` / `confirm_time` 两条命令随三态一起撤掉：
   * 时间不再是"待定/已确认"的第二根轴，而是节点自己的一个必填字段（编辑时随时可改）。
   * 真要在这条老数据上回退，去 `is_time_confirmed` 那一列，不要再走这个端点。
   */
  status: z.enum(["in_progress", "completed", "cancelled"]),
  cancelReason: z.string().trim().max(200).optional().or(z.literal("")),
});

/**
 * 当事人检索（建案下拉的数据源）。`min(1)` 是刻意的：空关键字等于"把全公司当事人都列出来"，
 * 而 §7.2 的可见性只保证"我相关的那些"，一次全量列举仍然是一个枚举探测面。
 */
export const partySearchSchema = z.object({
  q: z.string().trim().min(1, "请输入至少一个字").max(40),
});

export const loginSchema = z.object({
  // `.max()` 的文案必须显式给：zod 默认是英文 `Too big: expected string to have <=64 characters`，
  // 而这两个字段是登录页唯一的输入，超长字符串会原样渲染进中文界面。
  username: z.string().trim().min(2, "请输入账号").max(64, "账号最多 64 个字符"),
  password: z.string().min(1, "请输入密码").max(200, "密码最多 200 个字符"),
});
/** 表单侧一律用 `z.input`（见本文件顶部第三条约定：不用 `.default()`，避免 input/output 类型分裂） */
export type LoginInput = z.input<typeof loginSchema>;

/** 空串 → undefined：让"未填"与"填了空"在服务层走同一条路，避免两处各判一次 */

export function pruneEmpty<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o))
    out[k] = typeof v === "string" && v === "" ? undefined : v;
  return out as T;
}

/**
 * 写一条案件进展（MATT-59）。
 *
 * ## 为什么这个文件里只补一个 schema
 *
 * 查证：`PROGRESS_TYPES` / `PROGRESS_TYPE_LABELS` 早在 `@/shared/enums/business`（E19），
 * `matterProgress` 的 drizzle model 早在 `db/schema/hosts.ts:372`，`AUDIT_ACTIONS` 里有
 * `PROGRESS_CREATED/UPDATED/DELETED`，`TARGET_TYPES` 里有 `matter_progress`，
 * 库里 CHECK 与两个索引也齐 —— **五处都就位，只差一条能写进去的路**。
 *
 * 本文件一度又造了一份 `PROGRESS_TYPES`，那是纯重复（两份会漂），已删。
 * 这里只留**载荷校验**：
 *
 * · `progressType` 直接用 E19 的值域（库里的 CHECK 是权威源，`progress.spec.ts`
 *   把两边逐字比对，加值或改名漏了任何一处都当场红）
 *
 * · `progressDate` 收 ISO 日期串（`YYYY-MM-DD`）而不是瞬时 —— 它是 `date` 列，
 *   传瞬时会被 Postgres 按会话时区截断，而这条日期是「进展发生在哪一天」的事实。
 *   `2026/10/15` 这类格式也被拒：date 列会静默收下它，事后没人知道是哪一天。
 *
 * · `content` 不许为空 —— 空进展会让 `last_progress_at` 说谎：它前进了，
 *   而「30 天无更新」（规则 4）的基准就是那一列。
 */
export const progressSchema = z.object({
  progressType: z.enum(PROGRESS_TYPES),
  content: z.string().trim().min(1, "进展内容不能为空").max(4000),
  progressDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "进展日期必须是 YYYY-MM-DD"),
  nextPlan: z.string().trim().max(2000).optional().or(z.literal("")),
  nodeId: idField("节点").optional().or(z.literal("")),
});

/** 表单侧一律用 `z.input`（见本文件顶部约定） */
export type ProgressInput = z.input<typeof progressSchema>;
