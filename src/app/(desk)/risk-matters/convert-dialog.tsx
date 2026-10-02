"use client";

import { INK } from "@/app/theme/brand";
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
import { convertSchema, pruneEmpty, type MatterCreateInput } from "@/shared/schema/hosts";
import { rulesFor, setFieldErrors } from "@/app/components/form/zod-rules";

type RiskRow = { id: string; code: string; name: string; level: string } | null;

/**
 * 事项 → 案件（修订稿 §3.4 / 映射矩阵 §2）。
 *
 * 表单里**没有金额与描述**两个字段，这不是省略：master P0-1 的裁定是
 * "金额不继承、描述不整体搬"——事项那条描述是给内部报备看的，
 * 直接抄进案卷会让后来的人以为它已经被确认过。等级默认带过来（同一条风险的等级
 * 当然还是案件的等级），但可以改。
 *
 * 成功后不立刻关框：新案件的内部编号要让人看见并确认一眼，再点"打开案件"跳过去。
 * 这条链上最难查的故障是"案件建好了但事项还显示未转"，所以这里同时把两边编号都给出来。
 */
type FormValues = Partial<Omit<MatterCreateInput, "filingDate">> & { filingDate?: Dayjs | null };

export function ConvertDialog({
  source,
  onClose,
  onOpenCase,
}: {
  source: RiskRow;
  onClose: () => void;
  onOpenCase: (caseId: string) => void;
}) {
  const qc = useQueryClient();
  const { data: meta } = useMeta("matter");
  const [form] = Form.useForm<FormValues>();
  const open = source !== null;

  const mut = useMutation({
    mutationFn: (values: MatterCreateInput) =>
      api.post<{ id: string; internalCode: string }>(
        `/api/risk-matters/${source?.id}/convert`,
        values,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["risk-matters"] });
      qc.invalidateQueries({ queryKey: ["matters"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
    },
  });

  useEffect(() => {
    if (source) {
      form.resetFields();
      mut.reset();
      form.setFieldsValue({ name: source.name, level: source.level });
    }
  }, [source?.id]);

  const created = mut.data;

  async function submit() {
    if (!source) return;
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    const { filingDate, ...rest } = values;
    const parsed = convertSchema.safeParse(
      pruneEmpty({ ...rest, filingDate: filingDate ? filingDate.format("YYYY-MM-DD") : undefined }),
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
        onCancel={onClose}
        title="案件已建"
        footer={
          <Space>
            <Button onClick={onClose}>留在事项列表</Button>
            <Button type="primary" onClick={() => onOpenCase(created.id)}>
              打开案件
            </Button>
          </Space>
        }
      >
        <Result
          status="success"
          title={<span className="num">{created.internalCode}</span>}
          subTitle={`来源事项 ${source?.code} 已标为「已转」，两本台账靠外键连着。金额与描述按规格不继承，进案件里补。`}
        />
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="转为案件"
      width={660}
      okText="转为案件"
      confirmLoading={mut.isPending}
      onOk={submit}
    >
      <p style={{ fontSize: 12, color: INK.muted, margin: "4px 0 12px" }}>
        来源事项 <span className="num">{source?.code}</span> · {source?.name}
      </p>
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
      >
        <Row gutter={12}>
          <Col span={24}>
            <Form.Item label="案件名称" name="name" rules={rulesFor(convertSchema, ["name"])}>
              <Input />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label="案由" name="cause" rules={rulesFor(convertSchema, ["cause"])}>
              <Input />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              label="风险等级"
              name="level"
              rules={rulesFor(convertSchema, ["level"])}
              extra="默认沿用事项等级，可改"
            >
              <Select
                placeholder="请选择"
                options={(meta?.levels ?? []).map((l) => ({ value: l.code, label: l.name }))}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label="案件类型"
              name="caseType"
              rules={rulesFor(convertSchema, ["caseType"])}
            >
              <Select placeholder="请选择" options={meta ? toOptions(meta.enums.caseTypes) : []} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label="审级 / 程序"
              name="procedure"
              rules={rulesFor(convertSchema, ["procedure"])}
            >
              <Select placeholder="请选择" options={meta ? toOptions(meta.enums.procedures) : []} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label="我方诉讼地位"
              name="litigationRole"
              rules={rulesFor(convertSchema, ["litigationRole"])}
            >
              <Select
                placeholder="请选择"
                options={meta ? toOptions(meta.enums.litigationRoles) : []}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="受理法院" name="court" rules={rulesFor(convertSchema, ["court"])}>
              <Input />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="立案日期" name="filingDate">
              <DatePicker style={{ width: "100%" }} />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}
