"use client";

import { useMemo } from "react";
import { Tooltip } from "antd";

import { StateBlock } from "@/app/components/ui/state-block";
import { useMeta, type HostKind } from "@/app/lib/client/api";
import { useReports } from "@/app/lib/client/api-reports";
import type { MatterMatrix, NodeDeadlineCard, RiskMatrix } from "@/app/lib/client/api-reports";
import { toReportQuery, type ListState } from "@/app/lib/client/use-list-state";
import { DEADLINE_TONE } from "@/app/theme/antd";
import { LITIGATION_ROLE_LABELS } from "@/shared/enums/business";
import { HOST_TYPE_LABELS } from "@/shared/enums/targets";

/**
 * 报表两卡（MATT-46 / F8-1 + F8-2），挂在**两个列表页顶部**：P7 案件列表与 P4 事项列表。
 *
 * 形态由 P0-2 裁定：**不建报表页、不进菜单**（§4.7）。所以这里没有页头、没有自己的刷新按钮、
 * 没有自己的归档开关——页面上已有的那些控件就是它的控件，`filters` 就是当前那份筛选。
 *
 * ## 一个组件，两处调用
 *
 * 两张卡在两个列表页上**逐字相同**，差别只有 `host`（画哪张矩阵）与 `filters`（当前筛选）。
 * 各写一遍会得到两份会漂的实现：一处改了列宽或档位说明，另一处看不出来。
 *
 * ## 为什么这两张表不是 `DataTable`
 *
 * `DataTable` 的契约是**受控分页的服务端列表**（`page/pageSize/total/onSortChange`，
 * 页大小 > 100 直接抛）——它存在的理由是禁令⑧：不许"拉全量再本地筛"。
 * 而这两张卡是**固定维度的计数矩阵**：行是状态（× 等级）、列是配置里的几档，
 * 没有分页也没有排序可言，总数就在表尾合计行里。所以直接用 canon 的 `<table class="tb">`
 * （与 `DataTable` 同一个视觉系统），列宽用 `<colgroup>` 显式给。
 *
 * 2026-10-18（MATT-99）：从 antd `Table` 换成 canon 的 `<table class="tb">`；
 * 卡片外壳换成 `.card` / `.card-h`（`h2`）。
 *
 * ## 口径的落点（副标题纪律）
 *
 * 卡片头上没有第二行说明。两条读者会问的规则各挂在自己的 tooltip 上：
 *   · 「这些数字是哪些行的」→ 卡片标题（`SCOPE_HINT`）；
 *   · 「为什么未指派时案件那一行是 0」→ 节点卡的「宿主」列头（`HOST_HINT`）；
 *   · 「临期」按每个节点自己的提醒档算 → 各档列头（`BUCKET_HINT`）。
 *
 * ## 数字全部来自服务端
 *
 * 这个文件不做任何求和、分组或二次取数：行、列、合计（含表尾）都由 `/api/reports` 摆好
 * （§4.7 第 5 条）。这里只把 code 换成配置里的显示名（`/api/meta` 是字典的唯一出口）。
 */
export function ReportCards({ host, filters }: { host: HostKind; filters: ListState }) {
  /**
   * queryKey 就是真正发出去的那个请求串（`toReportQuery`）：筛选一变、请求串一变、
   * key 跟着变——"筛选变了但卡片不重新取"在类型层写不出来。
   */
  const { data, isPending, isError, error, refetch } = useReports(toReportQuery(filters));
  // 状态与等级是**配置驱动**的字典，唯一出口是 `/api/meta`（工作台的状态分布也这么取）。
  // 服务层只给 code，所以运营在配置页改一次显示名，报表与列表一起变。
  const { data: dict } = useMeta(host);
  const statusNames = useMemo(() => nameMap(dict?.statuses), [dict]);
  const levelNames = useMemo(() => nameMap(dict?.levels), [dict]);

  if (isError) {
    // 读数失败**只塌掉这两张卡**：下面的列表照常可用（它有自己的错误态），
    // 所以这里不接管整页，也不把列表的错误混进来。
    return (
      <div className="card">
        <div className="card-b">
          <StateBlock
            tone="error"
            title="统计卡读数没拿到"
            hint={error instanceof Error ? error.message : "未知错误"}
            action={
              <button type="button" className="btn sm" onClick={() => void refetch()}>
                重试
              </button>
            }
          />
        </div>
      </div>
    );
  }

  const loading = isPending || !data;
  const name = (code: string) => statusNames.get(code) ?? code;
  const level = (code: string) => levelNames.get(code) ?? code;

  return (
    <div className="stack">
      <div className="card">
        <div className="card-h">
          <h2>{cardTitle("总览")}</h2>
        </div>
        <div className="card-b" style={{ padding: 0 }}>
          {loading ? (
            <div className="empty">…</div>
          ) : host === "matter" ? (
            <MatterMatrixTable
              m={data.matters}
              name={name}
              level={level}
              emptyText={emptyText(filters, data.archivedOnly, "案件")}
            />
          ) : (
            <RiskMatrixTable
              m={data.risks}
              name={name}
              level={level}
              emptyText={emptyText(filters, data.archivedOnly, "事项")}
            />
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>{cardTitle("节点到期")}</h2>
        </div>
        <div className="card-b" style={{ padding: 0 }}>
          {loading ? <div className="empty">…</div> : <NodeDeadlineTable card={data.nodes} />}
        </div>
      </div>
    </div>
  );
}

/**
 * 卡片头上的规则。tooltip 是"规则类的话"的合法落点之一（另外三类：空态/错误态、
 * 控件说明、字段表）——把同一句话写成卡片下的第二行说明就是被禁的那种旁白。
 *
 * ⚠ 这句**改过一次**，起因是检查子代理的发现：原文写「…状态、经办人未指派、**在办 / 已归档**」，
 * 而两个宿主页（`/matters`、`/risk-matters`）**都没有归档开关** —— 归档视图是另一个页面
 * `/archive`，两张卡不在那儿。于是 tooltip 在**宣传一个界面上不存在的东西**：
 * 读者会去找那个开关，找不到。
 *
 * 服务端确实支持 `archivedOnly=1`（它在 `REPORT_FILTER_KEYS` 里，与两张列表同一个二态开关），
 * 所以这不是"能力是假的"，而是"**文案承诺了界面没给的入口**"。
 *
 * 裁定：**改文案**，并顺手回答"那归档读数去哪看" —— 给宿主页补一个切换开关属 P0-2 之外的范围。
 * （若日后真加了「在办 / 已归档」切换，把这一句改回去即可。）
 */
const SCOPE_HINT =
  "这些数字按当前筛选算：状态、经办人未指派。默认只算在办 —— 归档记录在「已归档」页看。" +
  "关键词、排序与翻页不参与统计。";

/** 节点卡两行的范围。`owner_id` 案件侧 NOT NULL（IQ-6），所以「未指派」下案件那行是 0 */
const HOST_HINT = "两行都按当前筛选算。案件必有负责人，所以「经办人未指派」下案件那一行是 0。";

function cardTitle(text: string) {
  return (
    <Tooltip title={SCOPE_HINT}>
      {/* 虚线下划线是"这里有一条规则"的既有读法（与列头上的 tooltip 同一个信号） */}
      <span style={{ borderBottom: "1px dashed var(--line)", cursor: "help" }}>{text}</span>
    </Tooltip>
  );
}

/**
 * 空态文案：有筛选时说清"是筛没了"，没筛选时才说"还没有"——两者要用户做的事不一样。
 *
 * 「在办还是归档」这一半用**服务端回显的 `data.archivedOnly`**，不用本地状态猜：
 * 回显存在的意义就是"这两张卡算的是哪个范围"由服务端说了算（`ReportsPayload` 的注释）。
 */
function emptyText(filters: ListState, archivedOnly: boolean, what: string): string {
  if (filters.status || filters.ownerEmpty || archivedOnly) {
    return `当前筛选下没有可见${what}`;
  }
  return `还没有在办${what}`;
}

/** 字典数组 → code→名 的查表；配置里已经没有的 code 由调用方回落成 code 本身 */
function nameMap(rows: { code: string; name: string }[] | undefined) {
  return new Map((rows ?? []).map((r) => [r.code, r.name]));
}

/** 诉讼地位的中文名来自枚举表 E12（与 `/api/meta` 下发的是同一份，不在这里抄第二份） */
function roleName(code: string): string {
  return (LITIGATION_ROLE_LABELS as Record<string, string>)[code] ?? code;
}

/* ─────────────────────── 卡①·案件：状态 × 等级 × 诉讼地位 ─────────────────────── */

function MatterMatrixTable({
  m,
  name,
  level,
  emptyText,
}: {
  m: MatterMatrix;
  name: (code: string) => string;
  level: (code: string) => string;
  emptyText: string;
}) {
  /**
   * 状态列合并单元格：同一状态跨等级只写一次，格子里带该状态的小计。
   * `rowSpan` 先按行键算好，不在 `onCell` 里数——那是渲染期副作用，
   * antd 重渲染几次就会数出不同的值（合并单元格最常见的错法）。
   */
  const rowSpans = useMemo(() => {
    const perStatus = new Map<string, number>();
    for (const r of m.rows) perStatus.set(r.status, (perStatus.get(r.status) ?? 0) + 1);
    const spans = new Map<string, number>();
    const done = new Set<string>();
    for (const r of m.rows) {
      const key = `${r.status}\u0000${r.level}`;
      if (done.has(r.status)) spans.set(key, 0);
      else {
        spans.set(key, perStatus.get(r.status) ?? 1);
        done.add(r.status);
      }
    }
    return spans;
  }, [m.rows]);

  return (
    <table className="tb">
      <colgroup>
        <col style={{ width: 120 }} />
        <col style={{ width: 84 }} />
        {m.roles.map((role) => (
          <col key={role.code} style={{ width: 84 }} />
        ))}
        <col style={{ width: 84 }} />
      </colgroup>
      <thead>
        <tr>
          <th>状态</th>
          <th>等级</th>
          {m.roles.map((role) => (
            <th key={role.code} className="r">
              {roleName(role.code)}
            </th>
          ))}
          <th className="r">合计</th>
        </tr>
      </thead>
      <tbody>
        {m.rows.length === 0 ? (
          <tr>
            <td colSpan={m.roles.length + 3}>
              <div className="empty">{emptyText}</div>
            </td>
          </tr>
        ) : (
          m.rows.map((row) => {
            const span = rowSpans.get(`${row.status}\u0000${row.level}`) ?? 1;
            return (
              <tr key={`${row.status}\u0000${row.level}`}>
                {span > 0 ? (
                  <td rowSpan={span}>
                    <span title={name(row.status)}>{name(row.status)}</span>
                    {/* 该状态跨等级的小计：与服务端给的 statusTotal 同源 */}
                    <div className="num mut3" style={{ fontSize: 11 }}>
                      共 {row.statusTotal}
                    </div>
                  </td>
                ) : null}
                <td>
                  <span title={level(row.level)}>{level(row.level)}</span>
                </td>
                {m.roles.map((role) => (
                  <td key={role.code} className="r">
                    <span className="num">{row.counts[role.code] ?? 0}</span>
                  </td>
                ))}
                <td className="r">
                  <span className="num" style={{ fontWeight: 600 }}>
                    {row.total}
                  </span>
                </td>
              </tr>
            );
          })
        )}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={2}>合计</td>
          {m.roles.map((role) => (
            <td key={role.code} className="r">
              <span className="num">{role.total}</span>
            </td>
          ))}
          <td className="r">
            <span className="num" style={{ fontWeight: 600 }}>
              {m.total}
            </span>
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

/* ─────────────────────────── 卡①·事项：状态 × 等级 ─────────────────────────── */

function RiskMatrixTable({
  m,
  name,
  level,
  emptyText,
}: {
  m: RiskMatrix;
  name: (code: string) => string;
  level: (code: string) => string;
  emptyText: string;
}) {
  return (
    <table className="tb">
      <colgroup>
        <col style={{ width: 140 }} />
        {m.levels.map((lv) => (
          <col key={lv.code} style={{ width: 84 }} />
        ))}
        <col style={{ width: 84 }} />
      </colgroup>
      <thead>
        <tr>
          <th>状态</th>
          {m.levels.map((lv) => (
            <th key={lv.code} className="r">
              {level(lv.code)}
            </th>
          ))}
          <th className="r">合计</th>
        </tr>
      </thead>
      <tbody>
        {m.rows.length === 0 ? (
          <tr>
            <td colSpan={m.levels.length + 2}>
              <div className="empty">{emptyText}</div>
            </td>
          </tr>
        ) : (
          m.rows.map((row) => (
            <tr key={row.status}>
              <td>
                <span title={name(row.status)}>{name(row.status)}</span>
              </td>
              {m.levels.map((lv) => (
                <td key={lv.code} className="r">
                  <span className="num">{row.counts[lv.code] ?? 0}</span>
                </td>
              ))}
              <td className="r">
                <span className="num" style={{ fontWeight: 600 }}>
                  {row.total}
                </span>
              </td>
            </tr>
          ))
        )}
      </tbody>
      <tfoot>
        <tr>
          <td>合计</td>
          {m.levels.map((lv) => (
            <td key={lv.code} className="r">
              <span className="num">{lv.total}</span>
            </td>
          ))}
          <td className="r">
            <span className="num" style={{ fontWeight: 600 }}>
              {m.total}
            </span>
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

/* ──────────────────────────── 卡②：节点到期 ──────────────────────────── */

/**
 * 档位说明。**键由服务端给**（`buckets[].key`），这里只负责把规则说清楚——
 * "临期"按每个节点自己的提醒档算，这件事从列名看不出来，只能落在 tooltip 上。
 */
const BUCKET_HINT: Record<string, string> = {
  overdue: "期限已过且节点未完成。未确认时间的节点不进任何一档。",
  soon: "已进入该节点自己的提醒档：remind_days 里最远的那一档（空则按 7 天）。",
  later: "还没进该节点自己的提醒档。",
};

/** 颜色只做强调，数字本身才是通道（灰阶打印与色觉障碍都要能读） */
const BUCKET_TONE: Record<string, string> = {
  overdue: DEADLINE_TONE.overdue.color,
  soon: DEADLINE_TONE.soon.color,
  later: DEADLINE_TONE.later.color,
};

function NodeDeadlineTable({ card }: { card: NodeDeadlineCard }) {
  return (
    <table className="tb">
      <colgroup>
        <col style={{ width: 140 }} />
        {card.buckets.map((b) => (
          <col key={b.key} style={{ width: 96 }} />
        ))}
        <col style={{ width: 96 }} />
      </colgroup>
      <thead>
        <tr>
          <th>
            <Tooltip title={HOST_HINT}>
              <span>宿主</span>
            </Tooltip>
          </th>
          {card.buckets.map((b) => (
            <th key={b.key} className="r">
              <Tooltip title={BUCKET_HINT[b.key]}>
                <span>{b.label}</span>
              </Tooltip>
            </th>
          ))}
          <th className="r">合计</th>
        </tr>
      </thead>
      <tbody>
        {card.rows.length === 0 ? (
          <tr>
            <td colSpan={card.buckets.length + 2}>
              <div className="empty">这个范围里没有到期节点</div>
            </td>
          </tr>
        ) : (
          card.rows.map((row) => (
            <tr key={row.kind}>
              <td>
                <span title={hostName(row.kind)}>{hostName(row.kind)}</span>
              </td>
              {card.buckets.map((b) => {
                const n = row.counts[b.key] ?? 0;
                return (
                  <td key={b.key} className="r">
                    <span
                      className="num"
                      style={{
                        color: n ? BUCKET_TONE[b.key] : undefined,
                        fontWeight: n ? 600 : 400,
                      }}
                    >
                      {n}
                    </span>
                  </td>
                );
              })}
              <td className="r">
                <span className="num" style={{ fontWeight: 600 }}>
                  {row.total}
                </span>
              </td>
            </tr>
          ))
        )}
      </tbody>
      <tfoot>
        <tr>
          <td>合计</td>
          {card.buckets.map((b) => (
            <td key={b.key} className="r">
              <span className="num">{card.bucketTotals[b.key] ?? 0}</span>
            </td>
          ))}
          <td className="r">
            <span className="num" style={{ fontWeight: 600 }}>
              {card.total}
            </span>
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

function hostName(kind: HostKind): string {
  return HOST_TYPE_LABELS[kind] ?? kind;
}
