import { partySearchSchema } from "@/shared/schema/hosts";
import {
  createParty,
  exportParties,
  listParties,
  partyCreateSchema,
  partyExportQuerySchema,
  partyListQuerySchema,
  searchVisibleParties,
} from "@/app/lib/server/services/parties";
import { body, fail, json, query, requirePrivilege, withActor } from "@/app/lib/server/http";

/**
 * 当事人（M3 **对手方档案**）的集合端点。一个路径三种读法，因为它们是同一个资源的三件事：
 *
 *   · `?q=` —— **消歧检索**（建案/转案件里「引用既有当事人」下拉的数据源，master F2-15）。
 *     三条口径都不是风格：谓词是草案 §7.2「我对它关联的至少一个宿主可见」，**不是**当事人
 *     自己的范围（`mn_party` 是跨案件共享实体，没有 `owner_id`，照抄宿主谓词套不上）；
 *     关键字必填（`partySearchSchema.min(1)`）—— 空关键字等于全公司当事人一次列举，
 *     与 §4.1 拒绝裸 `/users` 列表同一个理由；只回证件号**尾四位**用于消歧
 *     （这不是脱敏展示：展示层是全明文，IQ-12；这个控件只承担消歧，导出是另一条链路）；
 *   · `?export=` —— **导出两档**（IQ-12 / M6 US-M6-3′）。明文档要 `canReadPlain`，
 *     两档都记 `EXPORT`（载荷记 `plain` 与行数）。判定在**这一层**（`requirePrivilege`），
 *     服务层不再判第二次 —— 两处各判一次就会出现两套口径；
 *   · 其余 —— **档案列表**（F3-1），分页/排序/筛选全在服务端（禁令⑧，每页上限 100）。
 *
 * `q` 优先于 `export`（同时带上时按检索走）：检索是下拉的实时请求，导出是显式动作，
 * 让前者赢可以保证下拉在任何 URL 拼接事故下都还能用。
 *
 * 三种读法的结果都只有 20/100 条时 `truncated=true`，前端必须显示
 * 「部分结果因权限未显示」（§7.2 原话），否则用户会以为"库里没有这家"，
 * 转而新建一份重复当事人 —— 那正是这张接口要防的事。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);

  if (url.searchParams.get("q")) {
    const q = await query(req, partySearchSchema);
    if (!q.ok) return q.res;
    return withActor(async (actor) => json(await searchVisibleParties(actor, q.data.q)));
  }

  if (url.searchParams.get("export")) {
    const q = await query(req, partyExportQuerySchema);
    if (!q.ok) return q.res;
    return withActor(async (actor) => {
      if (q.data.plain) {
        const denied = requirePrivilege(actor, "canReadPlain", "明文导出");
        if (denied) return denied;
      }
      return json(await exportParties(actor, { keyword: q.data.keyword, plain: q.data.plain }));
    });
  }

  const q = await query(req, partyListQuerySchema);
  if (!q.ok) return q.res;
  return withActor(async (actor) => json(await listParties(actor, q.data)));
}

/**
 * 新建对手方（F3-2：仅名称必填）。
 *
 * 两种拒绝都不是 500：
 *   · 输入的是**本企业名** → 422 `own_company`。这不是"请求写错了"，是"这件事本来就不该做"
 *     （IQ-7：我方永不入当事人表），文案要说清下一步；
 *   · 同证件号已在库 → **409** 并带上既有那条的 id。冲突的语义就是"你要建的东西已经在了"，
 *     前端据此给"打开那一份"而不是"重试"。
 *
 * 同**名**不同证件号仍然 201 建档（把同名行放进 `sameName` 提示）——自动合并会稀释对手画像，
 * 合并必须由人在详情页发起（F3-9）。
 */
export async function POST(req: Request) {
  const parsed = await body(req, partyCreateSchema);
  if (!parsed.ok) return parsed.res;
  return withActor(async (actor) => {
    const r = await createParty(actor, parsed.data);
    if (!r.ok) {
      if (r.why === "own_company")
        return fail(
          422,
          "own_company",
          `「${r.name}」是本企业名称，我方永不进当事人表；它在案件上的地位由该案的「我方诉讼地位」表达`,
        );
      return json(
        {
          error: "identity_exists",
          message: `库里已有同证件号的档案：${r.name}`,
          partyId: r.partyId,
        },
        409,
      );
    }
    return json(r, 201);
  });
}
