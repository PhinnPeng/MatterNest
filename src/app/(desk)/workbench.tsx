"use client";

import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { Flex, Grid, Listy, Skeleton, Tooltip } from "antd";

import { useOverview } from "@/app/lib/client/api";
import { PageHeader } from "@/app/components/page-header";
import { StateBlock } from "@/app/components/ui/state-block";
import { actorName, fromNow, dateTime } from "@/app/lib/client/format";
import { DEADLINE_TONE } from "@/app/theme/antd";

/**
 * 工作台。三段，都是整宽：
 *   ① **指标带** —— 5 张等宽等高的读数卡（PRD 那四问 + 本月新增案件）；
 *   ② **待办节点** —— 今天该动手的清单，一行一个节点（节点名 / 案件号 / 案件名 / 期限 四列对齐）；
 *   ③ **最近动作** —— 这里刚发生了什么，两列 10 条。
 *
 * 【2026-10-16 改版，原型见 `prototype` 分支的 `prototype-wb-optimize.html`】此前是
 * "左清单 + 右读数卡"的 15/6 两栏，三个问题：读数只有 2×2 四个数（"这周有没有新活进来"
 * 看不见）；两栏高度不齐，左栏长的时候右栏下面空一大截；最近动作挤在 6/24 的窄栏里，
 * 每条只放得下动作名 + 案件号。改成整宽三段后：5 张指标卡的数字落在同一条基线上、
 * 待办节点靠栅格对齐（不再是"标题一行 + 说明一行"）、动作两列 10 条只占 5 行。
 *
 * **待办节点仍是第一段内容**：这张页要回答的第一问是"今天有什么会过期"，
 * 指标带只是背景事实。
 *
 * 与列表页共用同一套后端口径：所有数字都来自 `/api/overview`，
 * 那里每个读数都过 `scopedWhere`，且**归档不计入**（归档是终态且列表默认隐藏）。
 */
function daysLeft(iso: string | null): number | null {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

/**
 * 指标带的一格：标签在上、数字贴底。五张同一个 `minHeight` + `space-between`
 * ⇒ 数字落在同一条基线上。
 *
 * 骨架**不用 `Card` 的 `loading`**：它自带的那种三行骨架会把卡片撑到 133，
 * 数据到货缩回 90 —— 五张卡一起长个儿再一起缩回去，比没有骨架还晃眼（实测过一次）。
 * 这里自己画两根（标签 + 数字的位置各一根），高度与稳态一样是 88。
 */
function Metric({
  label,
  value,
  sub,
  tone,
  tip,
  href,
  loading,
}: {
  label: string;
  value: number;
  sub?: string;
  tone?: string;
  /** 这个数的口径。挂在标签边的 `i` 上，不铺成卡片里的一行说明 */
  tip?: string;
  href?: string;
  loading: boolean;
}) {
  return (
    <div className="metric">
      {loading ? (
        <>
          <Skeleton.Input active block style={{ width: "52%", height: 14, minWidth: 0 }} />
          <Skeleton.Input active block style={{ width: "38%", height: 22, minWidth: 0 }} />
        </>
      ) : (
        <>
          <b
            className="num"
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 6,
              fontSize: 26,
              fontWeight: 600,
              lineHeight: 1.05,
              letterSpacing: "-0.02em",
              marginBottom: 2,
              color: tone,
            }}
          >
            {value}
            {sub ? (
              <span style={{ fontSize: 11.5, fontWeight: 400, color: "var(--ink3)" }}>{sub}</span>
            ) : null}
          </b>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            {href ? (
              <Link href={href} style={{ color: "inherit" }}>
                {label}
              </Link>
            ) : (
              label
            )}
            {tip ? (
              <Tooltip title={tip}>
                {/* 原生 `title` 只对鼠标可见，键盘用户拿不到这个口径说明 */}
                <span
                  tabIndex={0}
                  aria-label={tip}
                  style={{
                    width: 13,
                    height: 13,
                    borderRadius: "50%",
                    border: "1px solid var(--control-line)",
                    color: "var(--ink3)",
                    fontSize: 9,
                    lineHeight: "11px",
                    textAlign: "center",
                    cursor: "help",
                    flex: "none",
                  }}
                >
                  i
                </span>
              </Tooltip>
            ) : null}
          </span>
        </>
      )}
    </div>
  );
}

export function Workbench() {
  const { data, isPending, isFetching, isError, error } = useOverview();
  const qc = useQueryClient();
  /**
   * 四列节点行与两列动作只在 `md` 以上成立，窄屏回落到"标题 + 说明一行"的竖排。
   * `useBreakpoint` 首帧给 `{}`，但那一帧 `Card` 还在骨架里（`loading={isPending}`），
   * 看不到布局跳变。
   */
  const wide = !!Grid.useBreakpoint().md;

  if (isError) {
    return (
      <StateBlock
        tone="error"
        title="工作台读数没拿到"
        hint={error instanceof Error ? error.message : "未知错误"}
        action={
          <button
            type="button"
            className="btn sm"
            onClick={() => void qc.invalidateQueries({ queryKey: ["overview"] })}
          >
            重试
          </button>
        }
      />
    );
  }

  const upcoming = data?.upcoming ?? [];
  /** 品牌新库：一个案件都还没有。两种空态文案不同，数字不用特殊处理（本来就是真值） */
  const fresh = !!data && data.matters.total === 0;

  const metrics = [
    {
      key: "matters",
      label: "在办案件",
      href: "/matters",
      tip: "口径与列表一致：已归档不计入",
      value: data?.matters.total ?? 0,
    },
    {
      key: "overdue",
      label: "逾期节点",
      value: data?.nodes.overdue ?? 0,
      tone: data?.nodes.overdue ? DEADLINE_TONE.overdue.color : undefined,
    },
    {
      key: "within7",
      label: "7 日内到期",
      value: data?.nodes.within7 ?? 0,
      tone: data?.nodes.within7 ? DEADLINE_TONE.soon.color : undefined,
    },
    {
      key: "risks",
      label: "事项",
      href: "/risk-matters",
      value: data?.risks.total ?? 0,
      sub: data ? `已转 ${data.risks.converted}` : undefined,
    },
    {
      key: "created",
      label: "本月新增案件",
      tip: "按上海业务月算；同样已归档不计入",
      value: data?.matters.createdThisMonth ?? 0,
    },
  ];

  return (
    <div className="stack">
      {/* 原先标题上方还有一行日期 + 星期（2026-10-12 撤）：标题「今天该动手的」里的
          "今天"就是那个日期，同屏复述一遍不增加任何判断。 */}
      <PageHeader
        title="今天该动手的"
        actions={
          <button
            type="button"
            className="btn"
            disabled={isFetching}
            /**
             * 禁用绑 `isFetching` 而不是 `isPending`：首屏那次已经在卡片骨架里了，
             * 这里要盖的是**用户自己按下的**那一次 —— 两个查询都在飞的时候按钮必须禁住。
             * 没有它的话，点完刷新到数据回来之间页面一声不响（读数、列表全是旧值），
             * 用户唯一能判断"按到了没有"的线索是鼠标划过时的 `:active` 底色。
             */
            onClick={() => {
              // 两个查询一起失效：只刷 overview 会留着上一个账号缓存的字典
              void qc.invalidateQueries({ queryKey: ["overview"] });
              void qc.invalidateQueries({ queryKey: ["meta"] });
            }}
          >
            刷新
          </button>
        }
      />

      {/* ① 指标带（canon `.metrics`，本页 5 格）：数字全部来自 `/api/overview`（过 scopedWhere）。
          canon 原型是 6 格，本页只有 5 个读数，故列数按实际条数给（不摆一个空的第 6 格）。 */}
      <div className="metrics" style={{ gridTemplateColumns: `repeat(${metrics.length}, 1fr)` }}>
        {metrics.map((m) => (
          <Metric
            key={m.key}
            label={m.label}
            value={m.value}
            sub={m.sub}
            tone={m.tone}
            tip={m.tip}
            href={m.href}
            loading={isPending}
          />
        ))}
      </div>

      {/* ② 待办节点 */}
      <div className="card">
        <div className="card-h">
          <h2>待办节点</h2>
          <span className="sp" />
          <span className="mut" style={{ fontSize: 12 }}>
            含已逾期，按期限升序
          </span>
        </div>
        <div style={{ padding: upcoming.length ? 0 : 24 }}>
          {isPending ? <div className="empty">…</div> : null}
          {!upcoming.length ? (
            <StateBlock
              title={fresh ? "还没有案件" : "没有待办节点"}
              hint={
                fresh
                  ? "先建第一个案件，再在案件详情页的「工作节点」里加节点。"
                  : "所有已确认时间的节点都完成了。新建节点在案件详情页的「工作节点」里。"
              }
              action={
                <Link href="/matters" className="btn sm pri">
                  去案件列表
                </Link>
              }
            />
          ) : (
            <Listy
              items={upcoming}
              rowKey={(n) => n.id}
              styles={{ item: { padding: wide ? "9px 16px" : "8px 12px" } }}
              itemRender={(n) => {
                const d = daysLeft(n.deadlineTime);
                const overdue = d !== null && d < 0;
                const soon = d !== null && d >= 0 && d <= 3;
                const color = overdue
                  ? DEADLINE_TONE.overdue.color
                  : soon
                    ? DEADLINE_TONE.soon.color
                    : "transparent";
                const due =
                  d === null ? "未定" : d < 0 ? `逾期 ${-d} 天` : d === 0 ? "今天" : `剩 ${d} 天`;
                // 左侧一条 3px 色带承担"危险程度"，文字里那个天数才是唯一通道
                // （色带只让扫读更快，对色觉障碍用户等于没有）
                const band = (
                  <span style={{ width: 3, height: 22, borderRadius: 2, background: color }} />
                );
                const dueCell = (
                  <span
                    style={{
                      color: color === "transparent" ? undefined : color,
                      fontSize: 12.5,
                      fontWeight: overdue || soon ? 600 : 400,
                      fontVariantNumeric: "tabular-nums",
                      textAlign: "right",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {due}
                  </span>
                );

                if (!wide) {
                  return (
                    <Flex justify="space-between" align="center" gap={8}>
                      <div style={{ display: "flex", gap: 10, minWidth: 0, flex: 1 }}>
                        {band}
                        <div style={{ minWidth: 0 }}>
                          <Link href={`/matters/${n.hostId}`} style={{ color: "inherit" }}>
                            <span style={{ fontSize: 13, fontWeight: 600 }}>{n.name}</span>
                          </Link>
                          <div style={{ fontSize: 12, color: "var(--ink3)" }}>
                            <span className="num">{n.hostCode}</span> · {n.hostName}
                            {n.owner ? ` · ${n.owner}` : ""} · {dateTime(n.deadlineTime)}
                          </div>
                        </div>
                      </div>
                      {dueCell}
                    </Flex>
                  );
                }

                return (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "3px 208px 132px minmax(0,1fr) 92px",
                      alignItems: "center",
                      gap: 12,
                    }}
                  >
                    {band}
                    <Link
                      href={`/matters/${n.hostId}`}
                      style={{
                        minWidth: 0,
                        color: "inherit",
                        fontSize: 13,
                        fontWeight: 600,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {n.name}
                    </Link>
                    <span
                      className="num"
                      style={{ fontSize: 12, color: "var(--ink2)", whiteSpace: "nowrap" }}
                    >
                      {n.hostCode}
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        color: "var(--ink2)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {n.hostName}
                    </span>
                    {/* 四列里放不下"精确时刻"和"谁在办"（这一行只留判断要不要现在动手的那四样）：
                      挂在期限上，想查的人不用为此点进案件 */}
                    <Tooltip
                      title={[
                        n.deadlineTime ? dateTime(n.deadlineTime) : "未定时间",
                        n.owner ? `经办 ${n.owner}` : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    >
                      {dueCell}
                    </Tooltip>
                  </div>
                );
              }}
            />
          )}
        </div>
      </div>

      {/* ③ 最近动作 */}
      <div className="card">
        <div className="card-h">
          <h2>最近动作</h2>
          <span className="sp" />
          {/* 数据没到之前不画这个数字：`?? 0` 会在首屏把「最近动作 0」摆在卡片头上，
              和下面那句「还没有活动记录」是同一句假话 —— 待办卡与这里都由 `isPending` 挡。 */}
          {data ? (
            <span className="mut3 num" style={{ fontSize: 12 }}>
              {data.recent.length}
            </span>
          ) : null}
        </div>
        <div style={{ padding: data?.recent.length ? 0 : 24 }}>
          {isPending ? <div className="empty">…</div> : null}
          {!data?.recent.length ? (
            <StateBlock title="还没有活动记录" hint="建案、改状态、加评论都会记在这里。" />
          ) : (
            <div
              style={{
                display: "grid",
                // 行优先：第 1、2 条同行。DOM 顺序仍是时间序，读屏和键盘走的是一条线
                gridTemplateColumns: wide ? "1fr 1fr" : "minmax(0,1fr)",
              }}
            >
              {data.recent.map((r, i) => (
                <div
                  key={r.id}
                  style={{
                    minWidth: 0,
                    padding: wide ? "8px 16px" : "6px 12px",
                    borderBottom: "1px solid var(--line)",
                    // 两列之间那道竖线只画在左列（行优先：左列的 DOM 下标是偶数）
                    ...(wide && i % 2 === 0 ? { borderRight: "1px solid var(--line)" } : {}),
                  }}
                >
                  <span className="rowflex" style={{ flexWrap: "wrap", gap: 6 }}>
                    {/* 定宽：字数不等的动作名（"归档" 2 字 vs "状态变更" 4 字）会让右边那列
                      案件号在行与行之间左右抖 22px（实测 1038 / 1060），10 行下来那列看着是斜的 */}
                    <span
                      className="tag"
                      style={{ fontSize: 11, minWidth: 60, textAlign: "center" }}
                    >
                      {r.actionLabel}
                    </span>
                    <Link href={`/${r.kind === "matter" ? "matters" : "risk-matters"}/${r.hostId}`}>
                      <span className="num" style={{ fontSize: 12 }}>
                        {r.hostCode ?? "—"}
                      </span>
                    </Link>
                  </span>
                  <div style={{ fontSize: 11, color: "var(--ink3)" }}>
                    {/* `actorName()` 把 null（系统自动动作）说成人话，与案件详情时间线同一口径 */}
                    {actorName(r.operator)} · {fromNow(r.createdAt)}
                    {r.reason ? ` · ${r.reason}` : ""}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
