import { z } from "zod";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  SORTABLE_COLUMNS,
  archivedOnlyField,
} from "@/shared/schema/list-query";
import { riskCreateSchema, pruneEmpty } from "@/shared/schema/hosts";
import { createRiskMatter, listRiskMatters } from "@/app/lib/server/services/risks";
import { body, json, query, withActor } from "@/app/lib/server/http";

/**
 * 事项列表的分页口径与案件一致，但状态筛选**不收进枚举**：
 * 事项的 `status` 存的是 `mn_status_config.code`，运营可新增（配置驱动，枚举表 §0），
 * 所以这里只限长度。案件侧那四个值恰好是内置 code 才用 enum —— 两边不是不一致，是值域来源不同。
 */
const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  keyword: z.string().trim().max(60).optional(),
  status: z.string().trim().max(32).optional(),
  // 与案件侧同一套排序列白名单（同一份定义从 shared 引，禁令⑧）：不接受自由字符串。
  sortBy: z.enum(SORTABLE_COLUMNS).default("updated_at"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  // 同一个字段定义从 shared 引，不在这里重写一遍（禁令⑧：校验规则单源）
  archivedOnly: archivedOnlyField,
});

export async function GET(req: Request) {
  const q = await query(req, listSchema);
  if (!q.ok) return q.res;
  return withActor(async (actor) => json(await listRiskMatters(actor, q.data)));
}

export async function POST(req: Request) {
  const parsed = await body(req, riskCreateSchema);
  if (!parsed.ok) return parsed.res;
  return withActor(async (actor) =>
    json(await createRiskMatter(actor, pruneEmpty(parsed.data)), 201),
  );
}
