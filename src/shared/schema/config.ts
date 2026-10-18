import { z } from "zod";
import { STATUS_SEMANTICS } from "@/shared/enums/status";
import { HOST_TYPES } from "@/shared/enums/targets";

/**
 * 功能配置的 14 个细项（MATT-101）。
 *
 * ## 为什么这一份住 `shared`
 *
 * `shared/schema/config.ts` 是**前后端同一份形状**（禁令⑧）：`/api/config/[kind]` 的请求/响应、
 * 页面表格的行、新增/编辑弹层的字段，三处读同一个 `ConfigKind` 与同一组 zod schema。
 * 各写一份的失败形态是"前端说没问题、服务端 400"，而两边看起来都对。
 *
 * ## 14 个细项分三档（照票面，别一律给编辑按钮）
 *
 *   · **有可写表（5）**：案件状态 / 事项状态（`mn_status_config` 两个宿主）、风险等级
 *     （`mn_risk_level_config`）、标签（`mn_tag`）、费用项目（`mn_expense_item_config`）
 *     —— 建 CRUD + 弹层；
 *   · **闭集枚举（7）**：数据在 `src/shared/enums/business.ts`，与迁移里的 CHECK 由
 *     `enum-check.spec.ts` 双向核对 —— 页面明写「改动要走迁移」，不建接口、不摆禁用按钮；
 *   · **无承载（2）**：节点通知状态 / 节点通知时间 —— 库里没有存这张映射的表
 *     （通知的存在与参数由 `mn_automation_rule` 的 seed 决定），页面同前档处理。
 *
 * ## `kind` 的两套值域（勘误第 8 条）
 *
 * **页面路由 `/config/[kind]` 的合法值 = 14 个细项**（非法 `kind` → 404）；
 * **接口 `/api/config/[kind]` 的合法值只覆盖 5 个可写的**（其余 kind → 400）。
 * 页面比接口宽，是因为 7 个闭集枚举项与 2 个无承载项**仍有页面**（页面上说明为什么改不了），
 * 但它们不走接口。别按接口的 5 个去收页面。
 */

/**
 * 14 个细项（`kind` 的合法值全集）。
 *
 * ⚠ **两个状态细项的 kind 名是 `case_status` / `item_status`，不是 `matter_status`**：
 * 它们同住 `mn_status_config`，靠 `host_type` 分（`case_status` = matter，
 * `item_status` = risk_matter）。用一个 kind 名指两个宿主会让 `[kind]` 无法表达宿主。
 * 与原型的文件名对照见各 kind 的行注。
 */
export const CONFIG_KINDS = [
  "case_status", // 案件状态（config-matter-status）host_type='matter'
  "item_status", // 事项状态（config-risk-status）host_type='risk_matter'
  "risk_level", // 风险等级（config-risk-level）mn_risk_level_config
  "tag", // 标签（config-tags）mn_tag
  "expense_item", // 费用项目（config-expense-items）mn_expense_item_config
  "case_type", // 案件类型（config-matter-type）闭集枚举
  "procedure", // 案件程序（config-matter-stage）闭集枚举
  "party_type", // 当事人类型（config-party-type）闭集枚举
  "id_type", // 证件类型（config-id-type）闭集枚举
  "litigation_role", // 诉讼地位（config-litigation-position）闭集枚举
  "risk_matter_type", // 事项类型（config-risk-type）闭集枚举
  "node_status", // 节点状态（config-node-status）闭集枚举
  "node_notify_status", // 节点通知状态（config-notify-node-status）无承载
  "node_notify_time", // 节点通知时间（config-notify-node-time）无承载
] as const;
export type ConfigKind = (typeof CONFIG_KINDS)[number];

/** 有可写表的 5 个：只有它们走 `/api/config/[kind]` */
export const WRITABLE_CONFIG_KINDS = [
  "case_status",
  "item_status",
  "risk_level",
  "tag",
  "expense_item",
] as const;
export type WritableConfigKind = (typeof WRITABLE_CONFIG_KINDS)[number];

/** 闭集枚举的 7 个：改动要走迁移 */
export const ENUM_CONFIG_KINDS = [
  "case_type",
  "procedure",
  "party_type",
  "id_type",
  "litigation_role",
  "risk_matter_type",
  "node_status",
] as const;
export type EnumConfigKind = (typeof ENUM_CONFIG_KINDS)[number];

/** 无承载的 2 个：库里没有存这张映射的表 */
export const NO_ENTITY_CONFIG_KINDS = ["node_notify_status", "node_notify_time"] as const;
export type NoEntityConfigKind = (typeof NO_ENTITY_CONFIG_KINDS)[number];

/** 细项名（入口页卡片、细项页抬头都用它；页面上不出现英文 kind） */
export const CONFIG_KIND_LABELS: Record<ConfigKind, string> = {
  case_status: "案件状态",
  item_status: "事项状态",
  risk_level: "风险等级",
  tag: "标签",
  expense_item: "费用项目",
  case_type: "案件类型",
  procedure: "案件程序",
  party_type: "当事人类型",
  id_type: "证件类型",
  litigation_role: "诉讼地位",
  risk_matter_type: "事项类型",
  node_status: "节点状态",
  node_notify_status: "节点通知状态",
  node_notify_time: "节点通知时间",
};

/** 细项 → 处置档（页面据此决定给不给写控件） */
export type ConfigEditMode = "crud" | "enum" | "none";

/** 两个状态细项各自的宿主（`mn_status_config.host_type`）。其余细项无宿主语义 */
const CONFIG_KIND_HOST: Partial<Record<ConfigKind, "matter" | "risk_matter">> = {
  case_status: "matter",
  item_status: "risk_matter",
};

/**
 * 表格列（细项之间形态统一，列集合随细项语义裁剪）。
 * 页面按这一份决定出哪几列，所以"某一列在库里不存在"这件事只有一处会出错。
 */
export type ConfigColumnKey =
  | "seq"
  | "name"
  | "code"
  | "color"
  | "semantics"
  | "host"
  | "notify"
  | "triggerTime"
  | "scope"
  | "status"
  | "actions";

/**
 * 每一列的取舍都以库为准（原型行数据全是编的）：
 *   · **说明**：5 张可写配置表**都没有 `description` 列**（`status_config` / `risk_level_config` /
 *     `tag` / `expense_item_config` 只有 code/name/color/sort_order/is_system/is_enabled）——
 *     所以可写细项**不出说明列**，而不是画一列永远空的。只读的 7 个闭集枚举与 2 个无承载项
 *     也不出它（没有逐值事实可写）——原型的「说明」列没有库里的承载，登记为已知缺口。
 *   · 编码：`mn_tag` 没有 `code` 列（唯一键是「宿主 + 名称」），故标签页不出编码列；
 *   · 颜色：只有 `mn_status_config` 与 `mn_tag` 有 `color` 列（风险等级没有，原型画了）；
 *   · 语义：只有 `mn_status_config` 有 `semantics`。
 */
const CONFIG_KIND_COLUMNS: Record<ConfigKind, readonly ConfigColumnKey[]> = {
  case_status: ["seq", "name", "code", "color", "semantics", "status", "actions"],
  item_status: ["seq", "name", "code", "color", "semantics", "status", "actions"],
  risk_level: ["seq", "name", "code", "status", "actions"],
  tag: ["seq", "name", "color", "host", "status", "actions"],
  expense_item: ["seq", "name", "code", "status", "actions"],
  case_type: ["seq", "name", "code"],
  procedure: ["seq", "name", "code"],
  party_type: ["seq", "name", "code"],
  id_type: ["seq", "name", "code"],
  litigation_role: ["seq", "name", "code"],
  risk_matter_type: ["seq", "name", "code"],
  node_status: ["seq", "name", "code"],
  node_notify_status: ["seq", "name", "notify"],
  node_notify_time: ["seq", "name", "triggerTime", "scope"],
};

const CONFIG_KIND_EDIT: Record<ConfigKind, ConfigEditMode> = {
  case_status: "crud",
  item_status: "crud",
  risk_level: "crud",
  tag: "crud",
  expense_item: "crud",
  case_type: "enum",
  procedure: "enum",
  party_type: "enum",
  id_type: "enum",
  litigation_role: "enum",
  risk_matter_type: "enum",
  node_status: "enum",
  node_notify_status: "none",
  node_notify_time: "none",
};

export type ConfigKindMeta = {
  kind: ConfigKind;
  label: string;
  edit: ConfigEditMode;
  /** 状态细项的宿主；其余细项 `null` */
  host: "matter" | "risk_matter" | null;
  columns: readonly ConfigColumnKey[];
};

/** 细项元数据（页面与接口都用它，避免在页面里再抄一份 kind → 名称/列/档位的映射） */
export const CONFIG_KIND_META: Record<ConfigKind, ConfigKindMeta> = Object.fromEntries(
  CONFIG_KINDS.map((kind) => [
    kind,
    {
      kind,
      label: CONFIG_KIND_LABELS[kind],
      edit: CONFIG_KIND_EDIT[kind],
      host: CONFIG_KIND_HOST[kind] ?? null,
      columns: CONFIG_KIND_COLUMNS[kind],
    },
  ]),
) as Record<ConfigKind, ConfigKindMeta>;

export function isConfigKind(raw: string): raw is ConfigKind {
  return (CONFIG_KINDS as readonly string[]).includes(raw);
}

/** 接口的 kind 合法值只覆盖 5 个可写的 */
export function isWritableConfigKind(raw: string): raw is WritableConfigKind {
  return (WRITABLE_CONFIG_KINDS as readonly string[]).includes(raw);
}

/** 页面路由参数 → 细项；非法值返回 `null`（页面据此 404） */
export function configKindFromParam(raw: string | undefined): ConfigKind | null {
  if (raw === undefined) return null;
  return isConfigKind(raw) ? raw : null;
}

/** 细项页地址（入口页链接与细项页返回都用它，别在页面里手拼字符串） */
export function configKindPath(kind: ConfigKind): string {
  return `/config/${kind}`;
}

/** 功能配置入口页的五张卡片（组名 → 组内细项，照 canon-spec 第 10 节） */
export const CONFIG_GROUPS: readonly { label: string; kinds: readonly ConfigKind[] }[] = [
  { label: "事项配置", kinds: ["risk_matter_type", "item_status", "node_status"] },
  { label: "案件配置", kinds: ["case_type", "procedure", "case_status", "tag", "expense_item"] },
  { label: "当事人配置", kinds: ["party_type", "id_type", "litigation_role"] },
  { label: "风险配置", kinds: ["risk_level"] },
  { label: "通知配置", kinds: ["node_notify_status", "node_notify_time"] },
];

/* ───────────────────────────── 形状 ───────────────────────────── */

/**
 * 编码：seed 里的 code 全是**小写英文 + 下划线**（`pending` / `in_progress` / `court_fee`…），
 * 所以值域按库给（原型画的是 `FILED` 这种大写，属于编的数据）。列宽 varchar(32)。
 * `code` 创建后**不可改**：它是接口与规则的引用键（枚举表 §5.1「code 不可改是既有契约」），
 * 改的只是给人看的 `name`。所以更新 schema 里没有 `code`。
 */
export const configCodeField = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, "编码为小写英文、数字与下划线，且以字母开头");

/** 名称：列宽 varchar(50) */
export const configNameField = z.string().trim().min(1, "名称必填").max(50, "名称最长 50 字符");

/** 颜色：列宽 varchar(20)。库里存的是色名（`slate` / `cobalt`），不是色值 */
export const configColorField = z.string().trim().max(20, "颜色最长 20 字符");

/** 排序：`sort_order` 是整数 */
export const configSortOrderField = z
  .number()
  .int("排序必须是整数")
  .min(0, "排序不能为负")
  .max(9999, "排序最大 9999");

/**
 * 每个可写细项的字段能力（新增与编辑共用；`code` 只在新增时出现）。
 * `hasSemantics` 只对状态为真 —— 语义列只有 `mn_status_config` 有；
 * `needsHost` 只对标签为真 —— `mn_tag.host_type` 是 NOT NULL（一行只能一个宿主）。
 */
export const CONFIG_WRITE_FIELDS: Record<
  WritableConfigKind,
  { needsCode: boolean; hasColor: boolean; hasSemantics: boolean; needsHost: boolean }
> = {
  case_status: { needsCode: true, hasColor: true, hasSemantics: true, needsHost: false },
  item_status: { needsCode: true, hasColor: true, hasSemantics: true, needsHost: false },
  risk_level: { needsCode: true, hasColor: false, hasSemantics: false, needsHost: false },
  tag: { needsCode: false, hasColor: true, hasSemantics: false, needsHost: true },
  expense_item: { needsCode: true, hasColor: false, hasSemantics: false, needsHost: false },
};

/** 标签的宿主（`mn_tag.host_type`，值域同 E08/E10）。一行只能一个宿主，故不是多选 */
export const configHostField = z.enum(HOST_TYPES);

/**
 * 接口吐出的一行（前后端同一份）。
 *
 * `code` 对标签是 `null`（那一列不存在），`semantics` 只有状态表有，`hostType`
 * 只有标签表有（那三张表没有宿主列）。用 `null` 而不是省略字段：一个"有列但本细项不适用"
 * 与"这一行忘了填"在 JSON 里必须区分得开，否则页面会以为自己在读一个残缺的行。
 */
export type ConfigItem = {
  id: string;
  code: string | null;
  name: string;
  color: string;
  sortOrder: number;
  isEnabled: boolean;
  semantics: string | null;
  /** `mn_status_config.is_initial_status`：页面据此标出「初始态」（它不可停用） */
  isInitialStatus: boolean;
  /** seed 内置：可改名/改色/排序/停用，**不可删**（本票也不提供删除） */
  isSystem: boolean;
  /** 标签专有：这一行适用哪类宿主（一行只能一个宿主） */
  hostType: string | null;
};

export const configItemSchema: z.ZodType<ConfigItem> = z.object({
  id: z.string(),
  code: z.string().nullable(),
  name: z.string(),
  color: z.string(),
  sortOrder: z.number().int(),
  isEnabled: z.boolean(),
  semantics: z.string().nullable(),
  isInitialStatus: z.boolean(),
  isSystem: z.boolean(),
  hostType: z.string().nullable(),
});

/**
 * 新增入参。字段按细项**动态裁剪**：标签页没有编码、风险等级没有颜色与语义 ——
 * 给一个不存在的列塞值，落库时才报错，而错误已经是"列不存在"这类不可读的形态。
 *
 * `semantics` **不在新增里**：新建状态只能给 `custom`（E09 口径，`ASSIGNABLE_SEMANTICS`
 * 只有 `custom` 一项），四个内置语义由 seed 持有、不可授予。服务层直接给 `custom`，
 * 于是"新建状态撞上三条硬约束"在源头就不可能发生。
 */
export function configCreateSchema(kind: WritableConfigKind) {
  const f = CONFIG_WRITE_FIELDS[kind];
  const shape: Record<string, z.ZodTypeAny> = {
    name: configNameField,
    sortOrder: configSortOrderField.default(0),
    isEnabled: z.boolean().default(true),
  };
  if (f.needsCode) shape.code = configCodeField;
  if (f.hasColor) shape.color = configColorField.default("");
  if (f.needsHost) shape.hostType = configHostField;
  return z.object(shape).strict();
}

/** 编辑入参（**不含 `code`**：code 创建后不可改） */
export function configUpdateSchema(kind: WritableConfigKind) {
  const f = CONFIG_WRITE_FIELDS[kind];
  const shape: Record<string, z.ZodTypeAny> = {
    name: configNameField.optional(),
    sortOrder: configSortOrderField.optional(),
    isEnabled: z.boolean().optional(),
  };
  if (f.hasColor) shape.color = configColorField.optional();
  if (f.hasSemantics) shape.semantics = z.enum(STATUS_SEMANTICS).optional();
  if (f.needsHost) shape.hostType = configHostField.optional();
  return z.object(shape).strict();
}

/**
 * 更新请求体：`id`（改哪一行）+ 上面那份字段。
 *
 * `id` 走 body 而不是路径（同一细项下"改哪一行"是数据，不是资源层级），
 * 所以上界与 `http.ts:pathId` 同（19 位）—— 见 `batch.ts` 的同一条注释。
 */
export function configUpdateBodySchema(kind: WritableConfigKind) {
  return configUpdateSchema(kind).extend({
    id: z.string().regex(/^\d{1,19}$/, "id 必须是数字字符串"),
  });
}
