"use client";

import { BRAND, INK } from "@/app/theme/brand";
import { useEffect, useState } from "react";
import { Alert, Form, Input, Modal, Select } from "antd";

import { api, ApiFailure, type StatusRow } from "@/app/lib/client/api";

/** 归档/结案这两个语义要求原因（与 `services/matters.ts:changeStatus` 同一判据） */
const REASON_SEMANTICS = new Set(["closed", "archived"]);

export type StatusTarget = { id: string; code: string; name: string; status: string };

/**
 * 案件状态变更对话框（列表与详情共用一个实现，所以"归档要填原因"这条规则全站只写一处）。
 *
 * 原因必填的**判定在服务层**（它才知道目标态的 semantics，那才是防线）；
 * 这里只是提前把星号与提示画出来，让用户少撞一次 422。
 * 一个是防线、一个是体验，少画星号系统照样正确——所以这处"重复"是有意的，别去合它。
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

  const semantics = statuses.find((s) => s.code === to)?.semantics;
  const reasonRequired = REASON_SEMANTICS.has(semantics ?? "");
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
            semantics === "archived"
              ? "归档后默认从列表消失，撤销归档需专门权限。"
              : semantics === "closed"
                ? "结案会写入结案日期，与归档互不影响。"
                : "这个状态不需要原因，写了会一起进活动记录。"
          }
        >
          <Select
            placeholder="选择要转到的状态"
            value={to}
            onChange={setTo}
            options={statuses
              .filter((s) => s.code !== target.status)
              .map((s) => ({ value: s.code, label: s.name }))}
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
            <span style={{ fontSize: 12, color: BRAND.overdue }}>结案与归档必须写原因</span>
          ) : null}
        </Form.Item>
      </Form>
      {error ? <Alert type="error" showIcon message={error} /> : null}
    </Modal>
  );
}
