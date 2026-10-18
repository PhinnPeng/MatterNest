"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  App as AntdApp,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { TableColumnsType } from "antd";
import { ArrowLeftOutlined } from "@ant-design/icons";

import { INK } from "@/app/theme/brand";
import { api, ApiFailure, useActor } from "@/app/lib/client/api";
import { StateBlock } from "@/app/components/ui/state-block";
import { STATUS_SEMANTIC_LABELS } from "@/shared/enums/status";
import {
  CASE_TYPE_LABELS,
  ID_TYPE_LABELS,
  LITIGATION_ROLE_LABELS,
  NODE_STATUS_LABELS,
  PARTY_TYPE_LABELS,
  PROCEDURE_LABELS,
  RISK_MATTER_TYPE_LABELS,
} from "@/shared/enums/business";
import {
  CONFIG_KIND_META,
  CONFIG_WRITE_FIELDS,
  type ConfigItem,
  type ConfigKind,
  type WritableConfigKind,
} from "@/shared/schema/config";

/**
 * 功能配置细项页（14 个细项共用一个组件；规格勘误第 8 条）。
 *
 * ## 三档在页面上的表现（照票面，别一律给编辑按钮）
 *
 * · **有可写表（5）**：页头给「新增」，行内给「编辑 / 停用」，新增与编辑一律走**弹层**
 *   （页面上不留常驻表单卡）——提交打 `/api/config/[kind]`；
 * · **闭集枚举（7）**：行来自 `@/shared/enums/business.ts`（与迁移里的 CHECK 双向核对），
 *   页面上明写「改动要走迁移」、**不摆禁用按钮**（禁用按钮是"这里本来能改但不让你改"的暗示，
 *   而这里根本不提供改的能力——与 `roles-view` 同一条口径）；
 * · **无承载（2）**：库里有/没有承载如实写（第 6 条勘误：节点通知**时间**的近似承载在
 *   `mn_node_type_config.default_remind_days`，不是"库里没有"），同样明写改动要走迁移。
 *
 * ## 权限：读登录即可，写要 `canManageConfig`
 *
 * 与 `/api/meta` 同档（配置读不设门），所以拿不到权限的人**看得到这一页**，
 * 只是看不到「新增」与行内写控件 —— 页面给一句事实说明为什么没有写控件，
 * 而不是整页 403（那会让人以为系统没有这个功能）。
 *
 * ## 表格列按库裁剪（`CONFIG_KIND_COLUMNS`）
 *
 * 5 张可写配置表都**没有 `description` 列**，所以页面不出「说明」列（原型画了，库里没有）；
 * `mn_tag` 没有 `code` 列，`mn_risk_level_config` 没有 `color` 列 —— 都按库出。
 */
export function ConfigKindView({ kind }: { kind: ConfigKind }) {
  const meta = CONFIG_KIND_META[kind];
  if (meta.edit === "crud") return <WritableConfig kind={kind as WritableConfigKind} />;
  return <ReadOnlyConfig kind={kind} />;
}

/**
 * 「返回功能配置」链接。canon 原型把它放在**顶栏**（`.topbar .back`），
 * 而顶栏由 `AppShell` 统一渲染、只写当前页名（MATT-98 的裁定：顶栏不是链接、
 * 详情页的返回入口在页头）。所以这里落在页头标题上方，形态与全站其余详情页一致。
 */
function BackToConfig() {
  return (
    <Link
      href="/config"
      style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4 }}
    >
      <ArrowLeftOutlined style={{ fontSize: 11 }} />
      返回功能配置
    </Link>
  );
}

/* ───────────────────────── 可写 5 个 ───────────────────────── */

const kindUrl = (kind: WritableConfigKind) => `/api/config/${kind}`;

function WritableConfig({ kind }: { kind: WritableConfigKind }) {
  const meta = CONFIG_KIND_META[kind];
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const actor = useActor();
  const canWrite = actor.data?.privileges.canManageConfig === true;
  const [editing, setEditing] = useState<ConfigItem | null>(null);
  const [creating, setCreating] = useState(false);

  const q = useQuery({
    queryKey: ["config", kind],
    queryFn: () => api.get<{ kind: string; items: ConfigItem[] }>(kindUrl(kind)),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["config", kind] });
    // 改了显示名，列表/报表/下拉要一起变（票面验收）——那一份读的是 /api/meta 的缓存
    void qc.invalidateQueries({ queryKey: ["meta"] });
  };

  const toggle = useMutation({
    mutationFn: ({ id, isEnabled }: { id: string; isEnabled: boolean }) =>
      api.patch<{ ok: true }>(kindUrl(kind), { id, isEnabled }),
    onSuccess: (_r, v) => {
      message.success(v.isEnabled ? "已启用" : "已停用");
      invalidate();
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "操作失败"),
  });

  if (actor.isPending || q.isPending) {
    return <div className="card" style={{ minHeight: 320 }} />;
  }
  if (q.isError) {
    return (
      <StateBlock
        tone="error"
        title="配置读不到"
        hint={q.error instanceof Error ? q.error.message : "会话可能已过期，重新登录后再看。"}
      />
    );
  }

  const items = q.data.items;
  const columns = writableColumns(kind, {
    canWrite,
    onEdit: (row) => setEditing(row),
    onToggle: (row) => toggle.mutate({ id: row.id, isEnabled: !row.isEnabled }),
    togglingId: toggle.isPending ? toggle.variables?.id : undefined,
  });

  return (
    <>
      <div className="pagehead">
        <div>
          <BackToConfig />
          <h2>{meta.label}</h2>
        </div>
        <span className="sp" />
        {canWrite ? (
          <Button type="primary" onClick={() => setCreating(true)}>
            新增
          </Button>
        ) : null}
      </div>

      <div className="card">
        <Table<ConfigItem>
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={items}
          columns={columns}
          locale={{
            emptyText: (
              <Space orientation="vertical" size={8}>
                <Typography.Text type="secondary">暂无数据</Typography.Text>
                {canWrite ? (
                  <Button size="small" type="primary" onClick={() => setCreating(true)}>
                    新增
                  </Button>
                ) : null}
              </Space>
            ),
          }}
        />
      </div>

      {canWrite ? null : (
        <Typography.Text
          style={{ fontSize: 12, color: INK.muted, display: "block", marginTop: 12 }}
        >
          改动功能配置需要「管理配置」权限，当前角色未持有。
        </Typography.Text>
      )}

      <ConfigFormModal
        kind={kind}
        open={creating || editing !== null}
        row={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onDone={invalidate}
      />
    </>
  );
}

/** 5 个可写细项的行操作（编辑 + 启停）。停用后控件变「启用」，状态可见、可恢复 */
function writableColumns(
  kind: WritableConfigKind,
  h: {
    canWrite: boolean;
    onEdit: (row: ConfigItem) => void;
    onToggle: (row: ConfigItem) => void;
    togglingId: string | undefined;
  },
): TableColumnsType<ConfigItem> {
  const cols = CONFIG_KIND_META[kind].columns;
  const out: TableColumnsType<ConfigItem> = [];
  if (cols.includes("seq")) {
    out.push({
      key: "seq",
      title: "序号",
      width: 64,
      align: "center",
      render: (_v, _r, i) => <span className="num">{i + 1}</span>,
    });
  }
  out.push({
    key: "name",
    title: "名称",
    dataIndex: "name",
    render: (v: string) => <span style={{ fontWeight: 500 }}>{v}</span>,
  });
  if (cols.includes("code")) {
    out.push({
      key: "code",
      title: "编码",
      dataIndex: "code",
      width: 160,
      render: (v: string) => <span className="num">{v}</span>,
    });
  }
  if (cols.includes("color")) {
    out.push({
      key: "color",
      title: "颜色",
      dataIndex: "color",
      width: 120,
      // 库里存的是**色名**（`slate` / `cobalt`），不是色值；页面不猜色值（禁令⑦：色值只在 brand.ts）
      render: (v: string) => (v ? <span className="num">{v}</span> : <span className="ph">—</span>),
    });
  }
  if (cols.includes("semantics")) {
    out.push({
      key: "semantics",
      title: "语义",
      dataIndex: "semantics",
      width: 120,
      render: (v: string | null, r) => (
        <Space size={6}>
          <Tag variant="filled" style={{ marginInlineEnd: 0 }}>
            {v ? (STATUS_SEMANTIC_LABELS[v as keyof typeof STATUS_SEMANTIC_LABELS] ?? v) : "—"}
          </Tag>
          {r.isInitialStatus ? (
            <Tooltip title="初始态：新建记录要用到它，不能停用">
              <Tag color="blue" variant="filled" style={{ marginInlineEnd: 0 }}>
                初始
              </Tag>
            </Tooltip>
          ) : null}
        </Space>
      ),
    });
  }
  if (cols.includes("host")) {
    out.push({
      key: "host",
      title: "适用",
      dataIndex: "hostType",
      width: 130,
      render: (v: string | null) =>
        v === "matter" ? "案件" : v === "risk_matter" ? "事项" : (v ?? "—"),
    });
  }
  out.push({
    key: "status",
    title: "状态",
    dataIndex: "isEnabled",
    width: 120,
    render: (v: boolean) => (
      <Space size={6}>
        <Tag color={v ? "green" : "default"} variant="filled" style={{ marginInlineEnd: 0 }}>
          {v ? "启用" : "停用"}
        </Tag>
      </Space>
    ),
  });
  out.push({
    key: "actions",
    title: "操作",
    width: 140,
    render: (_v, r) =>
      h.canWrite ? (
        <Space size={4}>
          <Button size="small" type="link" onClick={() => h.onEdit(r)}>
            编辑
          </Button>
          <Button
            size="small"
            type="link"
            danger={r.isEnabled}
            loading={h.togglingId === r.id}
            onClick={() => h.onToggle(r)}
          >
            {r.isEnabled ? "停用" : "启用"}
          </Button>
        </Space>
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          —
        </Typography.Text>
      ),
  });
  return out;
}

/**
 * 新增 / 编辑弹层（一个页面只放一个 `.mask` —— 这里就是那一个 `Modal`）。
 *
 * 字段按细项语义给：状态页多「语义」（编辑时，因为新建只能 custom）、标签页多「适用」、
 * 标签与状态页多「颜色」。`code` 只在新增时出现（创建后不可改，它是引用键）。
 */
function ConfigFormModal({
  kind,
  open,
  row,
  onClose,
  onDone,
}: {
  kind: WritableConfigKind;
  open: boolean;
  row: ConfigItem | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const f = CONFIG_WRITE_FIELDS[kind];
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<Record<string, unknown>>();
  const isEdit = row !== null;

  // 每次打开重置（同一竞态：afterOpenChange 要等动画，别用它做初始化）
  useEffect(() => {
    if (!open) return;
    if (row) {
      form.setFieldsValue({
        name: row.name,
        color: row.color,
        sortOrder: row.sortOrder,
        hostType: row.hostType ?? undefined,
        ...(f.hasSemantics ? { semantics: row.semantics ?? undefined } : {}),
      });
    } else {
      form.resetFields();
    }
  }, [open, row?.id, form, f.hasSemantics]);

  const mut = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      isEdit
        ? api.patch<{ ok: true }>(kindUrl(kind), { id: row!.id, ...values })
        : api.post<{ ok: true }>(kindUrl(kind), values),
    onSuccess: () => {
      message.success(isEdit ? "已保存" : "已新增");
      onDone();
      onClose();
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "保存失败"),
  });

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={`${isEdit ? "编辑" : "新增"}${CONFIG_KIND_META[kind].label}`}
      okText={isEdit ? "保存" : "新增"}
      confirmLoading={mut.isPending}
      onOk={() => {
        void form
          .validateFields()
          .then((v) => mut.mutate(v))
          .catch(() => undefined);
      }}
    >
      <Form form={form} layout="vertical" requiredMark>
        <Form.Item label="名称" name="name" rules={[{ required: true, message: "名称必填" }]}>
          <Input placeholder="如 已撤诉" maxLength={50} />
        </Form.Item>
        {isEdit ? null : f.needsCode ? (
          <Form.Item
            label="编码"
            name="code"
            rules={[
              { required: true, message: "编码必填" },
              { pattern: /^[a-z][a-z0-9_]{0,31}$/, message: "小写英文、数字与下划线，以字母开头" },
            ]}
          >
            <Input placeholder="如 withdrawn" maxLength={32} />
          </Form.Item>
        ) : null}
        {f.needsHost ? (
          <Form.Item
            label="适用"
            name="hostType"
            rules={[{ required: true, message: "选择适用宿主" }]}
          >
            <Select
              placeholder="案件 / 事项"
              options={[
                { value: "matter", label: "案件" },
                { value: "risk_matter", label: "事项" },
              ]}
            />
          </Form.Item>
        ) : null}
        {f.hasColor ? (
          <Form.Item label="颜色" name="color">
            <Input placeholder="色名，如 slate" maxLength={20} />
          </Form.Item>
        ) : null}
        {isEdit && f.hasSemantics ? (
          <Form.Item
            label="语义"
            name="semantics"
            extra="决定系统行为：初始态 / 进行中 / 结案 / 归档 / 自定义"
          >
            <Select
              allowClear
              options={Object.entries(STATUS_SEMANTIC_LABELS).map(([value, label]) => ({
                value,
                label,
              }))}
            />
          </Form.Item>
        ) : null}
        <Form.Item label="排序" name="sortOrder">
          <InputNumber min={0} max={9999} style={{ width: "100%" }} placeholder="数字越小越靠前" />
        </Form.Item>
        {isEdit ? null : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            新增的状态语义固定为「自定义」；初始 / 归档 / 结案语义由系统内置。
          </Typography.Text>
        )}
      </Form>
    </Modal>
  );
}

/* ───────────────────── 只读：闭集枚举 7 + 无承载 2 ───────────────────── */

/** 细项 → 枚举的中文名字典（值域与迁移里的 CHECK 由 `enum-check.spec.ts` 双向核对） */
const ENUM_SOURCE: Partial<Record<ConfigKind, Record<string, string>>> = {
  case_type: CASE_TYPE_LABELS,
  procedure: PROCEDURE_LABELS,
  party_type: PARTY_TYPE_LABELS,
  id_type: ID_TYPE_LABELS,
  litigation_role: LITIGATION_ROLE_LABELS,
  risk_matter_type: RISK_MATTER_TYPE_LABELS,
  node_status: NODE_STATUS_LABELS,
};

function ReadOnlyConfig({ kind }: { kind: ConfigKind }) {
  const meta = CONFIG_KIND_META[kind];
  const source = ENUM_SOURCE[kind];
  const rows = source
    ? Object.entries(source).map(([code, name], i) => ({ code, name, seq: i + 1 }))
    : [];

  return (
    <>
      <div className="pagehead">
        <div>
          <BackToConfig />
          <h2>{meta.label}</h2>
        </div>
        <span className="sp" />
      </div>

      <div className="card">
        {source ? (
          <Table
            size="small"
            rowKey="code"
            pagination={false}
            dataSource={rows}
            columns={[
              {
                key: "seq",
                title: "序号",
                width: 64,
                align: "center",
                render: (_v, _r, i) => <span className="num">{i + 1}</span>,
              },
              { key: "name", title: "名称", dataIndex: "name" },
              {
                key: "code",
                title: "编码",
                dataIndex: "code",
                width: 200,
                render: (v: string) => <span className="num">{v}</span>,
              },
            ]}
          />
        ) : (
          <div className="card-b">
            <Typography.Text style={{ fontSize: 13 }}>
              {kind === "node_notify_status"
                ? "「哪些节点状态要发通知」在库里没有承载 —— 通知由自动化规则的 seed 决定。改动要走迁移。"
                : "节点通知时间的近似承载在节点类型的「默认提前天数」（本批次不做节点类型页）。改动要走迁移。"}
            </Typography.Text>
          </div>
        )}
      </div>

      <Typography.Text style={{ fontSize: 12, color: INK.muted, display: "block", marginTop: 12 }}>
        这些取值写在代码与迁移里（与数据库的 CHECK 双向核对），改动要走迁移，不在这里改。
      </Typography.Text>
    </>
  );
}
