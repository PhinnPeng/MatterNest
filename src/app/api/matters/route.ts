import { listQuerySchema } from "@/shared/schema/list-query";
import { matterCreateSchema, pruneEmpty } from "@/shared/schema/hosts";
import { createMatter, listMatters } from "@/app/lib/server/services/matters";
import { UnknownPartyError } from "@/app/lib/server/services/parties";
import { UnassignableAssigneeError } from "@/app/lib/server/services/selectable-users";
import { body, fail, json, query, withActor } from "@/app/lib/server/http";

/** 列表：分页/排序/筛选全在服务端做（禁令⑧；每页上限 100 由 listQuerySchema 守） */
export async function GET(req: Request) {
  const q = await query(req, listQuerySchema);
  if (!q.ok) return q.res;
  return withActor(async (actor) => json(await listMatters(actor, q.data)));
}

/** 建案：编号在事务里生成，与业务写、审计写同一事务（§12.3 + §7.3） */
export async function POST(req: Request) {
  const parsed = await body(req, matterCreateSchema);
  if (!parsed.ok) return parsed.res;
  return withActor(async (actor) => {
    try {
      return json(await createMatter(actor, pruneEmpty(parsed.data)), 201);
    } catch (e) {
      // 引用了库里没有的当事人 = 请求本身有问题，给 400 并点名是哪一条 id；
      // 不兜底成 500，也不静默新建 —— 后者会把选错的人写进案卷（`services/parties.ts`）
      if (e instanceof UnknownPartyError) return fail(400, "unknown_party", e.message);
      // 被指派者不合格（停用/待开通/软删）= 前置数据没齐，给 422 而不是 400：
      // 这不是"请求写错了"，是"你指的那个人现在不能接活"。文案点名是谁、怎么了。
      if (e instanceof UnassignableAssigneeError) return fail(422, "not_selectable", e.message);
      throw e;
    }
  });
}
