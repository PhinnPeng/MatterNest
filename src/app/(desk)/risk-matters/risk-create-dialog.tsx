"use client";

import { useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Col,
  DatePicker,
  Form,
  Input,
  Modal,
  Result,
  Row,
  Select,
  Space,
} from "antd";
import type { Dayjs } from "dayjs";

import { api, ApiFailure, toOptions, useMeta } from "@/app/lib/client/api";
import { pruneEmpty, riskCreateSchema, type RiskCreateInput } from "@/shared/schema/hosts";
import { rulesFor, setFieldErrors } from "@/app/components/form/zod-rules";

/**
 * 新建风险事项（报备）。编号 `FX-YYYYMMDD-XXX` 同样由数据库单语句取号。
 *
 * 风险描述必填是规格要求：它是"这件事够不够条件立案"的判断依据，不是一句标题。
 * 来源允许留空——来源不明的风险也要能报备（那一列可空，DB 的 CHECK 也放过了 NULL）。
 */
type FormValues = Omit<RiskCreateInput, "discoverDate"> & { discoverDate?: Dayjs | null };

export function RiskCreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const { data: meta } = useMeta("risk_matter");
  const [form] = Form.useForm<FormValues>();
  const mut = useMutation({
    mutationFn: (values: RiskCreateInput) =>
      api.post<{ id: string; code: string }>("/api/risk-matters", values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["risk-matters"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
    },
  });

  useEffect(() => {
    if (open) {
      form.resetFields();
      mut.reset();
    }
  }, [open]);

  const created = mut.data;

  async function submit() {
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    const { discoverDate, ...rest } = values;
    const parsed = riskCreateSchema.safeParse(
      pruneEmpty({
        ...rest,
        discoverDate: discoverDate ? discoverDate.format("YYYY-MM-DD") : undefined,
      }),
    );
    if (!parsed.success) {
      setFieldErrors(form, parsed.error.issues);
      return;
    }
    mut.mutate(parsed.data);
  }

  if (created) {
    return (
      <Modal
        open={open}
        onCancel={() => onOpenChange(false)}
        title="事项已报备"
        footer={
          <Space>
            <Button
              onClick={() => {
                form.resetFields();
                mut.reset();
              }}
            >
              再报一条
            </Button>
            <Button type="primary" onClick={() => onOpenChange(false)}>
              完成
            </Button>
          </Space>
        }
      >
        <Result
          status="success"
          title={<span className="num">{created.code}</span>}
          subTitle="编号由数据库取号生成；之后转案件时两本台账靠外键连着。"
        />
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onCancel={() => onOpenChange(false)}
      title="新建风险事项"
      width={640}
      okText="报备"
      confirmLoading={mut.isPending}
      onOk={submit}
    >
      {mut.error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={mut.error instanceof ApiFailure ? mut.error.message : "提交失败"}
        />
      ) : null}
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        scrollToFirstError={{ block: "center", behavior: "smooth" }}
        initialValues={{ amount: "", source: "" }}
      >
        <Row gutter={12}>
          <Col span={24}>
            <Form.Item label="事项名称" name="name" rules={rulesFor(riskCreateSchema, ["name"])}>
              <Input />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="风险类型" name="type" rules={rulesFor(riskCreateSchema, ["type"])}>
              <Select placeholder="请选择" options={meta ? toOptions(meta.enums.riskTypes) : []} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="风险等级" name="level" rules={rulesFor(riskCreateSchema, ["level"])}>
              <Select
                placeholder="请选择"
                options={(meta?.levels ?? []).map((l) => ({ value: l.code, label: l.name }))}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label="来源"
              name="source"
              rules={rulesFor(riskCreateSchema, ["source"])}
              extra="可空：来源不明的风险也要能报备"
            >
              <Select
                allowClear
                placeholder="请选择"
                options={meta ? toOptions(meta.enums.riskSources) : []}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label="预估影响（元）"
              name="amount"
              rules={rulesFor(riskCreateSchema, ["amount"])}
            >
              <Input placeholder="最多两位小数" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="发现日期" name="discoverDate" extra="留空按今天记">
              <DatePicker style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item
              label="风险描述"
              name="description"
              rules={rulesFor(riskCreateSchema, ["description"])}
            >
              <Input.TextArea
                rows={3}
                maxLength={5000}
                showCount
                placeholder="这件事为什么会变成诉讼或损失"
              />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item
              label="已采取措施"
              name="measure"
              rules={rulesFor(riskCreateSchema, ["measure"])}
            >
              <Input.TextArea rows={2} maxLength={5000} />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}
