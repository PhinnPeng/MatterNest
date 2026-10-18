import {
  CONFIG_KIND_LABELS,
  configCreateSchema,
  configUpdateBodySchema,
  isWritableConfigKind,
  type WritableConfigKind,
} from "@/shared/schema/config";
import { body, fail, json, notFound, requirePrivilege, withActor } from "@/app/lib/server/http";
import {
  createConfigItem,
  listConfigItems,
  updateConfigItem,
  type ConfigWriteRejection,
} from "@/app/lib/server/services/config";

/**
 * 功能配置的可写细项（MATT-101）。
 *
 * ## `kind` 的两套值域（勘误第 8 条）
 *
 * 页面路由 `/config/[kind]` 收 14 个细项，**本接口只收 5 个可写的**（`WRITABLE_CONFIG_KINDS`）。
 * 7 个闭集枚举项与 2 个无承载项没有写路径，所以它们的 kind 到这里是**非法入参 → 400**
 * （不是 404）：404 的语义是"这条记录不可见或不存在"（权限草案 §1 元规则 3），
 * 而"这个 kind 不支持写"是请求本身不合法，两者混用会把"前端漏了个判断"伪装成"资源被收窄"。
 *
 * ## 权限门：读登录即可，写要 `canManageConfig`
 *
 * 与 `/api/meta`（登录即可读配置，供所有下拉）同一条口径，也与费用那侧
 * （`expenses.ts`：「配置写要 can_manage_config，读不需要」）一致 —— 细项页要显示
 * **含停用的行**，而停用行不出现在 `/api/meta` 的下拉里，所以管理页有独立的读出口。
 * 写路径三道门前各用 `requirePrivilege(actor, "canManageConfig", "管理配置")`。
 *
 * ⚠ 这是全仓**第一次**真正使用 `canManageConfig`：此前它只出现在用户管理页的角色列
 * （`users-view.tsx` 的「可管配置」）与 schema 里，`config-view.tsx` 的文件头注还写着
 * "一期不做配置编辑（can_manage_config 目前只用于读）"——那句已随本票改成事实。
 *
 * ## 405 的取舍
 *
 * 未支持的细项（闭集枚举 / 无承载）在 GET 上给 **200 + 一行说明 + 空表**
 * （页面仍要打开并解释为什么改不了），但在写方法上给 400 的 `not_writable`。
 * 页面读的是同一份数据，差别只在能不能写。
 */

type Ctx = { params: Promise<{ kind: string }> };

/** 5 个可写细项才进得来；其余 kind → 400（不是 404，见头注） */
function resolveKind(
  raw: string,
): { ok: true; kind: WritableConfigKind } | { ok: false; res: ReturnType<typeof fail> } {
  if (!isWritableConfigKind(raw)) {
    return {
      ok: false,
      res: fail(
        400,
        "not_writable",
        `「${CONFIG_KIND_LABELS[raw as keyof typeof CONFIG_KIND_LABELS] ?? raw}」没有可写表，改动要走迁移`,
      ),
    };
  }
  return { ok: true, kind: raw };
}

/** GET：一个细项的全部行（含停用）。登录即可读 —— 与 `/api/meta` 同档 */
export async function GET(_req: Request, ctx: Ctx) {
  const { kind } = await ctx.params;
  const resolved = resolveKind(kind);
  if (!resolved.ok) return resolved.res;
  return withActor(async () => {
    const items = await listConfigItems(resolved.kind);
    return json({ kind: resolved.kind, items });
  });
}

/** POST：新增一行。写门 `canManageConfig` */
export async function POST(req: Request, ctx: Ctx) {
  const { kind } = await ctx.params;
  const resolved = resolveKind(kind);
  if (!resolved.ok) return resolved.res;
  const parsed = await body(req, configCreateSchema(resolved.kind));
  if (!parsed.ok) return parsed.res;

  return withActor(async (actor) => {
    const denied = requirePrivilege(actor, "canManageConfig", "管理配置");
    if (denied) return denied;
    const r = await createConfigItem(resolved.kind, parsed.data as Record<string, unknown>);
    if (r.ok) return json({ ok: true, id: r.id }, 201);
    return reject(r);
  });
}

/** PATCH：改一行（`id` 在 body；`code` 不可改，不在入参里）。写门 `canManageConfig` */
export async function PATCH(req: Request, ctx: Ctx) {
  const { kind } = await ctx.params;
  const resolved = resolveKind(kind);
  if (!resolved.ok) return resolved.res;
  const parsed = await body(req, configUpdateBodySchema(resolved.kind));
  if (!parsed.ok) return parsed.res;

  return withActor(async (actor) => {
    const denied = requirePrivilege(actor, "canManageConfig", "管理配置");
    if (denied) return denied;
    const r = await updateConfigItem(
      resolved.kind,
      parsed.data as Record<string, unknown> & { id: string },
    );
    if (r.ok) return json({ ok: true, id: r.id });
    return reject(r);
  });
}

/**
 * 服务层拒绝理由 → HTTP。
 *
 * 三档分开（不是一律 422）：
 *   · `not_found` → 404 走 `notFound()`（唯一出口，禁令：手写 fail(404) 被 lint-guard 拦）；
 *   · `duplicate_code` / `duplicate_name` / `semantics_taken` → **409**：请求本身合法，
 *     是与库中已有状态的冲突，用户改个编码再试即可；
 *   · 三条硬约束（`rule_referenced` / `initial_status` / `archived_status`）→ **422**：
 *     它回答"为什么这个值不能这样改"，可能随配置变化而变（规则可停用、语义可再调）。
 */
function reject(r: ConfigWriteRejection) {
  switch (r.why) {
    case "not_found":
      return notFound();
    case "duplicate_code":
      return fail(409, "duplicate_code", `编码「${r.code}」已被占用`);
    case "duplicate_name":
      return fail(409, "duplicate_name", `名称「${r.name}」在该宿主下已存在`);
    case "semantics_taken":
      return fail(409, "semantics_taken", `这个宿主已经有一个「${r.semantics}」语义的状态了`);
    case "rule_referenced":
      return fail(
        422,
        "rule_referenced",
        `这条状态被启用中的自动化规则引用（${r.ruleCodes.join("、")}），停用会让规则永远不触发。请先停用那些规则`,
      );
    case "initial_status":
      return fail(422, "initial_status", "初始态是新建记录要用到的状态，不能停用");
    case "archived_status":
      return fail(422, "archived_status", "归档态是归档流程要用到的状态，不能停用");
  }
}
