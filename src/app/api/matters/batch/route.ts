import { batchSchema } from "@/shared/schema/batch";
import {
  batchArchiveMatters,
  batchChangeMatterStatus,
  batchTagMatters,
} from "@/app/lib/server/services/matters";
import { body, fail, json, withActor } from "@/app/lib/server/http";

/**
 * 批量低风险动作（MATT-45）：改状态 / 归档 / 加标签，作用在列表选中的行上。
 *
 * ## 这个 handler 只做四件事
 *
 * 解析（`shared/schema/batch.ts`，禁令⑧ 的单源校验）→ 鉴权（`withActor`）→ 调服务层 → 序列化。
 * 权限判定一律不在 handler 里（`api-route-conventions` 的禁止项），
 * 所以这里**没有** `requirePrivilege`：撤销归档的特权是**逐行**的
 * （判据是"这一行当前已归档 且 目标不是归档语义"，见 `batchChangeMatterStatus`），
 * 请求级的特权检查会把"归档一批本来就没归档的行"也一起拦掉——
 * 而单条路由 `api/matters/[id]/status` 同样是逐行判的，两处口径必须一致。
 *
 * ## 响应语义（前端与冒烟都按这条读）
 *
 * 200 恒表示"请求被处理完了"，**不是**"每一行都成了"：
 * `{ applied, skipped: [{ id, reason }] }`。三个刻意的留白：
 *
 * 1. **不可见的行不出现在任何一栏**。把"看不见"混进 `skipped` 等于告诉调用方
 *    "你提交的 id 里有几个存在但你看不见"——那正是元规则 3（不可见一律 404）
 *    要防的案号枚举探测。所以 `applied + skipped.length` 允许小于 `ids.length`，
 *    而且响应里**没有**"未处理条数"这一栏（有它就等于把上面那句话说了出来）。
 * 2. `skipped[].reason` 只覆盖"看得见但没做成"：护栏 1 拒绝、这一步要原因、
 *    目标与现状相同、撤销归档缺特权、归档终态不可写。中文文案在
 *    `BATCH_SKIP_REASON_LABELS`（一份字典，两个列表页共用）。
 * 3. 4xx 只留给**与行无关**的问题：schema 校验失败（含 `convert` / `delete` 这类
 *    不存在的动作值）、目标状态/标签本身不存在。行级的失败一律进 200 的摘要——
 *    一次请求里 50 行各有各的原因，用 4xx 表达不了。
 */
export async function POST(req: Request) {
  const parsed = await body(req, batchSchema);
  if (!parsed.ok) return parsed.res;
  return withActor(async (actor) => {
    const input = parsed.data;

    if (input.action === "status") {
      const r = await batchChangeMatterStatus(actor, input.ids, input.to, input.reason ?? null);
      // 参数错（状态不存在/已停用）**不能**退化成"applied: 0"的空摘要：
      // 逐行 changeHostStatus 会回 not_found，而 not_found 按上面的口径是要被吞掉的。
      if (!r.ok) return fail(422, "bad_status", "目标状态不存在，或它已被停用");
      return json({ applied: r.applied, skipped: r.skipped });
    }

    if (input.action === "archive") {
      const r = await batchArchiveMatters(actor, input.ids, input.reason);
      return json({ applied: r.applied, skipped: r.skipped });
    }

    const r = await batchTagMatters(actor, input.ids, input.tagIds);
    if (!r.ok) return fail(422, "bad_tag", "选中的标签不存在，或不属于案件这一类记录");
    return json({ applied: r.applied, skipped: r.skipped });
  });
}
