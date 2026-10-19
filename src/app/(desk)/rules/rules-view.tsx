"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App as AntdApp, Switch, Table, Tag, Tooltip } from "antd";
import type { TableColumnsType } from "antd";

import { INK } from "@/app/theme/brand";
import { api, ApiFailure, useActor } from "@/app/lib/client/api";
import { StateBlock } from "@/app/components/ui/state-block";
import { PageHeader } from "@/app/components/page-header";
import { NOTIFY_RECEIVERS } from "@/shared/enums/automation";

/**
 * 自动化规则（P12 / F5-7 · F5-10，2026-10-18）。
 *
 * ## 这一页能做什么、不能做什么
 *
 * 一期只有预置规则（F5-8/F5-9 新建随 IQ-9 移出），所以**没有「新增」按钮**。
 * `is_system` 的边界是 F5-10 的原话：「可调参可停用，**不可删不可改 trigger**」。
 * 所以每行只有两个可动的东西：启用开关、通知类规则的收件人。触发条件与动作是只读事实
 * ——页面上摆出来，但不给控件（摆一排禁用控件等于说"这里本来能改"，见 `config-view.tsx`
 * 同一条口径）。
 *
 * ## ⚠ 一条规则没有执行体，页面必须说这件事
 *
 * 2026-10-19 的核对（`agent-work/probe-rule-executors.mjs`）：规则 3（进入进行中创建节点）
 * **没有任何代码在跑它**（产品已明确拒绝该自动化，一期不实施）。所以这一行的开关位置
 * 给的是**一句说明**（`executor === "missing"`），并且禁用它；服务端也拒绝
 * 对它置 `isEnabled: true`（两道都挡，因为只挡界面挡不住直接打接口）。
 *
 * 这不是保守：执行体落地之后，把 `rule-admin.ts` 的名单、这里的显示、与 probe 三处
 * 同批改掉即可，成本很小；而一个假的绿灯会让人以为"节点会自己长出来"。
 *
 * 规则 1（结案自动归档）已于 2026-10-19 补上执行体（`services/auto-archive.ts`），
 * 它的开关是真的：状态推到已结案时，案件会被自动归档，并落一条
 * `operator_id = NULL` 的系统审计（不冒充任何人）。
 *
 * ## 收件人为什么只有通知类规则能改
 *
 * 规则 7 的动作是 `archive`，它的 `action_config` 是 `{}` —— 通知是**副作用**
 * （§2.4 既裁：「转案件归档」无独立模板，复用 `case_archived`）。给它一个收件人控件
 * 会写进一个没人读的键（服务层也会拒），用户在页面上却以为改了推送对象。
 *
 * ## 权限
 *
 * 读不设门（与 `/api/meta`、`/api/config/[kind]` 同档）：知道"系统会自动做什么"
 * 影响人怎么操作，不该有门槛。没有 `canManageConfig` 的人看得到这一页、看不到开关，
 * 页面给一句事实说明，而不是整页 403。
 */

type RuleItem = {
  id: string;
  code: string;
  name: string;
  hostTypeLabel: string;
  triggerLabel: string;
  triggerConfig: Record<string, unknown>;
  actionLabel: string;
  actionType: string;
  actionConfig: Record<string, unknown>;
  isSystem: boolean;
  isEnabled: boolean;
  priority: number;
  lastRunAt: string | null;
  /** `missing` = 这条规则没有执行体（勾了不会有任何效果） */
  executor: "live" | "missing";
};

type RulesPayload = {
  items: RuleItem[];
  summary: { total: number; enabled: number; live: number; withoutExecutor: number };
};

const RECEIVER_LABEL: Record<string, string> = {
  owner: "负责人",
  co_owner: "协办人",
  follower: "关注人",
  creator: "创建人",
  custom: "指定人员",
};

/**
 * 触发条件的**人话**。只讲"什么时候会触发"，不复述列名。
 *
 * `trigger_config` 的形状按 `trigger_type` 一对一（枚举表 §4.1），未知键在保存期就被拒，
 * 所以这里可以按类型穷举；落不到已知形状时回落到空串而不是抛 ——
 * 一条坏配置不该让整页白屏（列表读的是库，库里的旧行可能早于某些键）。
 */
function triggerDetail(r: RuleItem): string {
  const c = r.triggerConfig;
  const days = typeof c["days"] === "number" ? c["days"] : null;
  const status = typeof c["status_code"] === "string" ? c["status_code"] : null;
  switch (r.triggerLabel) {
    case "状态变更为":
      return status ? `→ ${status}` : "任意状态变更";
    case "一段时间无更新":
      return days ? `${days} 天${status ? `（${status} 起算）` : ""}` : "";
    case "节点开始前":
    case "节点截止前":
      return days ? `提前 ${days} 天` : "";
    case "领域事件发生时": {
      const ev = typeof c["event"] === "string" ? c["event"] : "";
      return ev === "risk_converted" ? "事项转案件" : ev === "comment_added" ? "新增评论" : ev;
    }
    default:
      return "";
  }
}

/** 收件人的人话（只在通知类规则上有值） */
function receiversOf(r: RuleItem): string[] {
  const raw = r.actionConfig["receivers"];
  return Array.isArray(raw) ? raw.map(String) : [];
}

export function RulesView() {
  const qc = useQueryClient();
  const { message } = AntdApp.useApp();
  const session = useActor();
  const canManage = session.data?.privileges?.canManageConfig === true;

  /** 正在改的那一行（禁用该行的控件，避免连点产生两条相反的写入） */
  const [busy, setBusy] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["rules"],
    queryFn: () => api.get<RulesPayload>("/api/rules"),
    staleTime: 30 * 1000,
  });

  const patch = useMutation({
    mutationFn: (v: { code: string; body: { isEnabled?: boolean; receivers?: string[] } }) =>
      // `code` 走路径（与接口的形状一致）：它是 seed 的幂等锚，不是 id
      api.patch<{ ok: true }>(`/api/rules/${encodeURIComponent(v.code)}`, v.body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["rules"] });
    },
  });

  if (q.isPending) return <div className="card" style={{ minHeight: 320 }} />;
  if (q.isError) {
    return <StateBlock tone="error" title="规则读不到" hint="会话可能已过期，重新登录后再看。" />;
  }

  const { items, summary } = q.data;
  if (items.length === 0) {
    return <StateBlock title="还没有自动化规则" tone="empty" />;
  }

  /**
   * 改一条。**错误文案一律用服务端给的 message**：本页不做第二份翻译。
   *
   * 那几句话是服务层按具体拒绝理由写的（同域冲突会点名是哪条、没有执行体会说明为什么），
   * 页面自己再拼一遍就会与它漂移 —— 而本仓刚因为"两处各说一套"吃过亏。
   */
  const change = async (r: RuleItem, body: { isEnabled?: boolean; receivers?: string[] }) => {
    setBusy(r.code);
    try {
      await patch.mutateAsync({ code: r.code, body });
      message.success(`已更新「${r.name}」`);
    } catch (e) {
      message.error(e instanceof ApiFailure ? e.message : "没能保存，请稍后重试");
    } finally {
      setBusy(null);
    }
  };

  const columns: TableColumnsType<RuleItem> = [
    {
      title: "规则",
      dataIndex: "name",
      render: (_v, r) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ color: INK.body }}>{r.name}</span>
          {/* `code` 是排障时的锚：日志与通知里出现的是它，不是中文名 */}
          <span className="mono mut3" style={{ fontSize: 12 }}>
            {r.code}
          </span>
        </div>
      ),
    },
    {
      title: "作用于",
      dataIndex: "hostTypeLabel",
      width: 96,
    },
    {
      title: "触发",
      key: "trigger",
      width: 200,
      render: (_v, r) => (
        <span>
          {r.triggerLabel}
          {triggerDetail(r) ? <span className="mut"> {triggerDetail(r)}</span> : null}
        </span>
      ),
    },
    {
      title: "动作",
      key: "action",
      width: 220,
      render: (_v, r) => {
        const rec = receiversOf(r);
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span>{r.actionLabel}</span>
            {rec.length > 0 ? (
              <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {rec.map((x) => (
                  <Tag key={x}>{RECEIVER_LABEL[x] ?? x}</Tag>
                ))}
              </span>
            ) : null}
          </div>
        );
      },
    },
    {
      title: "启用",
      key: "enabled",
      width: 132,
      align: "left",
      render: (_v, r) => {
        /**
         * 没有执行体的规则：**不给开关**，给一句说明。
         * 这不是"暂时禁用"的控件 —— 那个形态会让人以为等权限/等配置就能开。
         */
        if (r.executor === "missing") {
          return (
            <Tooltip title="这条规则的动作还没有执行体，启用它不会有任何效果。执行体落地后才能开">
              <span className="mut3" style={{ fontSize: 12 }}>
                暂不可用
              </span>
            </Tooltip>
          );
        }
        return (
          <Switch
            size="small"
            checked={r.isEnabled}
            loading={busy === r.code}
            disabled={!canManage}
            onChange={(v) => void change(r, { isEnabled: v })}
          />
        );
      },
    },
    {
      // 有表头才说得清这一列是干什么的：空表头会让右侧那排标签看起来属于"启用"列
      title: "收件人",
      key: "receivers",
      width: 168,
      render: (_v, r) => {
        /**
         * 收件人只对"动作是 notify"的规则开放（规则 7 的收件人是副作用，从字面量来）。
         * 用 `actionType` 判而不是 `actionLabel` 判：前者是值域、后者是展示文案。
         */
        if (r.actionType !== "notify" || r.executor === "missing" || !canManage) return null;
        const rec = receiversOf(r);
        // 只有一个可选项时不给控件：改不出第二种结果，控件只是装饰
        const options = NOTIFY_RECEIVERS.filter((x) => x !== "custom");
        if (options.length < 2) return null;
        return (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {options.map((opt) => {
              const on = rec.includes(opt);
              return (
                <Tag
                  key={opt}
                  color={on ? "blue" : undefined}
                  style={{ cursor: busy === r.code ? "default" : "pointer", userSelect: "none" }}
                  onClick={() => {
                    if (busy === r.code) return;
                    const next = on ? rec.filter((x) => x !== opt) : [...rec, opt];
                    // 至少留一个：空收件人等于"通知谁也不发"，而那应该用停用来表达
                    if (next.length === 0) {
                      message.warning("至少留一个收件人；要停掉通知请直接停用这条规则");
                      return;
                    }
                    void change(r, { receivers: next });
                  }}
                >
                  {RECEIVER_LABEL[opt] ?? opt}
                </Tag>
              );
            })}
          </div>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader title="自动化规则" />

      <div className="card">
        <div className="card-h">
          <h2>预置规则</h2>
          {/*
            读数报的是 **真的在跑** 的条数，不是库里 is_enabled 的行数。
            两者今天不相等：规则 3 在 seed 里就是启用的，而它没有执行体。
            报 enabled 会显示「8 / 9 条启用」—— 数字更漂亮，但与行为不符。
          */}
          <span className="mut">
            {summary.live} / {summary.total} 条在运行
          </span>
        </div>
        <div className="card-b">
          <Table<RuleItem>
            rowKey="code"
            columns={columns}
            dataSource={items}
            pagination={false}
            size="middle"
          />
        </div>
      </div>

      {summary.withoutExecutor > 0 ? (
        <div className="card">
          <div className="card-h">
            <h2>未接执行体</h2>
          </div>
          <div className="card-b">
            <p className="mut" style={{ margin: 0 }}>
              {summary.withoutExecutor} 条规则的动作还没有代码在跑，所以不给开关。
              它们是「进入进行中创建节点」—— 一期不实施该自动化，
              卡在"与建案时预设的节点如何不重复"这个产品裁定上。
            </p>
          </div>
        </div>
      ) : null}
    </>
  );
}
