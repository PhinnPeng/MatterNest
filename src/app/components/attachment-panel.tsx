"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  App as AntdApp,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Space,
  Table,
  Tag,
} from "antd";
import type { TableColumnsType } from "antd";
import { DownloadOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";

import { api, ApiFailure, type AttachmentItem, type AttachmentList } from "@/app/lib/client/api";
import { dateTime } from "@/app/lib/client/format";
import {
  fileProblem,
  formatBytes,
  openAttachment,
  uploadAttachment,
} from "@/app/lib/client/attachments";
import { StateBlock } from "@/app/components/ui/state-block";
import { rulesFor } from "@/app/components/form/zod-rules";
import {
  ATTACHMENT_LIST_STATES,
  attachmentMetaSchema,
  type AttachmentListState,
} from "@/shared/schema/attachments";

/**
 * 案件材料（2026-10-23 用户裁定）。
 *
 * 「材料」是宿主级附件（`scope='host'`）：上传即归属，不挂评论。评论附件仍在评论里，
 * 不在这张表里重复出现。三个动作——上传、编辑名称/描述、作废（软删）。
 * 归档宿主只读：列表仍可看，三个写动作全部禁用。
 */
type Host = "matter" | "risk_matter";

const STATE_OPTIONS: { label: string; value: AttachmentListState }[] = [
  { label: "生效", value: "active" },
  { label: "全部", value: "all" },
  { label: "作废", value: "deleted" },
];

/** URL 里 `?attach=` 的合法值与默认值（筛选可被复制/刷新保留） */
function stateFromUrl(raw: string | null): AttachmentListState {
  return raw && (ATTACHMENT_LIST_STATES as readonly string[]).includes(raw)
    ? (raw as AttachmentListState)
    : "active";
}

export function AttachmentPanel({
  host,
  hostId,
  archived = false,
}: {
  host: Host;
  hostId: string;
  archived?: boolean;
}) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  /**
   * 筛选的唯一来源是 URL（`?attach=`）：刷新/转发保持同一视图，不再在本地存第二份。
   */
  const state = stateFromUrl(searchParams.get("attach"));
  const [uploadOpen, setUploadOpen] = useState(false);
  const [editing, setEditing] = useState<AttachmentItem | null>(null);

  const changeState = (next: AttachmentListState) => {
    const qs = new URLSearchParams(searchParams.toString());
    if (next === "active") qs.delete("attach");
    else qs.set("attach", next);
    const suffix = qs.toString();
    router.replace(suffix ? `${pathname}?${suffix}` : pathname, { scroll: false });
  };

  const q = useQuery({
    queryKey: ["attachments", host, hostId, state],
    queryFn: () =>
      api.get<AttachmentList>(`/api/attachments?host=${host}&hostId=${hostId}&state=${state}`),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["attachments", host, hostId] });
  };

  const voidMut = useMutation({
    mutationFn: (id: string) => api.del<{ ok: true }>(`/api/attachments/${id}`),
    onSuccess: () => {
      message.success("附件已作废");
      invalidate();
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "作废失败，请重试"),
  });

  const download = async (item: AttachmentItem) => {
    try {
      const { url } = await api.get<{ url: string }>(`/api/attachments/${item.id}/url`);
      openAttachment(url);
    } catch (e) {
      message.error(e instanceof ApiFailure ? e.message : "附件打不开，请重试");
    }
  };

  const columns: TableColumnsType<AttachmentItem> = [
    {
      title: "名称",
      dataIndex: "displayName",
      width: 320,
      render: (_: unknown, r) => (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13 }}>{r.displayName}</div>
          {r.description ? (
            <div className="mut3" style={{ fontSize: 12, marginTop: 2, whiteSpace: "pre-wrap" }}>
              {r.description}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      title: "文件",
      dataIndex: "fileName",
      width: 220,
      render: (_: unknown, r) => (
        <button
          type="button"
          className="attachment-chip"
          title={`下载 ${r.fileName}`}
          onClick={() => void download(r)}
        >
          <DownloadOutlined style={{ fontSize: 11, color: "var(--ink3)" }} />
          <span className="name">{r.fileName}</span>
          <span className="meta num">{formatBytes(r.sizeBytes)}</span>
        </button>
      ),
    },
    {
      title: "上传",
      dataIndex: "uploadedAt",
      width: 170,
      render: (_: unknown, r) => (
        <div style={{ fontSize: 12 }}>
          <div>{r.uploadedBy}</div>
          <div className="mut3 num">{dateTime(r.uploadedAt)}</div>
        </div>
      ),
    },
    {
      title: "状态",
      dataIndex: "isDeleted",
      width: 110,
      render: (_: unknown, r) =>
        r.isDeleted ? <Tag color="default">已作废</Tag> : <Tag color="green">生效</Tag>,
    },
    {
      title: "操作",
      key: "ops",
      width: 150,
      render: (_: unknown, r) => (
        <Space size={4}>
          <Button
            size="small"
            type="text"
            icon={<DownloadOutlined />}
            onClick={() => void download(r)}
          >
            下载
          </Button>
          {!r.isDeleted ? (
            <>
              <Button
                size="small"
                type="text"
                icon={<EditOutlined />}
                disabled={archived}
                onClick={() => setEditing(r)}
              >
                编辑
              </Button>
              <Popconfirm
                title="作废这条附件？"
                description="作废后仍保留在「作废」筛选里，可回看，但不再出现在生效列表。"
                okText="作废"
                cancelText="取消"
                disabled={archived}
                onConfirm={() => voidMut.mutate(r.id)}
              >
                <Button size="small" type="text" danger disabled={archived || voidMut.isPending}>
                  作废
                </Button>
              </Popconfirm>
            </>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div className="rowflex" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <Space size={8}>
          <Segmented<AttachmentListState>
            size="small"
            options={STATE_OPTIONS.map((o) => ({
              ...o,
              label:
                o.value === "active"
                  ? `${o.label} ${q.data?.counts.active ?? 0}`
                  : o.value === "deleted"
                    ? `${o.label} ${q.data?.counts.deleted ?? 0}`
                    : `${o.label} ${(q.data?.counts.active ?? 0) + (q.data?.counts.deleted ?? 0)}`,
            }))}
            value={state}
            onChange={changeState}
          />
        </Space>
        <Button
          type="primary"
          size="small"
          icon={<PlusOutlined />}
          disabled={archived}
          onClick={() => setUploadOpen(true)}
        >
          上传附件
        </Button>
      </div>

      {q.isLoading ? null : q.isError ? (
        <StateBlock title="附件没加载出来" hint="刷新页面再试；一直失败就检查网络或联系管理员。" />
      ) : q.data && q.data.items.length > 0 ? (
        <Table<AttachmentItem>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={q.data.items}
          pagination={false}
          scroll={{ x: 760 }}
        />
      ) : (
        <StateBlock
          title={state === "deleted" ? "没有作废的附件" : "还没有附件"}
          hint={
            state === "deleted"
              ? "作废的附件会留在这里，可回看与下载。"
              : "合同、证据、裁判文书这类案卷附件登记在这里。"
          }
        />
      )}

      <UploadDialog
        host={host}
        hostId={hostId}
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onDone={invalidate}
      />
      <EditDialog item={editing} onClose={() => setEditing(null)} onDone={invalidate} />
    </div>
  );
}

function UploadDialog({
  host,
  hostId,
  open,
  onClose,
  onDone,
}: {
  host: Host;
  hostId: string;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<{ displayName: string; description?: string }>();
  const [file, setFile] = useState<File | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const mut = useMutation({
    mutationFn: (v: { displayName: string; description?: string }) =>
      uploadAttachment({
        host,
        hostId,
        scope: "host",
        name: v.displayName,
        description: v.description,
        file: file!,
        onProgress: setPercent,
      }),
    onSuccess: () => {
      onClose();
      message.success("附件已上传");
      onDone();
    },
    onError: (e) => {
      setPercent(null);
      message.error(e instanceof ApiFailure ? e.message : "上传失败，请重试");
    },
  });

  const reset = () => {
    form.resetFields();
    setFile(null);
    setPercent(null);
  };

  return (
    <Modal
      open={open}
      title="上传附件"
      okText="上传"
      cancelText="取消"
      confirmLoading={mut.isPending}
      destroyOnHidden
      afterClose={reset}
      onCancel={onClose}
      onOk={async () => {
        const v = await form.validateFields();
        if (!file) {
          message.error("请选择要上传的文件");
          return;
        }
        const problem = fileProblem(file);
        if (problem) {
          message.error(problem);
          return;
        }
        mut.mutate(v);
      }}
    >
      <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
        <Form.Item
          name="displayName"
          label="附件名称"
          rules={rulesFor(attachmentMetaSchema, ["displayName"])}
        >
          <Input maxLength={255} placeholder="例如：一期施工合同（盖章版）" />
        </Form.Item>
        <Form.Item name="description" label="描述">
          <Input.TextArea rows={2} maxLength={4000} placeholder="这份附件说明什么、从哪来" />
        </Form.Item>
        <Form.Item label="附件" required>
          <Space>
            <Button onClick={() => inputRef.current?.click()} disabled={mut.isPending}>
              选择文件
            </Button>
            <span className="mut" style={{ fontSize: 12 }}>
              {file ? `${file.name}（${formatBytes(file.size)}）` : "未选择"}
            </span>
          </Space>
          <input
            ref={inputRef}
            type="file"
            hidden
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </Form.Item>
        {percent !== null ? (
          <div className="mut3" style={{ fontSize: 12 }}>
            上传中 {percent}%
          </div>
        ) : null}
      </Form>
    </Modal>
  );
}

function EditDialog({
  item,
  onClose,
  onDone,
}: {
  item: AttachmentItem | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<{ displayName: string; description?: string }>();

  const mut = useMutation({
    mutationFn: (v: { displayName: string; description?: string }) =>
      api.patch<{ ok: true }>(`/api/attachments/${item!.id}`, v),
    onSuccess: () => {
      onClose();
      message.success("附件已更新");
      onDone();
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "保存失败，请重试"),
  });

  return (
    <Modal
      open={item !== null}
      title="编辑附件"
      okText="保存"
      cancelText="取消"
      confirmLoading={mut.isPending}
      destroyOnHidden
      afterClose={() => form.resetFields()}
      onCancel={onClose}
      onOk={async () => {
        const v = await form.validateFields();
        mut.mutate(v);
      }}
    >
      <Form
        form={form}
        layout="vertical"
        style={{ marginTop: 12 }}
        initialValues={
          item ? { displayName: item.displayName, description: item.description ?? "" } : undefined
        }
      >
        <Form.Item
          name="displayName"
          label="附件名称"
          rules={rulesFor(attachmentMetaSchema, ["displayName"])}
        >
          <Input maxLength={255} />
        </Form.Item>
        <Form.Item name="description" label="描述">
          <Input.TextArea rows={3} maxLength={4000} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
