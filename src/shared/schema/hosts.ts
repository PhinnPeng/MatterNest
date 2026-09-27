import { z } from "zod";
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
  ownerId: idField("承办人").optional(),
  parties: z
    .array(
      z.object({
        name: z.string().trim().min(2, "请输入当事人名称").max(200),
        type: z.enum(PARTY_TYPES, { message: "请选择当事人类型" }),
        partyRole: z.enum(LITIGATION_ROLES, { message: "请选择诉讼地位" }),
        represented: z.boolean(),
        idType: z.enum(ID_TYPES).optional().or(z.literal("")),
        idNumber: z.string().trim().max(64).optional().or(z.literal("")),
      }),
    )
    .default([]),
});
export type MatterCreateInput = z.input<typeof matterCreateSchema>;

export const riskCreateSchema = z.object({
  name: z.string().trim().min(2, "请输入事项名称").max(200),
  type: z.enum(RISK_MATTER_TYPES, { message: "请选择风险类型" }),
  level: z.string().trim().min(1, "请选择风险等级").max(32),
  source: z.enum(RISK_MATTER_SOURCES).optional().or(z.literal("")),
  description: z.string().trim().min(2, "请填写风险描述").max(5000),
  measure: z.string().trim().max(5000).optional().or(z.literal("")),
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, "金额最多两位小数")
    .optional()
    .or(z.literal("")),
  discoverDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "发现日期格式为 YYYY-MM-DD")
    .optional()
    .or(z.literal("")),
  ownerId: idField("负责人").optional(),
});
export type RiskCreateInput = z.input<typeof riskCreateSchema>;

/** 转案件：只填案件侧必填项，金额**不继承**（master P0-1 以映射矩阵为准） */
export const convertSchema = matterCreateSchema.omit({
  parties: true,
  caseNo: true,
  amount: true,
  description: true,
  ownerId: true,
});

export const statusChangeSchema = z.object({
  to: z.string().trim().min(1, "请选择目标状态").max(32),
  /** 归档/结案必填由服务层判（它才知道目标态的 semantics），这里只管长度 */
  reason: z.string().trim().max(500).optional().or(z.literal("")),
});

export const commentSchema = z.object({
  body: z.string().trim().min(1, "评论不能为空").max(2000),
  parentId: idField("父评论").optional().or(z.literal("")),
});

export const nodeStatusSchema = z.object({
  status: z.enum(["not_started", "in_progress", "completed", "cancelled"]),
  cancelReason: z.string().trim().max(200).optional().or(z.literal("")),
});

export const loginSchema = z.object({
  username: z.string().trim().min(2, "请输入账号").max(64),
  password: z.string().min(1, "请输入口令").max(200),
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
