import { z } from "zod";

/**
 * 账号与角色管理的请求形状（MATT-10 / F6-1、F6-5、F6-9、F6-11）。
 *
 * 放 `src/shared/schema/` 而不是写在各路由里：前后端共用同一道门（本仓禁令⑧的
 * "校验规则单源"），界面的即时提示也从这里经 `rulesFor` 推导。
 *
 * `.strict()` 不是洁癖：zod 默认**静默剥离**未声明字段。若请求里带了 `isAdmin` 之类的
 * 提权字段，默认形态会把它悄悄丢掉——用户以为设了、实际没进库；显式拒才能让它在联调时就红。
 * （同 `convertSchema` 里那段注释的理由。）
 */

/** 数字字符串 id（与 `hosts.ts` 的 `idField` 同形；两边都是"DTO 出 string，P1-19"） */
const idField = (label: string) => z.string().regex(/^\d+$/, `${label}必须是数字字符串`);

/**
 * 一次授予的**角色集合**（整体替换语义）。
 *
 * 上限 10 与 `mn_role` 的规模无关，是防"一次提交几千个 id 把校验变成 DoS 面"；
 * 5 个内置角色的现实下这个上限不会被触到。
 * `min(0)` 是**故意允许空**：撤掉某人的全部角色是合法动作（那人随后登录会拿到 401，
 * 因为 `readActor` 对无角色者返回 null）——但界面必须把这件事说清楚，不能让人静默失权。
 */
export const userRolesSchema = z
  .object({
    roleIds: z.array(idField("角色")).max(10, "一次最多授予 10 个角色"),
  })
  .strict();

/** 账号启停（F6-1）。只收布尔，不收"顺便改点别的"——启停就该只有这一个自由度 */
export const userEnabledSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

/**
 * 本地凭据设置/重置（F6-9）。
 *
 * 下限 8 位，**不做复杂度规则**：十人内部工具，复杂度规则换来的是贴在显示器上的便签；
 * 真正压住风险的是"只有系统所有者能设"与"摘要不进日志"。
 * 上限 128 是防超长输入拖垮 scrypt（它是 CPU 密集的，长度直接进成本）。
 */
export const userCredentialSchema = z
  .object({
    password: z.string().min(8, "口令至少 8 位").max(128, "口令别超过 128 位"),
  })
  .strict();

/** 批准待开通（F6-11）：开通与"当场指定角色"是同一件事，所以同一次请求里给 */
export const userApproveSchema = z
  .object({
    roleIds: z.array(idField("角色")).min(1, "批准时必须至少指定一个角色").max(10),
  })
  .strict();

export type UserRolesInput = z.infer<typeof userRolesSchema>;
export type UserEnabledInput = z.infer<typeof userEnabledSchema>;
export type UserCredentialInput = z.infer<typeof userCredentialSchema>;
export type UserApproveInput = z.infer<typeof userApproveSchema>;

/**
 * 给已有宿主加参与人（MATT-49 / 权限草案 §6）。
 *
 * `staffRole` **只收 `co_owner` 与 `follower`**：`owner` 有自己的路（字段编辑 + `OWNER_CHANGED`），
 * 从这里再开一条就会出现"两条路到同一状态、其中一条不写审计"。
 * 值域在 schema 就钉死，不留给服务层兜——前端也拿同一个枚举渲染下拉（禁令⑧ 单源）。
 */
export const staffAddSchema = z
  .object({
    userIds: z.array(idField("用户")).min(1, "至少选一个人").max(20, "一次最多加 20 个人"),
    staffRole: z.enum(["co_owner", "follower"], { message: "只能加协办或关注人" }),
  })
  .strict();

export type StaffAddInput = z.infer<typeof staffAddSchema>;
