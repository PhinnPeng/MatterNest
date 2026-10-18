"use client";

import { useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Col, DatePicker, Form, Input, Modal, Row, Select } from "antd";
import type { Dayjs } from "dayjs";

import { api, ApiFailure, toOptions, useMeta } from "@/app/lib/client/api";
import { pruneEmpty, riskCreateSchema, type RiskCreateInput } from "@/shared/schema/hosts";
import { rulesFor, setFieldErrors, validateAndFocusFirst } from "@/app/components/form/zod-rules";
import {
  FollowersField,
  OwnerField,
  PeopleLoadHint,
  toPeopleOptions,
  useCreatePeople,
} from "@/app/components/ui/people-fields";
import { RichTextFormField } from "@/app/components/ui/rich-text";

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
  // 处理人/关注人的候选（IQ-14 创建期例外）。在表单外拉一次，两个字段共用同一份
  const peopleQ = useCreatePeople();
  const people = toPeopleOptions(peopleQ.data?.users ?? []);
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
    const values = await validateAndFocusFirst(form);
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
        width={520}
        footer={
          <div className="rowflex" style={{ justifyContent: "space-between" }}>
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
          </div>
        }
      >
        {/* canon 的成功态（canon-spec §31）：状态行（点 + 词）+ 编号 + 一行事实 */}
        <div className="pill ok" style={{ marginBottom: 10 }}>
          <i />
          待评估
        </div>
        <div className="num" style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>
          {created.code}
        </div>
        <div className="mut" style={{ fontSize: 12, marginTop: 8 }}>
          编号由数据库取号；之后转案件时两本台账靠外键连着。
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onCancel={() => onOpenChange(false)}
      title="新建事项"
      width={520}
      okText="报备"
      confirmLoading={mut.isPending}
      // 富文本编辑器只在挂载时读一次初值；关闭即销毁，重开才拿到干净的空白草稿
      destroyOnHidden
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
        {/* 三个分区（canon `.fsec`）与字段顺序按 canon-spec §30 的逻辑配对：
            事项名称 → 风险类型/等级 → 来源/发现日期 → 预估影响 → 描述（富文本）→ 已采取措施
            → 处理人/关注人。**每行最多两个字段**（原为此前 span8 三格一行，违反契约）。 */}
        <div className="fsec">基本信息</div>
        <Row gutter={[16, 0]}>
          <Col span={24}>
            <Form.Item label="事项名称" name="name" rules={rulesFor(riskCreateSchema, ["name"])}>
              <Input />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label="风险类型" name="type" rules={rulesFor(riskCreateSchema, ["type"])}>
              <Select placeholder="请选择" options={meta ? toOptions(meta.enums.riskTypes) : []} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label="风险等级" name="level" rules={rulesFor(riskCreateSchema, ["level"])}>
              <Select
                placeholder="请选择"
                options={(meta?.levels ?? []).map((l) => ({ value: l.code, label: l.name }))}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
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
          <Col span={12}>
            <Form.Item label="发现日期" name="discoverDate" extra="留空按今天记">
              <DatePicker style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item
              label="预估影响（元）"
              name="amount"
              rules={rulesFor(riskCreateSchema, ["amount"])}
            >
              <Input placeholder="最多两位小数" />
            </Form.Item>
          </Col>
        </Row>

        <div className="fsec">情况与处置</div>
        <Row gutter={[16, 0]}>
          <Col span={24}>
            {/* 描述是富文本（MATT-57 / ADR-0002）：markdown 存储，BlockNote 编辑。
                仍是 `Form.Item name + rules` —— 校验单一来源不破（Zod 经 zod-rules 推导）。
                antd 会把 `value`/`onChange` 注进直接子节点；编辑器挂载后忽略 `value`
                （只认 initialMarkdown），所以每次 onChange 回流不会重解析、光标不跳；
                onChange(string) 正好是 Form 要的取值形状。重开靠 Modal 的 destroyOnHidden
                整棵子树重挂，草稿态自然清零。 */}
            <Form.Item
              label="描述"
              name="description"
              rules={rulesFor(riskCreateSchema, ["description"])}
            >
              <RichTextFormField />
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

        <div className="fsec">办理与关注</div>
        <Row gutter={[16, 0]}>
          {/* 处理人与关注人（MATT-49 / IQ-5 / IQ-14）：选人面走创建期例外，
              见 people-fields.tsx 的文件头注（与详情页那个选择面不是同一个数据源）。 */}
          <Col span={12}>
            <OwnerField options={people} />
          </Col>
          <Col span={12}>
            <FollowersField options={people} />
          </Col>
          <Col span={24}>
            <PeopleLoadHint isError={peopleQ.isError} isPending={peopleQ.isPending} />
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}
