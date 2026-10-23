import { riskMatterListQuerySchema } from "@/shared/schema/list-query";
import { riskCreateSchema, pruneEmpty, type PartyLinkInput } from "@/shared/schema/hosts";
import { createRiskMatter, listRiskMatters } from "@/app/lib/server/services/risks";
import { UnknownPartyError } from "@/app/lib/server/services/parties";
import { UnassignableAssigneeError } from "@/app/lib/server/services/selectable-users";
import { body, fail, json, query, withActor } from "@/app/lib/server/http";

/**
 * 事项列表的分页口径与案件一致，但状态筛选**不收进枚举**：
 * 事项的 `status` 存的是 `mn_status_config.code`，运营可新增（配置驱动，枚举表 §0），
 * 所以只限长度。案件侧那四个值恰好是内置 code 才用 enum —— 两边不是不一致，是值域来源不同。
 *
 * 查询面本身住在 `shared/schema/list-query.ts`（`riskMatterListQuerySchema`）：
 * 列表与「经办人候选」两个端点吃的是同一套筛选，各写一份的代价见那个常量的注释。
 */
export async function GET(req: Request) {
  const q = await query(req, riskMatterListQuerySchema);
  if (!q.ok) return q.res;
  return withActor(async (actor) => json(await listRiskMatters(actor, q.data)));
}

export async function POST(req: Request) {
  const parsed = await body(req, riskCreateSchema);
  if (!parsed.ok) return parsed.res;
  return withActor(async (actor) => {
    // parties **不**走 pruneEmpty：它的成员字段（partyId/type）允许空串占位，
    // pruneEmpty 会把整条数组结构擦成 Record，类型就没了。逐条清洗即可。
    const { parties, ...rest } = parsed.data;
    try {
      const r = await createRiskMatter(actor, {
        // 从服务签名反推参数类型，别手写一份再和实现漂移
        ...(pruneEmpty(rest) as Omit<Parameters<typeof createRiskMatter>[1], "parties">),
        parties: (parties ?? []).map((p) => pruneEmpty(p) as PartyLinkInput),
      });
      // 与案件侧同口径：返回 nameConflicts 供前端提示"同名不同证件号已另建一行"
      return json(r, 201);
    } catch (e) {
      /**
       * ⚠ 事项侧**必须**与案件侧同形地 catch 这两个错误，否则用户拿到的是 500。
       *
       * 检查子代理抓到的：`parties.ts` 的注释白纸黑字写着"两个路由（`/api/matters`、
       * `/api/risk-matters`）已经 catch 那个类型翻成 400"，而这里**只有** 422 那一条
       * ——于是"建事项时输入本企业名"（AC 第 4 条要求**提示而非建档**）得到的是 500：
       * 确实没有建档（抛在写之前），但既不是提示、也没告诉用户下一步。
       * 同一条缺陷还让"引用了一个不存在的 partyId"在事项侧 500。
       *
       * 注释与事实不符比缺代码更难查——所以这里把两条都补齐，与 `/api/matters/route.ts`
       * 逐字同形（同一套判定、同一套状态码与错误码）。
       */
      // 引用了库里没有的当事人（含"输入的是本企业名"）= 请求本身有问题，给 400 并点名；
      // 不兜底成 500，也不静默新建——后者会把选错的人写进台账
      if (e instanceof UnknownPartyError) return fail(400, "unknown_party", e.message);
      // 被指派者不合格（停用/待开通/软删）：422 + 点名是谁、怎么了。
      // 与案件侧同一形状——两侧创建路径的这条判定共用 `assertAssignable`。
      if (e instanceof UnassignableAssigneeError) return fail(422, "not_selectable", e.message);
      throw e;
    }
  });
}
