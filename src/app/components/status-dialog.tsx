"use client";

import { BRAND, INK } from "@/app/theme/brand";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Form, Input, Modal, Select, Space, Typography } from "antd";

import { api, ApiFailure, type HostKind, type StatusRow } from "@/app/lib/client/api";
import { needsChangeReason } from "@/shared/schema/status-transition";
import {
  READINESS_UNREADABLE,
  READINESS_MISSING_PREFIX,
  readinessMissingText,
  READY_TEXT,
  UNAVAILABLE_HINT,
  type Readiness,
} from "@/app/lib/client/archive-readiness";

/**
 * 对话框的服务对象。**`host` 是必需的**：一个目标永远属于某个宿主，
 * 拆成两个 prop 会造出"target 是事项、host 是案件"这种可表达但无意义的状态 ——
 * 2026-10-24 之前事项详情就是靠这种错配把请求打到案件端点的（见下方注释）。
 */
export type StatusTarget = {
  host: HostKind;
  id: string;
  code: string;
  name: string;
  status: string;
};

/**
 * 状态变更对话框（**案件与事项共用**；列表与详情也共用，所以"什么时候要原因"全站只写一处）。
 *
 * 判定跑的是 `shared/schema/status-transition.ts` 那个**服务层同一个谓词**，输入来自
 * 状态的 `next_status_codes`。之前这里自己写死"closed 与 archived 要原因"，
 * 那是把配置表里的推荐路径抄成前端常量：运营改了 `next_status_codes`，
 * 星号不会跟着改，用户撞的还是服务层那条 422。
 *
 * 防线仍然在服务层（`services/status-change.ts` 认得库里的真实配置）；这里只负责提前把
 * 星号与提示画出来，让用户少撞一次 422。
 *
 * ## 端点按宿主拼（2026-10-24 修的一处真缺陷）
 *
 * 这里原来把 `/api/matters/...` 写死，而事项详情也复用了这个组件 ⇒ 在事项上点
 * 「变更状态」会把请求发到**案件**端点，带着一个事项 id。雪花 id 跨表唯一，所以拿到的是
 * 404 —— 服务端那条路是好的（`smoke-risk.mjs` 一直打着它），坏的是入口。
 * 现在基址由 `target.host` 决定，与 `export-file-button` / `progress-panel` 同一写法。
 *
 * ## 归档就绪只有案件侧有
 *
 * `/api/matters/{id}/archive-readiness` 判的是判决书 / 结案日期 / 未决节点三项，
 * 事项侧没有这三个数据源，所以那道查询与那块提示对事项**不发、不画**。
 * 给事项兜一个空判定会让"没判"看起来像"齐备"（同一个教训见 `archive-readiness` 的
 * `unavailable` 口径）。
 */
export function StatusDialog({
  target,
  statuses,
  open,
  onOpenChange,
  onDone,
  initialTo,
}: {
  target: StatusTarget | null;
  statuses: StatusRow[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
  /**
   * 打开时预选的目标状态。行内点状态胶囊挑了一个**要填原因**的状态时，
   * 由列表页把那个值带进来——否则用户要在弹窗里再选一次同一项。
   */
  initialTo?: string;
}) {
  const [to, setTo] = useState<string | undefined>();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = target?.host === "matter" ? "matters" : "risk-matters";
  /** 归档就绪只有案件侧有那个端点（三项判定的数据源在案件表上） */
  const hasReadiness = target?.host === "matter";

  const fromRow = statuses.find((s) => s.code === target?.status);
  const toRow = statuses.find((s) => s.code === to);
  const reasonRequired = needsChangeReason({
    from: target?.status ?? "",
    fromNextCodes: fromRow?.nextStatusCodes ?? [],
    to: to ?? "",
    toSemantics: toRow?.semantics ?? "",
  });
  const reasonMissing = reasonRequired && reason.trim().length === 0;
  const unchanged = !to || to === target?.status;
  const archiving = toRow?.semantics === "archived";

  /**
   * 归档就绪（F2-26）：只在**选到归档**时才拉。三个出口（详情卡 / 列表筛选 / 这里）
   * 都出自服务端同一条判定，这里不重算。
   *
   * 缺项不阻断归档（IQ-16）：它只是把"你将带着什么归档"提前说清，
   * 并把 reason 从"可选"变成"必填"（`needsChangeReason` 那边已经这么判了）。
   */
  const readinessQ = useQuery({
    queryKey: [target?.host, target?.id, "archive-readiness"],
    queryFn: () =>
      api.get<{ readiness: Readiness | null }>(`/api/${base}/${target?.id}/archive-readiness`),
    enabled: open && archiving && hasReadiness && !!target?.id,
    staleTime: 0,
  });
  const readiness = readinessQ.data?.readiness ?? null;

  useEffect(() => {
    if (open) {
      setTo(initialTo);
      setReason("");
      setError(null);
    }
  }, [open, target?.id, initialTo]);

  async function submit() {
    if (unchanged || reasonMissing || !target) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/${base}/${target.id}/status`, { to, reason: reason.trim() });
      onDone();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "提交失败");
    } finally {
      setBusy(false);
    }
  }

  if (!target) return null;

  return (
    <Modal
      open={open}
      onCancel={() => onOpenChange(false)}
      onOk={submit}
      okText="确认变更"
      okButtonProps={{ disabled: unchanged || reasonMissing }}
      confirmLoading={busy}
      title="变更状态"
      width={460}
    >
      <p style={{ fontSize: 12, color: INK.muted, margin: "4px 0 14px" }}>
        <span className="num">{target.code}</span> · {target.name}
      </p>
      {archiving && hasReadiness ? (
        <Alert
          type={readiness?.missing.length ? "warning" : "info"}
          showIcon
          style={{ marginBottom: 12 }}
          title={
            readinessQ.isPending
              ? "正在核对归档材料…"
              : readinessQ.isError || !readiness
                ? // ⚠ `isError` 与 `readiness === null` 必须走**同一句**：后者是服务端
                  //   自己承认的竞态（详情查到了、再算就绪时案件已删）。初版把 `null`
                  //   落进 else ⇒ 显示"三项都齐备"——把"没有数据"说成"齐备"，
                  //   正是本票反复强调不能做的事。
                  READINESS_UNREADABLE
                : readiness.missing.length
                  ? `${READINESS_MISSING_PREFIX}${readinessMissingText(readiness)}`
                  : READY_TEXT
          }
          description={
            readiness?.missing.length ? (
              <Space orientation="vertical" size={2}>
                <Typography.Text style={{ fontSize: 12 }}>
                  缺项不阻断归档——照样能归，但会记进归档活动，并计入材料完整率。
                </Typography.Text>
                {readiness.unavailable.length ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {UNAVAILABLE_HINT.attachment_not_built}
                  </Typography.Text>
                ) : null}
              </Space>
            ) : readiness?.unavailable.length ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {UNAVAILABLE_HINT.attachment_not_built}——所以「齐备」这句话这次只覆盖已判的两项。
              </Typography.Text>
            ) : undefined
          }
        />
      ) : null}
      <Form layout="vertical" requiredMark={false}>
        <Form.Item
          label="目标状态"
          required
          validateStatus={!to && error ? "error" : undefined}
          help={
            toRow?.semantics === "archived"
              ? "归档后默认从列表消失，撤销归档需专门权限（或 `is_admin`）。"
              : reasonRequired
                ? "这一步不在当前状态的推荐路径上，要写一句为什么。"
                : "走推荐路径，不需要原因；写了会一起进活动记录。"
          }
        >
          <Select
            placeholder="选择要转到的状态"
            value={to}
            onChange={setTo}
            options={statuses
              .filter((s) => s.code !== target.status)
              .map((s) => {
                // 「推荐」两个字就是 `next_status_codes` 的可视化（修订稿 §3.3 第 2 条）。
                // 推荐后继**为空**时一个字都不标 —— 那是"不限制"，不是"全都不推荐"。
                const recommended =
                  (fromRow?.nextStatusCodes.length ?? 0) > 0 &&
                  fromRow?.nextStatusCodes.includes(s.code);
                return { value: s.code, label: recommended ? `${s.name}（推荐）` : s.name };
              })}
          />
        </Form.Item>
        <Form.Item label="原因" required={reasonRequired}>
          <Input.TextArea
            rows={3}
            maxLength={500}
            showCount
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={reasonRequired ? "为什么现在转到这个状态" : "补充说明（选填）"}
          />
          {reasonRequired && reasonMissing ? (
            <span style={{ fontSize: 12, color: BRAND.overdue }}>
              偏离推荐路径或进归档必须写原因
            </span>
          ) : null}
        </Form.Item>
      </Form>
      {error ? <Alert type="error" showIcon title={error} /> : null}
    </Modal>
  );
}
