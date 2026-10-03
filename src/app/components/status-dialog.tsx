"use client";

import { BRAND, INK } from "@/app/theme/brand";
import { useEffect, useState } from "react";
import { Alert, Form, Input, Modal, Select } from "antd";

import { api, ApiFailure, type StatusRow } from "@/app/lib/client/api";
import { needsChangeReason } from "@/shared/schema/status-transition";

export type StatusTarget = { id: string; code: string; name: string; status: string };

/**
 * 案件状态变更对话框（列表与详情共用一个实现，所以"什么时候要原因"全站只写一处）。
 *
 * 判定跑的是 `shared/schema/status-transition.ts` 那个**服务层同一个函数**，输入来自
 * `/api/meta` 的 `nextStatusCodes`。之前这里自己写死"closed 与 archived 要原因"，
 * 那是把配置表里的推荐路径抄成前端常量：运营改了 `next_status_codes`，
 * 星号不会跟着改，用户撞的还是服务层那条 422。
 *
 * 防线仍然在服务层（它才认得库里的真实配置）；这里只负责提前把星号与提示画出来，
 * 让用户少撞一次 422。
 *
 * 一期只做**案件**侧：事项侧的状态流转要另写一条 `changeRiskStatus`
 * （归档位、结案日期各一张表），而本次 Demo 的事项动作是"转案件"，
 * 所以这里不假装支持。
 */
export function StatusDialog({
  target,
  statuses,
  open,
  onOpenChange,
  onDone,
}: {
  target: StatusTarget | null;
  statuses: StatusRow[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const [to, setTo] = useState<string | undefined>();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    if (open) {
      setTo(undefined);
      setReason("");
      setError(null);
    }
  }, [open, target?.id]);

  async function submit() {
    if (unchanged || reasonMissing || !target) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/matters/${target.id}/status`, { to, reason: reason.trim() });
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
      {error ? <Alert type="error" showIcon message={error} /> : null}
    </Modal>
  );
}
