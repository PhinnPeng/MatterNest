"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  AutoComplete,
  Button,
  Checkbox,
  Col,
  DatePicker,
  Form,
  Input,
  Modal,
  Result,
  Row,
  Select,
  Space,
  Typography,
} from "antd";
import type { Dayjs } from "dayjs";

import {
  api,
  ApiFailure,
  toOptions,
  useMeta,
  usePartySearch,
  type PartyHit,
} from "@/app/lib/client/api";
import { matterCreateSchema, pruneEmpty, type MatterCreateInput } from "@/shared/schema/hosts";
import { rulesFor, setFieldErrors } from "@/app/components/form/zod-rules";

/**
 * 当事人名称框：既是输入框也是「引用既有」的入口（F2-15「关联 + 快速新增」在一个控件里）。
 *
 * 为什么用 AutoComplete 而不是旁边再加一列下拉：780px 的框里这一行已经有名称/类型/诉讼地位/
 * 我方代理/删除五格，再加一格就会在 1366 视口上横向滚动 —— 那是刚被单独修过的一类缺陷。
 *
 * 只在**同名唯一命中**时才落 `partyId`。库里本来就有两家同名公司时（`select` 按名字回填无法
 * 区分是哪一家），宁可不引用：让服务层按 §7.2 的口径新建一行并回 `name_conflicts` 提示，
 * 也比"把 A 公司的案子挂到 B 公司身上"好 —— 后者没有任何一处会报错，而它恰恰是最贵的错。
 */
function PartyNameInput({
  value,
  onChange,
  onPick,
}: {
  value?: string;
  onChange?: (v: string) => void;
  onPick: (hit: PartyHit | null) => void;
}) {
  const [kw, setKw] = useState("");
  const { data } = usePartySearch(kw);
  const hits = data?.items ?? [];
  return (
    <AutoComplete
      value={value ?? ""}
      options={hits.map((p) => ({
        value: p.name,
        label: `${p.name}${p.idNumberTail ? ` · 尾号 ${p.idNumberTail}` : ""}`,
      }))}
      filterOption={false}
      onSearch={setKw}
      // 打字一律先清引用（否则改了名字还带着上一次的 partyId，等于悄悄指向另一个人）；
      // antd 在选中项时是 `onChange` 后紧接 `onSelect`，所以这里清、那里再落，顺序是稳的
      onChange={(v) => {
        onPick(null);
        onChange?.(typeof v === "string" ? v : "");
      }}
      onSelect={(v) => {
        const same = hits.filter((p) => p.name === v);
        if (same.length === 1) onPick(same[0]!);
      }}
      placeholder="名称（输入可引用已登记的当事人）"
    />
  );
}

/**
 * 新建案件。
 *
 * 编号不在表单里：`internal_code` 由服务层在**同一个事务**里向 `mn_code_seq` 单语句取号，
 * 所以提交完才拿得到编号。成功后停在"已建案"把编号显出来——
 * 这是那套编号规则（含日界按上海、溢出扩四位）唯一能被用户感知的时刻。
 *
 * 校验走 `rulesFor(matterCreateSchema, [...])`（禁令⑧ 规则单源），提交时再 `safeParse` 一遍兜底：
 * antd 的 rules 只负责即时提示，真正的形状校验以 schema 为准。
 *
 * 日期故意不挂 rules：`DatePicker` 给的是 dayjs 对象，必须先 `toValues()` 转成
 * `YYYY-MM-DD` 才是 schema 认识的字符串。转换只写在这一处。
 *
 * 「是否我方代理」与「诉讼地位」是**正交**两列（枚举表 E06/E07：同一案件可有多个
 * represented=true 而角色各异），所以是独立 checkbox，不并成一个取值。
 */
type FormValues = Omit<MatterCreateInput, "filingDate" | "parties"> & {
  filingDate?: Dayjs | null;
  parties?: NonNullable<MatterCreateInput["parties"]>;
};

export function MatterCreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const { data: meta } = useMeta("matter");
  const [form] = Form.useForm<FormValues>();
  const mut = useMutation({
    mutationFn: (values: MatterCreateInput) => api.post("/api/matters", values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["matters"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
    },
  });

  useEffect(() => {
    if (open) {
      form.resetFields();
      mut.reset();
    }
  }, [open]);

  const created = mut.data as
    { id: string; internalCode: string; nameConflicts?: { name: string }[] } | undefined;
  /** 当事人区每行的当前值，只用来判断"这一行是不是已经引用了库里的人"（显示引用态） */
  const partyRows = Form.useWatch("parties", form);

  function toValues(v: FormValues): MatterCreateInput {
    const { filingDate, parties, ...rest } = v;
    return {
      ...pruneEmpty(rest),
      filingDate: filingDate ? filingDate.format("YYYY-MM-DD") : undefined,
      // 留 `partyId` 那一批：只引用不填名称也是合法行（名称由库里那一行带来）
      parties: (parties ?? []).filter((p) => p?.partyId || p?.name),
    } as unknown as MatterCreateInput;
  }

  async function submit() {
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    const parsed = matterCreateSchema.safeParse(toValues(values));
    if (!parsed.success) {
      // schema 的错误直接标回字段上：错误文案来自 schema，前端不再抄一份
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
        title="案件已建"
        footer={
          <Space>
            <Button
              onClick={() => {
                form.resetFields();
                mut.reset();
              }}
            >
              再建一条
            </Button>
            <Link href={`/matters/${created.id}`}>
              <Button type="primary">打开案件</Button>
            </Link>
          </Space>
        }
      >
        <Result
          status="success"
          title={<span className="num">{created.internalCode}</span>}
          subTitle="内部编号由数据库取号生成，不可编辑。案号留空时先用它占位，正式立案后回详情改。"
        />
        {/*
          同名当事人不自动合并（`services/parties.ts` 判定 4），但"没合并"这件事必须让人看见：
          库里已有同名行还新建一行，正是当事人详情页"涉及案件"少一半的成因。
          建案已经成功，所以这是**提示**而不是错误，放在 Result 下面而不是挡在提交前。
        */}
        {created.nameConflicts && created.nameConflicts.length > 0 ? (
          <Alert
            type="warning"
            showIcon
            message={`库里已有同名当事人：${created.nameConflicts
              .map((c) => c.name)
              .join("、")}。本案按新建一行登记；确认是同一家请到当事人页合并引用。`}
          />
        ) : null}
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onCancel={() => onOpenChange(false)}
      title="新建案件"
      width={780}
      okText="建案"
      confirmLoading={mut.isPending}
      onOk={submit}
    >
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        scrollToFirstError={{ block: "center", behavior: "smooth" }}
        style={{ marginTop: 8 }}
        initialValues={{ parties: [], description: "", amount: "", caseNo: "", court: "" }}
      >
        {mut.error ? (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12 }}
            message={mut.error instanceof ApiFailure ? mut.error.message : "提交失败"}
          />
        ) : null}

        <Row gutter={12}>
          <Col span={24}>
            <Form.Item label="案件名称" name="name" rules={rulesFor(matterCreateSchema, ["name"])}>
              <Input placeholder="例：甲公司诉乙公司买卖合同纠纷" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label="案由" name="cause" rules={rulesFor(matterCreateSchema, ["cause"])}>
              <Input />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              label="案件类型"
              name="caseType"
              rules={rulesFor(matterCreateSchema, ["caseType"])}
            >
              <Select placeholder="请选择" options={meta ? toOptions(meta.enums.caseTypes) : []} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label="审级 / 程序"
              name="procedure"
              rules={rulesFor(matterCreateSchema, ["procedure"])}
            >
              <Select placeholder="请选择" options={meta ? toOptions(meta.enums.procedures) : []} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label="我方诉讼地位"
              name="litigationRole"
              rules={rulesFor(matterCreateSchema, ["litigationRole"])}
            >
              <Select
                placeholder="请选择"
                options={meta ? toOptions(meta.enums.litigationRoles) : []}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label="受理法院"
              name="court"
              rules={rulesFor(matterCreateSchema, ["court"])}
            >
              <Input />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label="风险等级"
              name="level"
              rules={rulesFor(matterCreateSchema, ["level"])}
              /** 等级是配置表驱动（枚举表 §0），所以下拉从 `/api/meta` 取，不硬编码三档 */
              extra="来自配置表，不是硬编码四档"
            >
              <Select
                placeholder="请选择"
                options={(meta?.levels ?? []).map((l) => ({ value: l.code, label: l.name }))}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label="标的额（元）"
              name="amount"
              rules={rulesFor(matterCreateSchema, ["amount"])}
            >
              <Input placeholder="最多两位小数" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label="正式案号"
              name="caseNo"
              rules={rulesFor(matterCreateSchema, ["caseNo"])}
            >
              <Input placeholder="留空先用内部编号" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="立案日期" name="filingDate">
              <DatePicker style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item
              label="基本情况"
              name="description"
              rules={rulesFor(matterCreateSchema, ["description"])}
            >
              <Input.TextArea rows={3} maxLength={5000} showCount />
            </Form.Item>
          </Col>
        </Row>

        <Form.List name="parties">
          {(fields, { add, remove }) => (
            <Form.Item label="当事人" style={{ marginBottom: 0 }}>
              <Space orientation="vertical" size={6} style={{ display: "flex" }}>
                {fields.map((f) => (
                  <Row key={f.key} gutter={8} align="middle">
                    <Col span={9}>
                      <Form.Item
                        name={[f.name, "name"]}
                        rules={rulesFor(matterCreateSchema, ["parties", 0, "name"])}
                        style={{ marginBottom: 0 }}
                      >
                        <PartyNameInput
                          onPick={(hit) => {
                            // 名字之外的两格跟着引用行走：选了库里这一行，类型就不该再手挑一次
                            form.setFieldValue(
                              ["parties", f.name, "partyId"],
                              hit?.id ?? undefined,
                            );
                            if (hit) form.setFieldValue(["parties", f.name, "type"], hit.type);
                          }}
                        />
                      </Form.Item>
                      {/* 引用态要显出来：没有这一句，用户分不清"改的是全局那一家"还是"只写进本案卷" */}
                      {partyRows?.[f.name]?.partyId ? (
                        <div style={{ fontSize: 12, marginTop: 2 }}>
                          <Typography.Text type="secondary">
                            已引用库中当事人 · 名称是共享信息，会同步到所有案卷
                          </Typography.Text>
                        </div>
                      ) : null}
                    </Col>
                    <Col span={5}>
                      <Form.Item name={[f.name, "type"]} style={{ marginBottom: 0 }}>
                        <Select
                          placeholder="类型"
                          options={meta ? toOptions(meta.enums.partyTypes) : []}
                        />
                      </Form.Item>
                    </Col>
                    <Col span={5}>
                      <Form.Item name={[f.name, "partyRole"]} style={{ marginBottom: 0 }}>
                        <Select
                          placeholder="诉讼地位"
                          options={meta ? toOptions(meta.enums.litigationRoles) : []}
                        />
                      </Form.Item>
                    </Col>
                    <Col span={3}>
                      <Form.Item
                        name={[f.name, "represented"]}
                        valuePropName="checked"
                        style={{ marginBottom: 0 }}
                      >
                        <Checkbox>我方代理</Checkbox>
                      </Form.Item>
                    </Col>
                    <Col span={2}>
                      <Button size="small" onClick={() => remove(f.name)}>
                        删
                      </Button>
                    </Col>
                  </Row>
                ))}
                <div>
                  <Button
                    size="small"
                    onClick={() =>
                      add({
                        name: "",
                        type: "legal_person",
                        partyRole: "plaintiff",
                        represented: true,
                      })
                    }
                  >
                    添加当事人
                  </Button>
                </div>
              </Space>
            </Form.Item>
          )}
        </Form.List>
      </Form>
    </Modal>
  );
}
