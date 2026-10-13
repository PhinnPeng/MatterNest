"use client";

import { INK } from "@/app/theme/brand";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Col,
  DatePicker,
  Flex,
  Form,
  Input,
  Modal,
  Result,
  Row,
  Select,
  Space,
  Tag,
  theme,
  Typography,
} from "antd";
import { CopyOutlined, DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import type { Dayjs } from "dayjs";

import { api, ApiFailure, toOptions, useMeta } from "@/app/lib/client/api";
import {
  convertSchema,
  convertCardSchema,
  pruneEmpty,
  type MatterCreateInput,
} from "@/shared/schema/hosts";
import type { z } from "zod";
import { rulesFor, setFieldErrors, validateAndFocusFirst } from "@/app/components/form/zod-rules";

/** 一次转案件提交的形状：从 schema 反推，避免手写一份再漂移 */
type ConvertRequest = z.infer<typeof convertSchema>;
/** 单张案件卡的表单形状（amount/filingDate/caseNo 在表单里是 Dayjs/空串，提交前清洗） */
type CaseForm = Partial<Omit<MatterCreateInput, "filingDate" | "parties">> & {
  filingDate?: Dayjs | null;
};

/**
 * 事项 → 案件（修订稿 §3.4 / 映射矩阵 §2 / **IQ-18 表单布局**）。
 *
 * ## 为什么是 N 张卡而不是单案
 *
 * 规格早定死 **1 事项 → N 案件（N ≥ 1）且可追加**（映射矩阵 §1）：一个风险衍生多起诉讼
 * 常跨月发生，禁止追加会把用户逼回"新建案件"从而丢掉关联。服务层 `convertToCase` 收的是
 * 数组（N 次取号、循环写入、单事务），旧表单只提交 `cases:[单张]` —— 能力在，界面没接。
 *
 * ## IQ-18 的五条形态（原型 `prototype/p5-p6-2026-10-11` 变体，本组件是它的结构翻译）
 *
 * ① **顶部结果条**：本次生成几件 + 每件内部编号，让"要转几个"在首屏可见；
 * ② **案件切换条**：N 张都可见（编号/名称/必填完成度徽章），但**一次只编辑一张**——
 *    铺开 N 份必填必然分心，只显示一张又看不出总数，切换条同时解掉这对矛盾；
 * ③ **案号与内部编号两套**：案号默认取内部编号、可改、**非唯一**、重复只提示不阻止；
 *    唯一锚点始终是内部编号；
 * ④ **四区表单**：必填 / 案号 / 只读继承事实（不占表单控件）/ 可留空；
 * ⑤ 映射矩阵五条"故意不带"收进**默认折叠**块——不写出来用户会以为"系统漏带了"而手抄，
 *    手抄正是本功能要消灭的动作。
 *
 * N>1 时案件名按「事项名 -N」派生并高亮"待确认"（矩阵 §2.1），不改也能提交。
 * 金额留空逐案填；合计与事项敞口明显不符时**非阻断提示**（可关，提交不被拦）。
 */
type RiskSource = {
  id: string;
  code: string;
  name: string;
  level: string;
  amount?: string;
  ownerName?: string;
  parties?: { name: string; partyRole: string }[];
} | null;

const MAX_CASES = 20; // 与 convertSchema 的 cases.max(20) 同源

/** 一张卡的必填四件是否齐（切换条徽章用；案由/类型/程序/地位是"系统不替你决定"的那几项） */
function cardComplete(c: CaseForm | undefined): boolean {
  if (!c) return false;
  return Boolean(
    c.name?.trim() && c.cause?.trim() && c.caseType && c.procedure && c.litigationRole,
  );
}

export function ConvertDialog({
  source,
  onClose,
  onOpenCase,
}: {
  source: RiskSource;
  onClose: () => void;
  onOpenCase: (caseId: string) => void;
}) {
  const qc = useQueryClient();
  const { data: meta } = useMeta("matter");
  const { token } = theme.useToken();
  const [form] = Form.useForm<{ cases: CaseForm[] }>();
  const open = source !== null;
  const [active, setActive] = useState(0);
  const [amountWarn, setAmountWarn] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: (values: ConvertRequest) =>
      api.post<{ cases: { id: string; internalCode: string }[] }>(
        `/api/risk-matters/${source?.id}/convert`,
        values,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["risk-matters"] });
      qc.invalidateQueries({ queryKey: ["matters"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      if (source?.id) qc.invalidateQueries({ queryKey: ["risk", source.id] });
    },
  });

  // 打开时铺一张卡：名称与等级从事项带入（矩阵 §2.1/§2.2），案由**不自动映射**（留空逼填）
  useEffect(() => {
    if (source) {
      setActive(0);
      setAmountWarn(null);
      mut.reset();
      form.setFieldsValue({
        cases: [{ name: source.name, level: source.level }],
      });
    }
  }, [source?.id]);

  const created = mut.data;

  /**
   * 取**全部卡**的值。
   *
   * ⚠ 必须 `getFieldsValue(true)`（含未挂载字段）而不是 `validateFields()` 的返回值：
   * 一次只渲染 active 那张，其余卡在 form 里是"已卸载但值保留"（antd 的 preserve 默认 true）。
   * 用 `getFieldValue("cases")` 拿到的数组形状随渲染状态漂移，漏卡就会静默少建案件。
   */
  const allCases = (): CaseForm[] =>
    (form.getFieldsValue(true) as { cases?: CaseForm[] }).cases ?? [];

  function addCase() {
    const cases = allCases();
    if (cases.length >= MAX_CASES) return;
    const n = cases.length + 1;
    // N>1 派生名「事项名 -N」并高亮待确认（矩阵 §2.1）；等级沿用事项，案由留空
    form.setFieldsValue({
      cases: [...cases, { name: `${source?.name ?? ""} -${n}`, level: source?.level }],
    });
    setActive(n - 1);
  }

  function removeCase(i: number) {
    const cases = allCases();
    if (cases.length <= 1) return; // 至少留一张（min 1）
    form.setFieldsValue({ cases: cases.filter((_, k) => k !== i) });
    setActive((a) => (a >= i ? Math.max(0, a - 1) : a));
  }

  /**
   * 跨卡复制（MATT-19 的 AC）：把当前卡的内容复制到其余卡。
   *
   * **排除 id 类字段**——这是这条 AC 的全部要点。逐项说清本表单里有哪些：
   *  · `caseNo`（案号）**在表单里，必须排除**。它默认取内部编号、可改，但把一张的案号
   *    抄给 N 张，就是给 N 个案卷安同一个法院案号。库层"非唯一、重复只提示不阻止"
   *    是给"不同法院案号体系重号"留的口子，不是给"复制粘贴批量重号"用的——
   *    而且这种错**不会报错**，等对账时才发现，正是 AC 要防的"以为带过去了"。
   *  · 内部编号**不在表单里**：它由服务端在事务内取号（`nextCode`），前端预占会浪费号段。
   *  · 事项外键**不在卡里**：路由从 URL 拿 `riskId` 传给服务层，卡上根本没有这个字段。
   *
   * 其余字段（名称/案由/类型/程序/诉讼地位/法院/等级/金额/立案日期）照抄——
   * 名称不在"id 类"里，多案同名是常态，用户要改自己改。
   * 目标卡**自己的案号不清空**：排除的语义是"不抄过来"，不是"抹掉你原来填的"。
   */
  function copyToOthers() {
    const cases = allCases();
    if (cases.length < 2) return;
    const src = cases[active] ?? {};
    const copyable: Partial<CaseForm> = { ...src };
    delete copyable.caseNo; // 案号是 id 类字段：不抄（理由见上）
    form.setFieldsValue({
      cases: cases.map((c, i) => (i === active ? c : { ...c, ...copyable })),
    });
  }

  async function submit() {
    if (!source) return;
    // 先跑当前卡的即时校验（给人"哪个框没填"的红框）；
    // 但**不能**用它的返回值当载荷——未渲染的卡不在里面（见 allCases 注释）。
    const okVisible = await validateAndFocusFirst(form);
    if (!okVisible) return; // 焦点已送到第一个错字段（只滚不聚焦不算数）

    const cases = allCases().map((c) => {
      const { filingDate, ...rest } = c;
      return pruneEmpty({
        ...rest,
        filingDate: filingDate ? filingDate.format("YYYY-MM-DD") : undefined,
      }) as Record<string, unknown>;
    });
    const parsed = convertSchema.safeParse({ cases });
    if (!parsed.success) {
      // 出错的那张可能不是当前这张（未渲染的卡不跑 rules，全靠 schema 兜）。
      // 先把它切到前台再标红——否则用户只看到"提交失败"而看不见错在哪个框。
      const bad = parsed.error.issues.find(
        (i) => i.path[0] === "cases" && typeof i.path[1] === "number",
      );
      const badIdx = typeof bad?.path[1] === "number" ? (bad.path[1] as number) : null;
      if (badIdx !== null && badIdx !== active) {
        setActive(badIdx);
        setTimeout(() => setFieldErrors(form, parsed.error.issues), 0); // 等那张挂载后再标
      } else {
        setFieldErrors(form, parsed.error.issues);
      }
      return;
    }
    mut.mutate(parsed.data);
  }

  // 金额合计 vs 事项敞口的**非阻断**提示（矩阵 §2.4）：只在明显不符时提一句，可关，提交不拦。
  // 用 watch 现算，不写进提交路径——它不该有能力拦下提交。
  const watchedCases = (Form.useWatch("cases", { form, preserve: true }) ?? []) as CaseForm[];
  const derived = useMemo(() => {
    const sum = watchedCases.reduce((acc, c) => acc + (Number(c?.amount) || 0), 0);
    const exposure = Number(source?.amount) || 0;
    const mismatch = exposure > 0 && sum > 0 && (sum > exposure * 1.5 || sum < exposure * 0.5);
    return { sum, exposure, mismatch };
  }, [watchedCases, source?.amount]);

  const caseCount = watchedCases.length || 1;
  const doneCount = watchedCases.filter(cardComplete).length;

  if (created) {
    const first = created.cases[0];
    return (
      <Modal
        open={open}
        onCancel={onClose}
        title={created.cases.length > 1 ? `已建 ${created.cases.length} 个案件` : "案件已建"}
        footer={
          <Space>
            <Button onClick={onClose}>留在事项列表</Button>
            <Button type="primary" onClick={() => onOpenCase(first?.id ?? "")}>
              打开案件
            </Button>
          </Space>
        }
      >
        <Result
          status="success"
          title={
            <span className="num" style={{ fontSize: 13, lineHeight: 1.9 }}>
              {created.cases.map((c) => c.internalCode).join("　·　")}
            </span>
          }
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
      width={760}
      okText={`提交：生成 ${caseCount} 个案件`}
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
          closable
          style={{ marginBottom: 12 }}
          message={mut.error instanceof ApiFailure ? mut.error.message : "提交失败"}
        />
      ) : null}

      {/* ① 结果条：本次生成几件 + 每件内部编号（首屏可见"要转几个"）。
          底色/描边走 antd token，不写字面量——禁令⑦ 的色值唯一源是 brand.ts 与 antd token，
          这里要的是"比卡片底色深一档"的强调面，正好是 colorFillQuaternary。 */}
      <Flex
        align="center"
        gap={14}
        wrap
        style={{
          background: token.colorFillQuaternary,
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadiusLG,
          padding: "10px 14px",
          marginBottom: 12,
        }}
      >
        <span style={{ fontSize: 13 }}>
          <b style={{ fontSize: 18 }}>{caseCount}</b> 个案件
        </span>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {caseCount > 1
            ? `写入同一个事务，全部成功或全部回滚 · 必填已填 ${doneCount}/${caseCount} 张`
            : "由本事项生成"}
        </Typography.Text>
        <div style={{ flex: 1 }} />
        <Button
          size="small"
          icon={<PlusOutlined />}
          onClick={addCase}
          disabled={caseCount >= MAX_CASES}
        >
          加一个案件
        </Button>
      </Flex>

      {/* ② 案件切换条：N 张都可见，一次只编辑一张（必填完成度徽章） */}
      {caseCount > 1 && (
        <div
          style={{
            display: "grid",
            gridAutoFlow: "column",
            gridAutoColumns: "1fr",
            gap: 8,
            marginBottom: 12,
          }}
        >
          {watchedCases.map((c, i) => {
            const complete = cardComplete(c);
            return (
              <Button
                key={i}
                type={i === active ? "primary" : "default"}
                onClick={() => setActive(i)}
                style={{
                  height: "auto",
                  textAlign: "left",
                  padding: "6px 10px",
                  whiteSpace: "normal",
                }}
              >
                <div style={{ fontSize: 11, opacity: 0.7 }}>案件 {i + 1}</div>
                <div style={{ fontSize: 12, fontWeight: 500 }}>{c?.name || "（未命名）"}</div>
                <div style={{ fontSize: 11 }}>{complete ? "✓ 必填已齐" : "⚠ 必填未完"}</div>
              </Button>
            );
          })}
        </div>
      )}

      {/* 金额非阻断提示：合计与敞口明显不符时提一句，可关，提交不拦 */}
      {derived.mismatch && !amountWarn && (
        <Alert
          type="warning"
          showIcon
          closable
          onClose={() => setAmountWarn("dismissed")}
          style={{ marginBottom: 12 }}
          message={`各案金额合计 ${derived.sum} 与事项敞口 ${derived.exposure} 差得较多——多案分摊通常不等，确认无误即可照常提交。`}
        />
      )}

      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        scrollToFirstError={{ block: "center", behavior: "smooth" }}
        initialValues={{ cases: [{}] }}
      >
        {/* 卡数由结果条管（addCase/removeCase 改 cases 数组），不用 Form.List 的 add/remove，
            否则「加一个案件」按钮在 List 作用域外拿不到操作句柄。这里只渲染 active 那一张；
            未渲染的卡**值仍在 form 里**（antd 的 preserve 默认保住已注册字段），所以切换不丢填写。 */}
        <CardHeader
          index={active}
          count={caseCount}
          removable={caseCount > 1}
          onRemove={() => removeCase(active)}
          onCopyToOthers={copyToOthers}
        />
        <CaseFields dict={meta} active={active} source={source} />
      </Form>
    </Modal>
  );
}

/** 当前卡的小标题（案件 i/N + 跨卡复制 + 删除这张）——切换条已给总数，这里只定位"正在编辑哪张" */
function CardHeader({
  index,
  count,
  removable,
  onRemove,
  onCopyToOthers,
}: {
  index: number;
  count: number;
  removable: boolean;
  onRemove: () => void;
  onCopyToOthers: () => void;
}) {
  return (
    <Flex align="center" justify="space-between" style={{ marginBottom: 8 }}>
      <Space size={8}>
        <Typography.Text strong>
          案件 {index + 1} / {count}
        </Typography.Text>
        {count > 1 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            其余案件在上方切换条里
          </Typography.Text>
        )}
      </Space>
      <Space size={4}>
        {count > 1 && (
          <Button size="small" type="text" icon={<CopyOutlined />} onClick={onCopyToOthers}>
            复制到其余卡
          </Button>
        )}
        {removable && (
          <Button size="small" danger type="text" icon={<DeleteOutlined />} onClick={onRemove}>
            删除这张
          </Button>
        )}
      </Space>
    </Flex>
  );
}

/**
 * 单张卡的字段（IQ-18 四区）。路径一律 `["cases", active, 字段]`，
 * 校验仍从 `convertCardSchema` 经 `rulesFor` 推导（单一来源，不在此手写规则）。
 *
 * ⚠ prop 叫 `dict` 不叫 meta：lint-guard 的「页头无第二行插槽」是**文本级**断言，
 * 连注释里出现那个属性形态都会被抓（本轮真踩到——注释里解释它、它就把注释也算了）。
 * 那条断言的误伤面是明说过的代价，改这里的名字而不是放松断言——
 * "页头插槽别回来"比这个 prop 叫什么都重要。
 */
function CaseFields({
  dict,
  active,
  source,
}: {
  dict: ReturnType<typeof useMeta>["data"];
  active: number;
  source: RiskSource;
}) {
  // 可变数组而不是 `as const` 元组：antd 的 `NamePath` 不收 readonly
  const p = (f: string): (string | number)[] => ["cases", active, f];
  const nameVal = (Form.useWatch(["cases", active, "name"], { preserve: true }) ?? "") as string;
  const derivedPending = source ? nameVal === `${source.name} -${active + 1}` : false;
  return (
    <>
      {/* ① 必填：系统不替你判断的，逐案各填一次 */}
      <Form.Item
        label="案件名称"
        name={p("name")}
        rules={rulesFor(convertCardSchema, ["name"])}
        extra={
          derivedPending ? "按「事项名 -N」派生，待你确认；不改也能提交。" : "取自事项名称，可改。"
        }
      >
        <Input />
      </Form.Item>
      <Row gutter={12}>
        <Col span={12}>
          <Form.Item
            label="案由"
            name={p("cause")}
            rules={rulesFor(convertCardSchema, ["cause"])}
            extra="不自动映射（一个「合同违约」能落到几十个案由，给错默认值更糟）。"
          >
            <Input placeholder="必填 · 不自动映射" />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item
            label="我方诉讼地位"
            name={p("litigationRole")}
            rules={rulesFor(convertCardSchema, ["litigationRole"])}
          >
            <Select
              placeholder="请选择"
              options={dict ? toOptions(dict.enums.litigationRoles) : []}
            />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item
            label="案件类型"
            name={p("caseType")}
            rules={rulesFor(convertCardSchema, ["caseType"])}
          >
            <Select placeholder="请选择" options={dict ? toOptions(dict.enums.caseTypes) : []} />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item
            label="审级 / 程序"
            name={p("procedure")}
            rules={rulesFor(convertCardSchema, ["procedure"])}
          >
            <Select placeholder="请选择" options={dict ? toOptions(dict.enums.procedures) : []} />
          </Form.Item>
        </Col>
      </Row>

      {/* ② 案号：与内部编号是两套，非唯一 */}
      <Form.Item
        label="案号"
        name={p("caseNo")}
        rules={rulesFor(convertCardSchema, ["caseNo"])}
        extra="法院给的号，默认取内部编号、拿到正式案号后改。非唯一——重复只提示不阻止，唯一锚点始终是内部编号。"
      >
        <Input placeholder="可留空，默认取内部编号" />
      </Form.Item>

      {/* ③ 继承只读事实：紧凑展示，不占表单控件（旧版把 19 个字段全渲染成行是噪音）。
          当事人只在调用方给了名单时才渲染——列表页的行数据里没有它，
          硬渲染会变成一句"（无）"的假事实。 */}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        已从事项带入（只读）：
      </Typography.Text>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 20px", margin: "6px 0 14px" }}>
        <Fact k="风险等级" v={source?.level ?? "—"} />
        <Fact k="经办人" v={source?.ownerName || "（空）"} />
        {source?.parties && (
          <Fact
            k="对方当事人"
            v={
              source.parties.length
                ? source.parties.map((x) => x.name).join("、")
                : "（无——转案件要求每案 ≥1 当事人）"
            }
          />
        )}
      </div>

      {/* ④ 可留空：留空不阻断，后续随时补 */}
      <Row gutter={12}>
        <Col span={8}>
          <Form.Item
            label="标的金额"
            name={p("amount")}
            rules={rulesFor(convertCardSchema, ["amount"])}
            extra="不继承，逐案自填。"
          >
            <Input placeholder="留空 · 逐案自填" />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item
            label="受理法院"
            name={p("court")}
            rules={rulesFor(convertCardSchema, ["court"])}
          >
            <Input placeholder="留空" />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item
            label="立案日期"
            name={p("filingDate")}
            extra="不取发现日期（误填污染期限计算）。"
          >
            <DatePicker style={{ width: "100%" }} placeholder="留空" />
          </Form.Item>
        </Col>
      </Row>

      {/* ⑤ 五条"故意不带"：默认折叠，但必须找得到（IQ-18⑤） */}
      <details style={{ marginTop: 4 }}>
        <summary style={{ fontSize: 12, color: INK.muted, cursor: "pointer" }}>
          为什么有些字段是空的？（5 条映射规则）
        </summary>
        <ul style={{ fontSize: 12, color: INK.secondary, marginTop: 6, paddingLeft: 18 }}>
          <li>标的金额不继承——多起诉讼按案分摊，逐案填才准。</li>
          <li>案由不自动映射——事项类型到案由没有可靠对照表。</li>
          <li>发现日期不映射为立案日期——两者含义不同，误填污染期限计算。</li>
          <li>描述与处置措施不复制——案件保留来源卡片可跳转，只建引用不留副本。</li>
          <li>节点与附件不复制——节点由案件侧按模板生成，附件引用同一份证据。</li>
        </ul>
      </details>
    </>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <span style={{ fontSize: 12.5 }}>
      <Typography.Text type="secondary">{k}</Typography.Text>{" "}
      {v === "（空）" ? <Tag color="orange">{v}</Tag> : <b>{v}</b>}
    </span>
  );
}
