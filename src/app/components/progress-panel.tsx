"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { App as AntdApp, Button, DatePicker, Flex, Form, Input, Listy, Modal, Select } from "antd";
import type { Dayjs } from "dayjs";

import { api, ApiFailure, useMeta } from "@/app/lib/client/api";
import { calDate } from "@/app/lib/client/format";
import { StateBlock } from "@/app/components/ui/state-block";
import {
  applyServerIssues,
  rulesFor,
  validateAndFocusFirst,
} from "@/app/components/form/zod-rules";
import { progressSchema } from "@/shared/schema/hosts";

/**
 * 进展面板与「写进展」弹窗，**案件与事项共用一件**。
 *
 * 两张进展表同构（迁移 0021），差别只有端点前缀与标题里的宿主名。各写一份的失败形态
 * 是"事项侧改了校验、案件侧还是旧的"——这类分叉不会报错（与 `node-dialog.tsx` 同一理由）。
 *
 * 口径（用户 2026-10-23 定）：「处置记录」= 评论对话；进展 = 结构化办理记录
 * （类型 / 发生日期 / 内容 / 下一步 / 可挂节点）。
 */
type Host = "matter" | "risk_matter";

export type ProgressItem = {
  id: string;
  progressType: string;
  content: string;
  nextPlan: string | null;
  progressDate: string;
  createdAt: string;
  author: string;
};

export function ProgressPanel({
  host,
  hostId,
  progress,
  onDone,
  readOnly = false,
}: {
  host: Host;
  hostId: string;
  progress: ProgressItem[];
  onDone: () => void;
  /** 归档后只读：不出现「写进展」 */
  readOnly?: boolean;
}) {
  const { data: meta } = useMeta(host);
  const [open, setOpen] = useState(false);
  const label = host === "matter" ? "案件进展" : "事项进展";

  return (
    <>
      <Flex justify="space-between" align="center" style={{ paddingBlock: 12 }}>
        <div style={{ fontSize: 13 }}>
          {label} ({progress.length})
        </div>
        {readOnly ? null : (
          <Button size="small" onClick={() => setOpen(true)}>
            写进展
          </Button>
        )}
      </Flex>
      {progress.length ? (
        <Listy
          items={progress}
          rowKey={(p) => p.id}
          itemRender={(p) => (
            // 纵向排：类型/日期一行、正文一块、下一步一行。
            // 横排（类型·日期·正文·下一步·作者五列）在窄屏会把标签压成竖排字，
            // 案件与事项共用这一处，别再各写一份。
            <div style={{ paddingBlock: 6 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <span style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span style={{ fontSize: 13, whiteSpace: "nowrap" }}>
                    {meta?.enums.progressTypes[p.progressType] ?? p.progressType}
                  </span>
                  <span className="num mut3" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                    {calDate(p.progressDate)}
                  </span>
                </span>
                <span className="mut3" style={{ fontSize: 11 }}>
                  {p.author}
                </span>
              </div>
              <div style={{ fontSize: 13, whiteSpace: "pre-wrap", marginTop: 4 }}>{p.content}</div>
              {p.nextPlan ? (
                <div className="mut" style={{ fontSize: 12, marginTop: 4 }}>
                  下一步：{p.nextPlan}
                </div>
              ) : null}
            </div>
          )}
        />
      ) : (
        <StateBlock
          title="还没有进展记录"
          hint={
            host === "matter"
              ? "日常推进、法院动作这类过程记录登记在这里；记一条会刷新「最近进展」。"
              : "办理过程（沟通、报送、内部决定）登记在这里；讨论与 @同事走右侧「处置记录」。"
          }
        />
      )}

      <ProgressLogDialog
        host={host}
        hostId={hostId}
        open={open}
        onClose={() => setOpen(false)}
        onDone={onDone}
      />
    </>
  );
}

/**
 * 写一条进展。
 *
 * 校验规则从 `shared/schema/hosts` 的 `progressSchema` 推导（`rulesFor`），
 * 提交时服务端用**同一个 schema** 再判一次 —— 前端不手写第二套规则（禁令⑧）。
 *
 * `nodeId` 由"完成节点后立刻写进展"那条路径传入（可跳过）；表单里不出现节点选择器。
 */
export function ProgressLogDialog({
  host,
  hostId,
  nodeId,
  open,
  onClose,
  onDone,
}: {
  host: Host;
  hostId: string;
  nodeId?: string;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const { data: meta } = useMeta(host);
  const qc = useQueryClient();
  const [form] = Form.useForm<{
    progressType: string;
    progressDate: Dayjs;
    content: string;
    nextPlan?: string;
  }>();
  const base = host === "matter" ? "matters" : "risk-matters";

  const mut = useMutation({
    mutationFn: (v: {
      progressType: string;
      progressDate: string;
      content: string;
      nextPlan?: string;
      nodeId?: string;
    }) => api.post<{ id: string }>(`/api/${base}/${hostId}/progress`, v),
    onSuccess: () => {
      onClose();
      message.success("进展已记录");
      // 工作台的「近期活动」按 last_progress_at 排序：记完就该立刻变，
      // 别等 60s 的 stale 窗口（其余写路径也都失效 overview）。
      void qc.invalidateQueries({ queryKey: ["overview"] });
      onDone();
    },
    onError: (e) => {
      if (e instanceof ApiFailure) {
        applyServerIssues(form, e.issues);
        message.error(e.message);
        return;
      }
      message.error("提交失败");
    },
  });

  return (
    <Modal
      open={open}
      title="写进展"
      okText="记录"
      cancelText="取消"
      confirmLoading={mut.isPending}
      destroyOnHidden
      onCancel={onClose}
      onOk={async () => {
        const v = await validateAndFocusFirst(form);
        if (!v) return;
        // DatePicker 可被清空；onOk 是 async 而 antd 不 await 它，直接 `.format` 抛错
        // 的表现是「点了没反应」——先拦一次，别赌 required 规则一定在
        if (!v.progressDate) {
          form.setFields([{ name: "progressDate", errors: ["请选择发生日期"] }]);
          return;
        }
        mut.mutate({
          progressType: v.progressType,
          // 表单里存 Dayjs，提交前一处转 `YYYY-MM-DD`：`progressDate` 是 `date` 列，
          // 服务端 schema 也只收这个形状
          progressDate: v.progressDate.format("YYYY-MM-DD"),
          content: v.content,
          nextPlan: v.nextPlan ?? "",
          ...(nodeId ? { nodeId } : {}),
        });
      }}
    >
      <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
        <Form.Item
          name="progressType"
          label="进展类型"
          rules={rulesFor(progressSchema, ["progressType"])}
        >
          <Select
            placeholder="选择进展类型"
            options={Object.entries(meta?.enums.progressTypes ?? {}).map(([value, label]) => ({
              value,
              label,
            }))}
          />
        </Form.Item>
        <Form.Item
          name="progressDate"
          label="发生日期"
          rules={rulesFor(progressSchema, ["progressDate"])}
        >
          <DatePicker style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="content" label="进展内容" rules={rulesFor(progressSchema, ["content"])}>
          <Input.TextArea rows={3} maxLength={4000} placeholder="发生了什么" />
        </Form.Item>
        <Form.Item name="nextPlan" label="下一步" rules={rulesFor(progressSchema, ["nextPlan"])}>
          <Input.TextArea rows={2} maxLength={2000} placeholder="接下来打算做什么" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
