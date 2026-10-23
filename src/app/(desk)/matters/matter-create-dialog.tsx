"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  AutoComplete,
  Button,
  Col,
  DatePicker,
  Form,
  Input,
  Modal,
  Row,
  Select,
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
  type PartySearchResult,
} from "@/app/lib/client/api";
import { matterCreateSchema, pruneEmpty, type MatterCreateInput } from "@/shared/schema/hosts";
import { rulesFor, setFieldErrors, validateAndFocusFirst } from "@/app/components/form/zod-rules";
import {
  FollowersField,
  OwnerField,
  PeopleLoadHint,
  toPeopleOptions,
  useCreatePeople,
} from "@/app/components/ui/people-fields";

/**
 * 当事人名称框：既是输入框也是「引用既有」的入口（F2-15「关联 + 快速新增」在一个控件里）。
 *
 * 为什么用 AutoComplete 而不是旁边再加一列下拉：780px 的框里这一行已经有名称/类型/诉讼地位/
 * 我方代理/删除五格，再加一格就会在 1366 视口上横向滚动 —— 那是刚被单独修过的一类缺陷。
 *
 * 只在**同名唯一命中**时才落 `partyId`。库里本来就有两家同名公司时（`select` 按名字回填无法
 * 区分是哪一家），宁可不引用：让服务层按 §7.2 的口径新建一行并回 `name_conflicts` 提示，
 * 也比"把 A 公司的案子挂到 B 公司身上"好 —— 后者没有任何一处会报错，而它恰恰是最贵的错。
 *
 * 两种提示都挂在**输入框正下方**（落点②「字段说明」，规则类的话搬到动作发生处）：
 *   · 输入的是**本企业名** → 当场说清我方不入当事人表（IQ-7）。服务层在写路径上也会拒
 *     （`planPartyLinks` 抛 `OwnCompanyPartyError`），这里只是让用户不必先撞一次 400；
 *   · 库里已有**同名** → 说明提交会另建一行，并给出下一步（建案后到当事人页合并）。
 *     自动合并会稀释对手画像（US-M3-2），所以这里不能"顺手并掉"。
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
  /**
   * `ownCompany` 是 `/api/parties?q=` 这次新增的字段（判定在服务端一处实现），
   * 而 `usePartySearch` 的返回类型住在 `api.ts`（本票写范围外），所以这里做一次
   * **窄化读取**而不是去改那个类型。等父代理把 `PartySearchResult` 补上这个字段，
   * 这一段就能退化成 `data?.ownCompany`。
   */
  const ownCompany =
    (data as (PartySearchResult & { ownCompany?: boolean }) | undefined)?.ownCompany === true;
  const typed = (value ?? "").trim();
  const sameName = typed ? hits.filter((p) => p.name === typed) : [];

  return (
    <div>
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
      {ownCompany ? (
        <div style={{ fontSize: 12, marginTop: 2 }}>
          <Typography.Text type="danger">
            这是本企业名称：我方不入当事人表，这一行请填对方当事人或第三人
          </Typography.Text>
        </div>
      ) : sameName.length > 0 ? (
        <div style={{ fontSize: 12, marginTop: 2 }}>
          <Typography.Text type="secondary">
            库里已有同名档案 {sameName.length}{" "}
            份：提交会新建一行；确认是同一家，建案后到当事人页合并
          </Typography.Text>
        </div>
      ) : null}
    </div>
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
 * 曾经的「是否我方代理」复选框已随 IQ-15 移除：企业口径下我方永不入当事人表，
 * 那个布尔（E07 `represented`）的参照系是律所代理关系。我方提诉还是应诉由本表单上
 * 那个**必填**的 `litigation_role`（我方诉讼地位）表达，语义没有丢。
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
  // 处理人/关注人的候选（IQ-14 创建期例外）。**在表单外拉一次**，两个字段共用同一份
  const peopleQ = useCreatePeople();
  const people = toPeopleOptions(peopleQ.data?.users ?? []);
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
    const values = await validateAndFocusFirst(form);
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
        width={520}
        footer={
          <div className="rowflex" style={{ justifyContent: "space-between" }}>
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
          </div>
        }
      >
        {/* canon 的成功态：状态行（点 + 词）+ 大号编号（那串码是这一屏唯一主角）+
            一行事实。编号口径见 canon-spec §29：**不写「提交后生成」那类旁白**，
            成功页出现编号本身就是事实。 */}
        <div className="pill ok" style={{ marginBottom: 10 }}>
          <i />
          已受理
        </div>
        <div className="num" style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>
          {created.internalCode}
        </div>
        <div className="mut" style={{ fontSize: 12, marginTop: 8 }}>
          内部编号由数据库取号，不可编辑。正式案号留空时先用它占位，立案后回详情改。
        </div>
        {/*
          同名当事人不自动合并（`services/parties.ts` 判定 4），但"没合并"这件事必须让人看见：
          库里已有同名行还新建一行，正是当事人详情页"涉及案件"少一半的成因。
          建案已经成功，所以这是**提示**而不是错误，放在编号下面而不是挡在提交前（`.hint.warn`）。
        */}
        {created.nameConflicts && created.nameConflicts.length > 0 ? (
          <div className="hint warn">
            库里已有同名当事人：{created.nameConflicts.map((c) => c.name).join("、")}
            。本案按新建一行登记；确认是同一家请到当事人页合并引用。
          </div>
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
            title={mut.error instanceof ApiFailure ? mut.error.message : "提交失败"}
          />
        ) : null}

        {/* 分区标题（canon `.fsec`）与字段顺序按 canon-spec §28 的逻辑配对：
            案名 → 案由/类型 → 我方地位/程序 → 法院/案号 → 立案/风险等级 → 标的额 → 当事人
            → 办理与关注 → 基本情况。**每行最多两个字段**（span 12 或 24），不再用三格一行。 */}
        <div className="fsec">基本信息</div>
        <Row gutter={[16, 0]}>
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
          <Col span={12}>
            <Form.Item
              label="审级 / 程序"
              name="procedure"
              rules={rulesFor(matterCreateSchema, ["procedure"])}
            >
              <Select placeholder="请选择" options={meta ? toOptions(meta.enums.procedures) : []} />
            </Form.Item>
          </Col>
          <Col span={12}>
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
          <Col span={12}>
            <Form.Item
              label="受理法院"
              name="court"
              rules={rulesFor(matterCreateSchema, ["court"])}
            >
              <Input />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              label="正式案号"
              name="caseNo"
              rules={rulesFor(matterCreateSchema, ["caseNo"])}
            >
              <Input placeholder="留空先用内部编号" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label="立案日期" name="filingDate">
              <DatePicker style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col span={12}>
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
          <Col span={12}>
            <Form.Item
              label="标的额（元）"
              name="amount"
              rules={rulesFor(matterCreateSchema, ["amount"])}
            >
              <Input placeholder="最多两位小数" />
            </Form.Item>
          </Col>
        </Row>

        <Form.List name="parties">
          {(fields, { add, remove }) => (
            <Form.Item label="当事人" style={{ marginBottom: 0 }}>
              {/*
                表格形态（2026-10-21 用户裁定）：名称 / 类型 / 诉讼地位 / 操作 四列。
                原来是每行四个平铺字段，列宽靠 `Col span` 猜；收成表格之后列头直接
                交代"这一列填什么"，增删行时各列也天然对齐。走 `.tbform` 而不是
                `DataTable`：这是表单控件排布，没有服务端分页/排序/筛选。
              */}
              <table className="tbform">
                <thead>
                  <tr>
                    <th style={{ width: "48%" }}>名称</th>
                    <th style={{ width: "20%" }}>类型</th>
                    <th style={{ width: "22%" }}>诉讼地位</th>
                    <th style={{ width: 56 }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {fields.length === 0 ? (
                    <tr>
                      <td colSpan={4} style={{ color: "var(--ink3)", fontSize: 12 }}>
                        尚未添加当事人
                      </td>
                    </tr>
                  ) : null}
                  {fields.map((f) => (
                    <tr key={f.key}>
                      <td>
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
                      </td>
                      <td>
                        <Form.Item name={[f.name, "type"]} style={{ marginBottom: 0 }}>
                          <Select
                            placeholder="类型"
                            options={meta ? toOptions(meta.enums.partyTypes) : []}
                          />
                        </Form.Item>
                      </td>
                      <td>
                        <Form.Item name={[f.name, "partyRole"]} style={{ marginBottom: 0 }}>
                          <Select
                            placeholder="诉讼地位"
                            options={meta ? toOptions(meta.enums.litigationRoles) : []}
                          />
                        </Form.Item>
                      </td>
                      <td>
                        <Button size="small" onClick={() => remove(f.name)}>
                          删
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginTop: 8 }}>
                <Button
                  size="small"
                  onClick={() =>
                    add({
                      name: "",
                      type: "legal_person",
                      partyRole: "plaintiff",
                    })
                  }
                >
                  添加当事人
                </Button>
              </div>
            </Form.Item>
          )}
        </Form.List>

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

        <div className="fsec">其他</div>
        <Row gutter={[16, 0]}>
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
      </Form>
    </Modal>
  );
}
