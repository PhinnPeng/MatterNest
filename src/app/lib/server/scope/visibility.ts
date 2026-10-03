import { and, eq, exists, or, sql, type SQL } from "drizzle-orm";
import { DATA_SCOPES, type DataScope } from "@/shared/enums";
import { matter, matterStaff, riskMatter, riskMatterStaff } from "../db/schema";

/**
 * 数据范围谓词（权限草案 §4）—— **全项目唯一一处**决定"谁能看见哪些宿主行"。
 *
 * 五条实现约束，都不是风格：
 *   1. **默认拒绝**：返回 `undefined`（= 不加谓词）只允许 `is_admin` 与 L1 `all` 拿到；
 *      反过来写（默认放行、按需收窄）就是"哪次忘了套谓词"即泄露。
 *   2. 仓储与页面不许自己拼可见性条件（§4「禁止裸表访问」），只能经 `scopedWhere`。
 *   3. L3 刻意**不含** `*_staff` 的协办/关注行 —— §1 写的是 `owned = 我承办 ∪ 我创建`，
 *      最容易写成"L2 少一个 OR"。
 *   4. 未知范围值按 `owned` 处理，不 fallthrough 到全部（枚举值域由 DB CHECK 守着，
 *      这里是第二道：万一库里塞进历史值也不能变成 L1）。
 *   5. `is_admin` 排在最前且**只**放开范围（§3 的逃生口），特权一律另判 ——
 *      写成"is_admin 顺带给全套特权"就等于把四个特权开关变成摆设。
 */

export type HostKind = "matter" | "risk_matter";

/** 两个宿主的列引用，供同一套逻辑复用（同构表对，§1.0.2） */
export const HOSTS = {
  matter: {
    table: matter,
    hostId: matter.id,
    owner: matter.ownerId,
    creator: matter.createdBy,
    staffHostId: matterStaff.hostId,
    staff: matterStaff,
  },
  risk_matter: {
    table: riskMatter,
    hostId: riskMatter.id,
    owner: riskMatter.ownerId,
    creator: riskMatter.createdBy,
    staffHostId: riskMatterStaff.hostId,
    staff: riskMatterStaff,
  },
} as const;

function narrow(scope: DataScope): DataScope {
  return (DATA_SCOPES as readonly string[]).includes(scope) ? scope : "owned";
}

/**
 * 可见性谓词；`undefined` 表示不加限制（仅 L1）。
 *
 * `EXISTS (… *_staff)` 那一条依赖 `ix_mn_*_staff_user`（§5 明写"权限必需"而非性能优化）：
 * 没有它，每个 L2 用户的列表都会退化成对宿主表的半表扫。
 */
export function visibility(
  host: HostKind,
  scope: DataScope,
  userId: string,
  isAdmin = false,
): SQL | undefined {
  if (isAdmin) return undefined; // §3 逃生口：只放开范围，不碰特权
  const s = narrow(scope);
  if (s === "all") return undefined;
  const h = HOSTS[host];
  const uid = BigInt(userId);

  const mine = or(eq(h.owner, uid), eq(h.creator, uid));
  if (s === "owned") return mine;

  // 直接把表对象插进 sql 模板（drizzle 会渲染成表名），比手写表名字符串可靠：
  // 工厂建出来的两张同构表列名都是 hostId，DB 名才分别是 matter_id / risk_matter_id
  /**
   * ⚠ `exists()` 只给 **QueryBuilder** 自动加括号；传 `sql` 模板时它渲染成 `exists select 1 …`，
   * PG 直接 42601 syntax error。所以括号必须自己写在这里。
   * 这个坑只有 L2 账号会踩到——seed 里必须留一个纯 L2 的演示账号，
   * 否则这条分支在真实登录链路上永远走不到（本轮冒烟就是这么发现的）。
   */
  const staffed = exists(
    sql`(select 1 from ${h.staff} where ${h.staffHostId} = ${h.hostId} and ${h.staff.userId} = ${uid})`,
  );
  return or(mine, staffed);
}

/**
 * 列表/详情统一入口：软删过滤 + 可见性 + 调用方附加条件。
 * 兜底 `sql\`false\``：若某天谓词全被过滤掉，宁可返回零行也不要变成全表放行。
 */
export function scopedWhere(
  host: HostKind,
  actor: { dataScope: DataScope; userId: string; isAdmin?: boolean },
  ...extra: (SQL | undefined)[]
): SQL {
  const h = HOSTS[host];
  const parts = [
    sql`NOT ${h.table.isDeleted}`,
    visibility(host, actor.dataScope, actor.userId, actor.isAdmin ?? false),
    ...extra,
  ].filter((x): x is SQL => Boolean(x));
  return and(...parts) ?? sql`false`;
}

/** 归档默认隐藏（§3.3：归档是终态、列表默认不显示），带 `includeArchived` 才放出 */
export function archivedFilter(host: HostKind, includeArchived: boolean): SQL | undefined {
  return includeArchived ? undefined : sql`NOT ${HOSTS[host].table.isArchived}`;
}

/** 关键词命中案号/名称/案由；ILIKE 前后模糊，走不了 btree —— 一期接受，量大时再上 pg_trgm */
export function keywordFilter(host: HostKind, keyword: string | undefined): SQL | undefined {
  if (!keyword) return undefined;
  const like = `%${keyword}%`;
  return host === "matter"
    ? or(
        sql`lower(${matter.name}) like lower(${like})`,
        sql`lower(${matter.internalCode}) like lower(${like})`,
        sql`lower(${matter.caseNo}) like lower(${like})`,
        sql`lower(${matter.cause}) like lower(${like})`,
      )
    : or(
        sql`lower(${riskMatter.name}) like lower(${like})`,
        sql`lower(${riskMatter.code}) like lower(${like})`,
        sql`lower(coalesce(${riskMatter.measure}, '')) like lower(${like})`,
      );
}
