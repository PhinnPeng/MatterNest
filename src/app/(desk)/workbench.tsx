"use client";

import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { Flex, Listy, Skeleton, Space, Tooltip } from "antd";

import { useOverview } from "@/app/lib/client/api";
import { PageHeader } from "@/app/components/page-header";
import { StateBlock } from "@/app/components/ui/state-block";
import { actorName, fromNow } from "@/app/lib/client/format";
import { hostBase } from "@/shared/hosts";
import { DEADLINE_TONE } from "@/app/theme/antd";

/**
 * 工作台。三段，都是整宽：
 *   ① **指标带** —— 5 张等宽等高的读数卡（PRD 那四问 + 本月新增案件）；
 *   ② **近期活动** —— 有最近进展的案件/事项，按 `last_progress_at` 倒序（2026-10-24 用户裁定）；
 *   ③ **最近动作** —— 这里刚发生了什么，垂直单列 10 条，行等分卡片余量。
 *
 * 【2026-10-16 改版，原型见 `prototype` 分支的 `prototype-wb-optimize.html`】此前是
 * "左清单 + 右读数卡"的 15/6 两栏，三个问题：读数只有 2×2 四个数（"这周有没有新活进来"
 * 看不见）；两栏高度不齐，左栏长的时候右栏下面空一大截；最近动作挤在 6/24 的窄栏里，
 * 每条只放得下动作名 + 案件号。改成整宽三段后：5 张指标卡的数字落在同一条基线上、
 * 待办节点靠栅格对齐（不再是"标题一行 + 说明一行"）。
 *
 * 【2026-10-20 最近动作改垂直单列】原来是两列 5 行。这张卡是 `.stack` 的末元素，
 * 会被 `.page > .stack > *:last-child` 的 `flex: 1` 拉到页面余量高度 —— 两列只占 5 行，
 * 下面留一大片空。改成单列后用 `grid-auto-rows: minmax(44px, 1fr)` 让 10 行等分这段高度，
 * 不留空白，同时保持像素行高下限（行数少时不会把一行拉成一条横幅）。
 *
 * **近期活动取代了原「待办节点」**：第一问从"今天有什么会过期"改成"最近在推进什么"，
 * 期限仍在指标带里给数；节点清单回案件详情的「时间节点」看。
 *
 * 与列表页共用同一套后端口径：所有数字都来自 `/api/overview`，
 * 那里每个读数都过 `scopedWhere`，且**归档不计入**（归档是终态且列表默认隐藏）。
 */
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

  const progress = data?.recentProgress ?? [];
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
    <div className="stack roomy">
      {/* 标题 2026-10-20 由「今天该动手的」改成「工作台」：日期的义务已经由各条的
          期限与「逾期 N 天」承担，标题不必再复述一次。标题上方那行日期 + 星期
          在 2026-10-12 已撤。 */}
      <PageHeader
        title="工作台"
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

      {/* ② 近期活动：有最近进展的案件/事项，按 last_progress_at 倒序（2026-10-24 用户裁定）。
          原「待办节点」把"今天会过期什么"摊成 10 行；现在期限仍在指标带里给数，
          这一块回答"最近在推进什么"。右侧「查看更多」进报表页看完整列表（含筛选与导出）。 */}
      <div className="card">
        <div className="card-h">
          <h2>近期活动</h2>
          <span className="sp" />
          <Link href="/reports/recent-progress" className="btn sm">
            查看更多
          </Link>
        </div>
        <div style={{ padding: progress.length ? 0 : 24 }}>
          {isPending ? <div className="empty">…</div> : null}
          {!progress.length ? (
            <StateBlock
              title={fresh ? "还没有案件" : "还没有进展记录"}
              hint={
                fresh
                  ? "建第一个案件，在详情的「进展」里记一条，就会出现在这里。"
                  : "在案件或事项详情的「进展」里记一条，就会出现在这里。"
              }
              action={
                <Link href="/matters" className="btn sm pri">
                  去案件列表
                </Link>
              }
            />
          ) : (
            <Listy
              items={progress}
              rowKey={(p) => `${p.kind}-${p.hostId}`}
              styles={{ item: { padding: "9px 16px" } }}
              itemRender={(p) => {
                const href = `/${hostBase(p.kind)}/${p.hostId}`;
                return (
                  <Flex justify="space-between" align="flex-start" gap={12} wrap>
                    <Space size={8} align="baseline" style={{ minWidth: 0 }}>
                      <span className="tag" style={{ fontSize: 11 }}>
                        {p.kind === "matter" ? "案件" : "事项"}
                      </span>
                      <Link href={href} className="num" style={{ fontSize: 12 }}>
                        {p.hostCode}
                      </Link>
                      <Link href={href} style={{ fontSize: 13, fontWeight: 600, color: "inherit" }}>
                        {p.hostName}
                      </Link>
                    </Space>
                    <Space size={10} style={{ flex: "none" }}>
                      {p.progressLabel ? (
                        <span className="mut3" style={{ fontSize: 12 }}>
                          {p.progressLabel}
                        </span>
                      ) : null}
                      <span className="mut3 num" style={{ fontSize: 12 }}>
                        {fromNow(p.progressAt)}
                      </span>
                    </Space>
                    {p.content ? (
                      <div
                        className="mut3"
                        style={{
                          flexBasis: "100%",
                          fontSize: 12,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {p.content}
                      </div>
                    ) : null}
                  </Flex>
                );
              }}
            />
          )}
        </div>
      </div>
      <div className="card" style={{ display: "flex", flexDirection: "column" }}>
        <div className="card-h">
          <h2>最近动作</h2>
          <span className="sp" />
          {data ? (
            <span className="mut3 num" style={{ fontSize: 12 }}>
              {data.recent.length}
            </span>
          ) : null}
        </div>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "grid",
            gridAutoRows: data?.recent.length ? "minmax(44px, 1fr)" : "auto",
            padding: data?.recent.length ? 0 : 24,
          }}
        >
          {isPending ? <div className="empty">…</div> : null}
          {!data?.recent.length ? (
            <StateBlock title="还没有活动记录" hint="建案、改状态、加评论都会记在这里。" />
          ) : (
            data.recent.map((r) => (
              <div key={r.id} className="activity-row">
                <span className="rowflex" style={{ flexWrap: "wrap", gap: 6 }}>
                  <span className="tag" style={{ fontSize: 11, minWidth: 60, textAlign: "center" }}>
                    {r.actionLabel}
                  </span>
                  <Link href={`/${r.kind === "matter" ? "matters" : "risk-matters"}/${r.hostId}`}>
                    <span className="num" style={{ fontSize: 12 }}>
                      {r.hostCode ?? "—"}
                    </span>
                  </Link>
                </span>
                <div className="activity-meta">
                  {actorName(r.operator)} · {fromNow(r.createdAt)}
                  {r.reason ? ` · ${r.reason}` : ""}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
