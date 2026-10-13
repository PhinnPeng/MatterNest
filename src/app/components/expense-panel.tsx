"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  App as AntdApp,
  Button,
  DatePicker,
  Flex,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { PlusOutlined } from "@ant-design/icons";
import type { Dayjs } from "dayjs";
// 运行时也要用（编辑模式要把已有的 `YYYY-MM-DD` 回填成 DatePicker 能吃的 Dayjs 对象）。
// 别处只用到类型所以都是 `import type`，这里是**唯一**需要运行时值的一处。
import dayjs from "dayjs";
import type { TableColumnsType } from "antd";

import {
  api,
  ApiFailure,
  useMeta,
  type ExpenseList,
  type ExpenseRow,
  type HostKind,
} from "@/app/lib/client/api";
import { calDate, money } from "@/app/lib/client/format";
import { INK } from "@/app/theme/brand";
import { StateBlock } from "@/app/components/ui/state-block";
import {
  applyServerIssues,
  rulesFor,
  validateAndFocusFirst,
} from "@/app/components/form/zod-rules";
import { expenseCreateSchema, expenseUpdateSchema } from "@/shared/schema/expenses";

/**
 * 费用区（US-41）：列表 + **合计** + 按项目分组 + 登记/编辑/删除。
 *
 * 一个组件服务两个宿主（案件详情页的「费用」Tab、事项详情页的参考材料区）：
 * 两边的接口、字段、校验、审计完全同构，只有 URL 前缀不同 —— 写成两份的失败形态是
 * "案件侧能改状态、事项侧不能"，而它不会报错。
 *
 * 四条口径：
 *   1. **合计由服务端算**（`SUM(amount)` 在 SQL 里）。前端把当页金额加起来是错的两次：
 *      数字随分页变化，且 `Number()` 会把 `numeric(18,2)` 的刻度丢掉；
 *   2. 金额一律走 `money()`（字符串处理，不做运算），入参一律字符串；
 *   3. 费用项目来自配置（`/api/meta` 的 `expenseItems`），**只列启用的**；
 *      已停用的项目在历史行上仍然显示名字（详情与导出要读得懂老数据）；
 *   4. 归档态只读（§5.2）：不摆写按钮，服务层还会再拒一次（403 `archived`）。
 */
export function ExpensePanel({
  host,
  hostId,
  archived,
}: {
  host: HostKind;
  hostId: string;
  archived: boolean;
}) {
  const qc = useQueryClient();
  const { message } = AntdApp.useApp();
  const { data: meta } = useMeta(host);
  const [dialog, setDialog] = useState<
    { mode: "create" } | { mode: "edit"; row: ExpenseRow } | null
  >(null);
  const base = host === "matter" ? "matters" : "risk-matters";

  /**
   * ⚠ **必须显式要一个大页**，否则列表会**静默截断在 20 行**。
   *
   * 服务端 `listQuerySchema` 的 `pageSize` 默认 20，而这个面板的表格是
   * `pagination={false}`（费用明细是"看全"的清单，不是要翻页的台账）。
   * 于是 21 笔费用时：表格显示 20 行，而合计行写「21 笔」——**用户会以为少了一笔去找它**。
   * 合计与按项目分组是整卷口径（对的），只有行清单不是。
   *
   * 取 100（服务端每页上限，`listQuerySchema` 守着）并在超限时**明说还有多少未显示**：
   * 静默少给几行比报错更难查。
   */
  const PAGE_SIZE = 100;
  const { data, isPending, isError, error } = useQuery({
    queryKey: ["expenses", host, hostId],
    queryFn: () =>
      api.get<ExpenseList>(`/api/${base}/${hostId}/expenses?page=1&pageSize=${PAGE_SIZE}`),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["expenses", host, hostId] });
    void qc.invalidateQueries({ queryKey: [host === "matter" ? "matter" : "risk", hostId] });
  };

  const remove = useMutation({
    mutationFn: (row: ExpenseRow) => api.del(`/api/${base}/${hostId}/expenses/${row.id}`),
    onSuccess: () => {
      message.success("已删除这笔费用");
      invalidate();
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "删除失败"),
  });

  const columns: TableColumnsType<ExpenseRow> = [
    {
      title: "费用项目",
      dataIndex: "itemName",
      width: 160,
      render: (v: string, r) => (
        <>
          <div style={{ fontSize: 13 }}>{v || "（项目已停用）"}</div>
          {r.remark ? <div style={{ fontSize: 11, color: INK.muted }}>{r.remark}</div> : null}
        </>
      ),
    },
    {
      title: "金额",
      dataIndex: "amount",
      width: 132,
      align: "right",
      render: (v: string) => (
        <span className="num" style={{ fontSize: 13 }}>
          {money(v)}
        </span>
      ),
    },
    {
      title: "发生日期",
      dataIndex: "occurredDate",
      width: 132,
      render: (v: string) => (
        <span className="num" style={{ fontSize: 12 }}>
          {calDate(v)}
        </span>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 92,
      render: (v: string) => (
        <Tag variant="filled" style={{ fontSize: 11, marginInlineEnd: 0 }}>
          {meta?.enums.expenseStatuses[v] ?? v}
        </Tag>
      ),
    },
    {
      title: "操作",
      width: 128,
      render: (_, r) =>
        archived ? (
          <span style={{ fontSize: 12, color: INK.faint }}>已归档</span>
        ) : (
          <Space size={4}>
            <Button size="small" type="link" onClick={() => setDialog({ mode: "edit", row: r })}>
              编辑
            </Button>
            <Popconfirm
              title="删除这笔费用？"
              description="删除后不再计入合计；库里仍保留这条记录。"
              okText="删除"
              cancelText="取消"
              onConfirm={() => remove.mutate(r)}
            >
              <Button size="small" type="link" danger>
                删除
              </Button>
            </Popconfirm>
          </Space>
        ),
    },
  ];

  if (isError) {
    return (
      <StateBlock
        tone="error"
        title="费用读不出来"
        hint={error instanceof Error ? error.message : "未知错误"}
      />
    );
  }

  const rows = data?.items ?? [];
  const totals = data?.totals;

  return (
    <div>
      <Flex justify="space-between" align="center" gap={12} wrap style={{ marginBottom: 8 }}>
        {/* 合计是这一块要回答的那个问题，所以它排在最前，且用完整金额（不做"1.2 万"压缩） */}
        <Typography.Text style={{ fontSize: 13 }}>
          合计{" "}
          <span className="num" style={{ fontSize: 15 }}>
            {money(totals?.sum ?? "0.00")}
          </span>{" "}
          元 · <span className="num">{totals?.count ?? 0}</span> 笔
          {/*
            ⚠ 截断要说出来：合计与按项目分组是**整卷**口径，而行清单受每页上限约束。
            两者不一致时（21 笔只显示 20 行）用户会以为少了一笔去找它 —— 静默少给比报错更难查。
          */}
          {(data?.items?.length ?? 0) < (totals?.count ?? 0) ? (
            <span style={{ color: INK.muted, fontSize: 12 }}>
              {" "}
              · 表格只显示前 {data?.items?.length ?? 0} 笔，还有{" "}
              <span className="num">{(totals?.count ?? 0) - (data?.items?.length ?? 0)}</span>{" "}
              笔未列出
            </span>
          ) : null}
          {data?.byItem?.length ? (
            <span style={{ color: INK.muted, fontSize: 12 }}>
              {" "}
              （
              {data.byItem.map((b) => `${b.itemName || "已停用项目"} ${money(b.sum)}`).join(" / ")}
              ）
            </span>
          ) : null}
        </Typography.Text>
        {archived ? null : (
          <Button
            size="small"
            icon={<PlusOutlined />}
            onClick={() => setDialog({ mode: "create" })}
          >
            登记费用
          </Button>
        )}
      </Flex>

      {rows.length === 0 ? (
        <StateBlock
          title="还没有费用"
          hint={
            archived
              ? "这条记录已归档，只读。"
              : "诉讼费、律师费、保全费这类支出登记在这里；合计与按项目分组会自动算出来。"
          }
        />
      ) : (
        <Table<ExpenseRow>
          size="small"
          rowKey={(r) => r.id}
          columns={columns}
          dataSource={rows}
          loading={isPending}
          pagination={false}
        />
      )}

      <ExpenseDialog
        host={host}
        hostId={hostId}
        state={dialog}
        onClose={() => setDialog(null)}
        onDone={invalidate}
      />
    </div>
  );
}

/**
 * 登记 / 编辑一笔费用。
 *
 * 校验规则从 `shared/schema/expenses.ts` 推导（`rulesFor`），提交后再由服务端用**同一个
 * schema** 判一次 —— 前端不手写第二套规则（禁令⑧）。
 */
function ExpenseDialog({
  host,
  hostId,
  state,
  onClose,
  onDone,
}: {
  host: HostKind;
  hostId: string;
  state: { mode: "create" } | { mode: "edit"; row: ExpenseRow } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const { data: meta } = useMeta(host);
  const [form] = Form.useForm<{
    itemId: string;
    amount: string;
    occurredDate: Dayjs;
    status: string;
    remark?: string;
  }>();
  const editing = state?.mode === "edit" ? state.row : null;
  const base = host === "matter" ? "matters" : "risk-matters";
  const schema = editing ? expenseUpdateSchema : expenseCreateSchema;

  const mut = useMutation({
    mutationFn: (v: {
      itemId?: string;
      amount?: string;
      occurredDate?: string;
      status?: string;
      remark?: string;
    }) =>
      editing
        ? api.patch(`/api/${base}/${hostId}/expenses/${editing.id}`, v)
        : api.post(`/api/${base}/${hostId}/expenses`, v),
    onSuccess: () => {
      onClose();
      message.success(editing ? "费用已更新" : "费用已登记");
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

  // 选择器只列**启用的**项目：停用的项目不该被新费用选中，但历史行仍显示它的名字
  const options = (meta?.expenseItems ?? [])
    .filter((i) => i.isEnabled)
    .map((i) => ({ value: i.id, label: i.name }));

  return (
    <Modal
      open={state !== null}
      title={editing ? "编辑费用" : "登记费用"}
      okText={editing ? "保存" : "登记"}
      cancelText="取消"
      confirmLoading={mut.isPending}
      destroyOnHidden
      onCancel={onClose}
      onOk={async () => {
        const v = await validateAndFocusFirst(form);
        if (!v) return;
        /**
         * ⚠ 日期要**兜底**，不能直接 `v.occurredDate.format(...)`。
         *
         * 编辑模式下 `expenseUpdateSchema.occurredDate` 是 `.optional()`，
         * 而 `rulesFor` 对**选填**字段不推 `required` 规则（`zod-rules.ts`）⇒
         * 日期框空着也能通过客户端校验 ⇒ 这里对 `undefined` 取 `.format` 抛 TypeError。
         * 更糟的是 `onOk` 是 async 而 antd 不 await 它 ⇒ **点「保存」毫无反应、无报错、无 loading**。
         * 新建模式该字段非选填，所以有 required 规则 —— **只有编辑坏**，
         * 而 67 条 HTTP 冒烟在结构上看不见它（检查子代理抓到的）。
         *
         * 现在：编辑时优先用表单值，空了就回落到这条记录本来的日期（它一定存在，列是 NOT NULL）。
         */
        const occurredDate = v.occurredDate
          ? v.occurredDate.format("YYYY-MM-DD")
          : (editing?.occurredDate ?? "");
        if (!occurredDate) {
          form.setFields([{ name: "occurredDate", errors: ["请选择发生日期"] }]);
          return;
        }
        mut.mutate({
          itemId: v.itemId,
          amount: v.amount,
          occurredDate,
          status: v.status,
          remark: v.remark ?? "",
        });
      }}
    >
      <Form
        form={form}
        layout="vertical"
        style={{ marginTop: 12 }}
        initialValues={
          editing
            ? {
                itemId: editing.itemId,
                amount: editing.amount,
                // ⚠ 这一行是**必须**的：漏了它日期框就是空的，而空值会让上面那个
                // `.format` 抛异常（同一处缺陷的另一半）。
                occurredDate: dayjs(editing.occurredDate),
                status: editing.status,
                remark: editing.remark ?? "",
              }
            : { status: "pending_pay" }
        }
      >
        <Form.Item name="itemId" label="费用项目" rules={rulesFor(schema, ["itemId"])}>
          <Select
            placeholder="选择费用项目"
            options={options}
            showSearch
            optionFilterProp="label"
          />
        </Form.Item>
        <Form.Item
          name="amount"
          label="金额（元）"
          rules={rulesFor(schema, ["amount"])}
          // 规则的正则那半在 `rulesFor` 里刻意不映射（Zod 4 的 pattern 内部形状不稳定），
          // 所以把边界写在控件说明里，提交时由服务端同一份 schema 兜
          extra="最多两位小数"
        >
          <Input className="num" inputMode="decimal" placeholder="0.00" />
        </Form.Item>
        <Form.Item name="occurredDate" label="发生日期" rules={rulesFor(schema, ["occurredDate"])}>
          <DatePicker style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="status" label="状态" rules={rulesFor(schema, ["status"])}>
          <Select
            options={Object.entries(meta?.enums.expenseStatuses ?? {}).map(([value, label]) => ({
              value,
              label,
            }))}
          />
        </Form.Item>
        <Form.Item name="remark" label="备注" rules={rulesFor(schema, ["remark"])}>
          <Input.TextArea rows={2} maxLength={2000} placeholder="发票号、付款方式之类" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
