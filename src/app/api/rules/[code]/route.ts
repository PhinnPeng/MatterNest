import { z } from "zod";
import { NOTIFY_RECEIVERS } from "@/shared/enums/automation";
import { body, fail, json, notFound, requirePrivilege, withActor } from "@/app/lib/server/http";
import { updateRule, type RuleWriteRejection } from "@/app/lib/server/services/rule-admin";

/**
 * 自动化规则（P12）：列表 + 启停/调参（F5-7 · F5-10，2026-10-18）。
 *
 * ## 为什么没有 POST / DELETE
 *
 * F5-8/F5-9（新建规则）随 IQ-9 移出一期；`is_system = true` 的规则**不可删**
 * （F5-10 原话）。所以这组接口只有 GET 与 PATCH —— 缺的两个方法不是"还没写"，
 * 是一期不做。`DELETE` 故意不挂：挂一个恒 405 的处理器会让"不可删"看起来像实现细节。
 *
 * ## 权限门：读登录即可，写要 `canManageConfig`
 *
 * 与 `/api/config/[kind]`、`/api/meta` 同档。理由也一样：知道"系统会自动做什么"
 * 不该有门槛（它影响人怎么操作），改才是特权。
 *
 * ## `code` 是路径参数，不是 `id`
 *
 * `code` 是 seed 的幂等锚、跨环境重放的唯一前提（§2.4 末行），也是两个扫描器认领
 * 自己那条规则的依据。用 id 会让「本机的 8004」与「别人的 8004」看起来是同一条。
 */
type Ctx = { params: Promise<{ code: string }> };

/** PATCH 入参：**只有两个键**。改 trigger / 删规则在类型层不可表达（F5-10） */
const patchSchema = z
  .object({
    isEnabled: z.boolean().optional(),
    /** 收件人档位；只对"动作是 notify"的规则有意义（服务层判，见 `updateRule`） */
    receivers: z.array(z.enum(NOTIFY_RECEIVERS)).min(1).optional(),
  })
  .refine((v) => v.isEnabled !== undefined || v.receivers !== undefined, {
    message: "没有要改的字段",
  });

/** PATCH：改一条（`code` 在路径上）。写门 `canManageConfig` */
export async function PATCH(req: Request, ctx: Ctx) {
  const { code } = await ctx.params;
  const parsed = await body(req, patchSchema);
  if (!parsed.ok) return parsed.res;

  return withActor(async (actor) => {
    const denied = requirePrivilege(actor, "canManageConfig", "管理配置");
    if (denied) return denied;
    const r = await updateRule(code, parsed.data);
    if (r.ok) return json({ ok: true, id: r.id });
    return reject(r);
  });
}

/**
 * 服务层拒绝理由 → HTTP。
 *
 * 三档分开（不是一律 422）：
 *   · `not_found` → 404 走 `notFound()`（唯一出口；手写 `fail(404)` 被 lint-guard 拦）；
 *   · `scope_conflict` → **409**：请求本身合法，是与库里另一条启用规则的冲突，
 *     用户停用那一条再试即可（§2.2「给『禁用原规则并启用本条』一键操作」的接口侧一半）；
 *   · `no_executor` / `receivers_not_applicable` / `invalid_receivers` → **422**：
 *     它们回答"为什么这个值不能这样改"，且**随实现变化**（执行体补上之后
 *     `no_executor` 就消失了），不是永久性的请求错误。
 */
function reject(r: RuleWriteRejection) {
  switch (r.why) {
    case "not_found":
      return notFound();
    case "scope_conflict":
      return fail(
        409,
        "scope_conflict",
        `这条规则的触发条件与「${r.withName}」完全相同，且动作也一样。同域同动作只能启用一条，请先停用那一条`,
      );
    case "no_executor":
      return fail(
        422,
        "no_executor",
        `「${r.name}」的动作还没有执行体 —— 启用它不会有任何效果。这一条要等执行体落地后才能开`,
      );
    case "receivers_not_applicable":
      return fail(
        422,
        "receivers_not_applicable",
        `「${r.name}」的动作不是「发送通知」，它没有收件人可调`,
      );
    case "invalid_receivers":
      return fail(422, "invalid_receivers", "收件人至少要选一个；要停掉通知请直接停用这条规则");
  }
}
