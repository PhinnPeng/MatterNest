"use client";

import { useEffect } from "react";
import { App as AntdApp, DatePicker, Form, Input, Modal } from "antd";
import { useMutation } from "@tanstack/react-query";
import dayjs, { type Dayjs } from "dayjs";

import { api, ApiFailure } from "@/app/lib/client/api";
import { applyServerIssues } from "@/app/components/form/zod-rules";

/**
 * 新增 / 编辑节点（2026-10-23 裁定：字段只有名称、描述、时间）。
 *
 * ## 为什么案件与事项共用一件
 *
 * 两侧的节点表是同构的，字段口径也刚被拉平（都不选类型、都允许随时编辑）。
 * 各写一个的失败形态是"事项侧改了提示语、案件侧还是旧的"——这类分叉不会报错，
 * 只会让人以为两边不是同一个功能。
 *
 * ## 时间为什么用 `showTime`
 *
 * 节点的提醒按 `deadline_time` 扫，只到日期会让"开庭 9:30"退化成"当天任意时刻"。
 * 提交时统一转 ISO（服务端 schema 同时接受 `YYYY-MM-DD` 与 ISO，脚本还在用前者）。
 */
export type NodeSeed = {
  id: string;
  name: string;
  remark: string | null;
  startTime: string | null;
};

export function NodeDialog({
  open,
  onClose,
  onDone,
  host,
  hostId,
  node,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  host: "matter" | "risk_matter";
  hostId: string;
  /** 传了就是编辑，不传就是新增 */
  node?: NodeSeed | null;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<{ name: string; description?: string; startTime: Dayjs }>();
  const base =
    host === "matter" ? `/api/matters/${hostId}/nodes` : `/api/risk-matters/${hostId}/nodes`;

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      name: node?.name ?? "",
      description: node?.remark ?? "",
      startTime: node?.startTime ? dayjs(node.startTime) : undefined,
    });
  }, [open, node, form]);

  const mut = useMutation({
    mutationFn: (v: { name: string; description?: string; startTime: string }) =>
      node ? api.patch<unknown>(`${base}/${node.id}`, v) : api.post<unknown>(base, v),
    onSuccess: () => {
      message.success(node ? "节点已更新" : "已添加节点");
      onClose();
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
      title={node ? "编辑节点" : "新增节点"}
      okText={node ? "保存" : "添加"}
      cancelText="取消"
      confirmLoading={mut.isPending}
      destroyOnHidden
      onCancel={onClose}
      onOk={() => {
        void form.validateFields().then(
          (v) =>
            mut.mutate({
              name: v.name,
              description: v.description ?? "",
              // 时间必填：没有时间的节点进不了提醒扫描，就失去了存在意义
              startTime: v.startTime.toISOString(),
            }),
          () => undefined,
        );
      }}
    >
      <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
        <Form.Item
          name="name"
          label="节点名称"
          rules={[{ required: true, message: "请填写节点名称" }]}
        >
          <Input maxLength={128} placeholder="例如：一审开庭" />
        </Form.Item>
        <Form.Item name="description" label="节点描述">
          <Input.TextArea
            autoSize={{ minRows: 2, maxRows: 4 }}
            maxLength={2000}
            placeholder="需要谁配合、材料在哪、注意事项"
          />
        </Form.Item>
        <Form.Item
          name="startTime"
          label="节点时间"
          rules={[{ required: true, message: "请选择时间" }]}
        >
          <DatePicker showTime format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
