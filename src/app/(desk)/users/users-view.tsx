"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Flex,
  Form,
  Input,
  Modal,
  Space,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import type { TableColumnsType } from "antd";

import { api, ApiFailure, useActor } from "@/app/lib/client/api";
import { fromNow } from "@/app/lib/client/format";
import { DataTable } from "@/app/components/ui/data-table/DataTable";
import { StateBlock } from "@/app/components/ui/state-block";
import { FlagMark } from "@/app/components/ui/status-mark";

/**
 * 用户与角色（MATT-10 / PRD F6-1 启停、F6-5 角色授予、F6-9 本地凭据、F6-11 待开通队列）。
 *
 * ## 三个面在这一页里
 *
 * ① **待批队列**在最上：它是"要我做决定"的工作面，该清空、该扎眼；
 * ② **用户列表**在下：它是"看全貌"；
 * ③ 两个弹窗承担写动作：角色授予、凭据设置。
 *
 * ## 两条界面口径
 *
 * · **读入口要 `canManageUser`**（服务端已拦，这里只是不让无权限者看到一张报错页）。
 *   没有它的人看到的是"这个页面需要「管理账号」权限"，不是一张 403 的空表。
 * · **不给必被拒的按钮**：改自己的角色、停用自己、停用系统所有者——服务端都会拒，
 *   界面就别把按钮摆出来让人点了才知道。这与"藏起来挡不住构造好的请求"不矛盾：
 *   **服务端是权威，界面只是不骗人**（服务端那三条拒绝码有各自的冒烟断言）。
 *
 * ⚠ **`useActor()` 是 `staleTime: Infinity` 的会话缓存**，所以按钮可见性可能滞后于
 * 真实的角色变更（别人改了我的角色、我没刷新）。这是**故意的边界**：可见性可以滞后，
 * **授权不会**——`readActor` 每个请求重判一次（MATT-10 的硬要求"角色变更下一次请求
 * 即生效"）。所以这里不拿缓存的布尔值去做任何"能不能"的判断，只用来决定摆不摆按钮。
 *
 * ## 为什么用 `DataTable` 而不是裸 `antd Table`
 *
 * 它是全站唯一的数据表入口（禁令⑧）。本页不分页不排序（十人组织一页装完），
 * 于是 `pageSize = 行数`、两个回调传空实现——`DataTable` 在 `total > pageSize` 时才画
 * 分页条，所以这里不会出现一条假的页码。**不写 `sorter: true`**：列上给了它就会走
 * 服务端排序，而本端点没有排序参数（要加得先给服务端）。
 */

type UserRow = {
  id: string;
  username: string;
  displayName: string;
  isEnabled: boolean;
  isAdmin: boolean;
  isSystemOwner: boolean;
  activationStatus: string;
  hasCredential: boolean;
  lastLoginAt: string | null;
  roleIds: string[];
  roleCodes: string[];
};

type RoleRow = {
  id: string;
  code: string;
  name: string;
  dataScope: string;
  canManageUser: boolean;
  canManageConfig: boolean;
  isSystem: boolean;
};

const ACTIVATION_LABELS: Record<string, string> = {
  active: "已开通",
  pending: "待开通",
};

export function UsersView() {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const actor = useActor();
  const [roleTarget, setRoleTarget] = useState<UserRow | null>(null);
  const [credTarget, setCredTarget] = useState<UserRow | null>(null);
  const [approveTarget, setApproveTarget] = useState<UserRow | null>(null);

  const q = useQuery({
    queryKey: ["users"],
    queryFn: () => api.get<{ users: UserRow[]; roles: RoleRow[] }>("/api/users"),
    // 权限不足是**确定的**结果，重试三次只是把同一句话念三遍
    retry: false,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["users"] });
    void qc.invalidateQueries({ queryKey: ["session"] });
  };

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch<{ ok: true }>(`/api/users/${id}`, { enabled }),
    onSuccess: (_r, v) => {
      message.success(v.enabled ? "已启用" : "已停用（该账号的会话同时吊销）");
      invalidate();
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "操作失败"),
  });

  if (q.isPending) {
    return <Card size="small" loading style={{ maxWidth: 1180, margin: "0 auto" }} />;
  }
  if (q.isError) {
    const e = q.error;
    const denied = e instanceof ApiFailure && e.status === 403;
    return (
      <StateBlock
        tone={denied ? "empty" : "error"}
        title={denied ? "这个页面需要「管理账号」权限" : "用户列表读不到"}
        hint={
          denied
            ? "持该权限的角色（如系统管理）才能看到企业内的账号。需要的话请管理员授予。"
            : e instanceof Error
              ? e.message
              : "未知错误"
        }
        action={
          denied ? undefined : (
            <Button size="small" onClick={() => void q.refetch()}>
              重试
            </Button>
          )
        }
      />
    );
  }

  const users = q.data.users;
  const roles = q.data.roles;
  const roleName = (code: string) => roles.find((r) => r.code === code)?.name ?? code;
  const pending = users.filter((u) => u.activationStatus === "pending");
  const me = actor.data?.userId;
  const iAmOwner = actor.data?.isSystemOwner === true;

  const columns: TableColumnsType<UserRow> = [
    {
      key: "username",
      title: "账号",
      dataIndex: "username",
      width: 190,
      render: (_v, r) => (
        <Space size={6} wrap>
          <span className="num">{r.username}</span>
          {r.isSystemOwner ? <FlagMark tone="info">系统所有者</FlagMark> : null}
          {r.isAdmin ? <FlagMark tone="warn">逃生口</FlagMark> : null}
        </Space>
      ),
    },
    { key: "displayName", title: "显示名", dataIndex: "displayName", width: 140 },
    {
      key: "roles",
      title: "角色",
      dataIndex: "roleCodes",
      width: 220,
      render: (_v, r) =>
        r.roleCodes.length === 0 ? (
          <FlagMark tone="warn">无角色</FlagMark>
        ) : (
          <Space size={4} wrap>
            {r.roleCodes.map((c) => (
              <Tag key={c} variant="filled">
                {roleName(c)}
              </Tag>
            ))}
          </Space>
        ),
    },
    {
      key: "state",
      title: "状态",
      dataIndex: "isEnabled",
      width: 150,
      render: (_v, r) => (
        <Space size={6}>
          <Tag color={r.isEnabled ? "green" : "red"} variant="filled">
            {r.isEnabled ? "启用" : "停用"}
          </Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {ACTIVATION_LABELS[r.activationStatus] ?? r.activationStatus}
          </Typography.Text>
        </Space>
      ),
    },
    {
      key: "credential",
      title: "凭据",
      dataIndex: "hasCredential",
      width: 90,
      render: (_v, r) => (
        <Typography.Text type={r.hasCredential ? undefined : "warning"} style={{ fontSize: 12 }}>
          {r.hasCredential ? "已设" : "未设"}
        </Typography.Text>
      ),
    },
    {
      key: "lastLoginAt",
      title: "最后登录",
      dataIndex: "lastLoginAt",
      width: 110,
      // 相对时间：列表里"3 天前"比"2026年9月24日 14:02"更适合扫读（format.ts 的口径）
      render: (v: string | null) => <span style={{ fontSize: 12 }}>{v ? fromNow(v) : "从未"}</span>,
    },
    {
      key: "actions",
      title: "操作",
      width: 230,
      fixed: "right",
      render: (_v, r) => {
        const isMe = r.id === me;
        return (
          <Space size={4} wrap>
            {/* 改自己的角色服务端必拒（self_escalation），所以这里不摆按钮 */}
            <Tooltip title={isMe ? "不能改自己的角色：请让另一位管理员来改" : undefined}>
              <Button size="small" disabled={isMe} onClick={() => setRoleTarget(r)}>
                改角色
              </Button>
            </Tooltip>
            <Tooltip
              title={
                r.isSystemOwner && r.isEnabled
                  ? "系统所有者不可被停用：停掉他就再没有人能设置本地凭据"
                  : isMe && r.isEnabled
                    ? "不能停用自己：这个动作没有撤销入口"
                    : undefined
              }
            >
              <Button
                size="small"
                danger={r.isEnabled}
                disabled={isMe || (r.isSystemOwner && r.isEnabled)}
                loading={toggle.isPending && toggle.variables?.id === r.id}
                onClick={() => toggle.mutate({ id: r.id, enabled: !r.isEnabled })}
              >
                {r.isEnabled ? "停用" : "启用"}
              </Button>
            </Tooltip>
            {/* 凭据入口只对系统所有者出现（F6-9；服务端判定，这里只是不摆必被拒的按钮） */}
            {iAmOwner ? (
              <Button size="small" onClick={() => setCredTarget(r)}>
                {r.hasCredential ? "重置口令" : "设口令"}
              </Button>
            ) : null}
          </Space>
        );
      },
    },
  ];

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto" }}>
      {pending.length > 0 ? (
        <Card
          size="small"
          style={{ marginBottom: 12 }}
          title={
            <Space size={8}>
              <span>待开通</span>
              <Tag color="orange" variant="filled">
                {pending.length}
              </Tag>
            </Space>
          }
        >
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            {pending.map((u) => (
              <Flex key={u.id} align="center" justify="space-between" gap={12} wrap>
                <Space size={8} wrap>
                  <span className="num">{u.username}</span>
                  <span>{u.displayName}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    批准时要当场指定角色——不指定的话他登进来什么都看不到。
                  </Typography.Text>
                </Space>
                <Button size="small" type="primary" onClick={() => setApproveTarget(u)}>
                  批准并指定角色
                </Button>
              </Flex>
            ))}
          </Space>
        </Card>
      ) : null}

      <DataTable<UserRow>
        title="用户与角色"
        columns={columns}
        rows={users}
        rowKey={(r) => r.id}
        total={users.length}
        // 十人组织一页装完：pageSize ≥ total ⇒ DataTable 不画分页条（它只在 total > pageSize 时画）
        page={1}
        pageSize={Math.max(users.length, 1)}
        onPageChange={() => {}}
        onSortChange={() => {}}
        loading={q.isFetching}
        hideable={[
          { key: "credential", title: "凭据" },
          { key: "lastLoginAt", title: "最后登录" },
        ]}
        tools={<Button icon={<ReloadOutlined />} onClick={() => void q.refetch()} />}
        empty={<Typography.Text style={{ fontSize: 12 }}>企业内还没有账号。</Typography.Text>}
      />

      <RoleDialog
        target={roleTarget}
        roles={roles}
        onClose={() => setRoleTarget(null)}
        onDone={invalidate}
      />
      <ApproveDialog
        target={approveTarget}
        roles={roles}
        onClose={() => setApproveTarget(null)}
        onDone={invalidate}
      />
      <CredentialDialog
        target={credTarget}
        onClose={() => setCredTarget(null)}
        onDone={invalidate}
      />
    </div>
  );
}

/** 角色授予 / 撤销（F6-5）。**整体替换**语义：取消勾选即撤销，与"没提交"分得清 */
function RoleDialog({
  target,
  roles,
  onClose,
  onDone,
}: {
  target: UserRow | null;
  roles: RoleRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [picked, setPicked] = useState<string[]>([]);

  // 打开时以该账号**现有角色**为初值。用 `useEffect` 而不是 `afterOpenChange`：
  // 后者要等开合动画结束才触发，与"打开后立刻读勾选态"存在竞态（本轮探针真踩到：
  // 断言读到的永远是空）。也不用 `key` 重挂载——那会让关闭动画消失。
  useEffect(() => {
    if (target) setPicked(target.roleIds);
  }, [target?.id]);

  const mut = useMutation({
    mutationFn: (roleIds: string[]) =>
      api.post<{ ok: true }>(`/api/users/${target?.id}/roles`, { roleIds }),
    onSuccess: () => {
      message.success("角色已更新（下一次请求即生效）");
      onDone();
      onClose();
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "保存失败"),
  });

  return (
    <Modal
      open={target !== null}
      onCancel={onClose}
      title={`改角色 · ${target?.displayName ?? ""}`}
      okText="保存"
      confirmLoading={mut.isPending}
      onOk={() => mut.mutate(picked)}
    >
      <Checkbox.Group
        value={picked}
        onChange={(v) => setPicked(v as string[])}
        style={{ display: "flex", flexDirection: "column", gap: 8 }}
      >
        {roles.map((r) => (
          <Checkbox key={r.id} value={r.id}>
            <Space size={6} wrap>
              <span>{r.name}</span>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {r.code} · 范围{" "}
                {r.dataScope === "all"
                  ? "全部记录"
                  : r.dataScope === "participating"
                    ? "我参与"
                    : "仅自己相关"}
                {r.canManageUser ? " · 可管账号" : ""}
                {r.canManageConfig ? " · 可管配置" : ""}
              </Typography.Text>
            </Space>
          </Checkbox>
        ))}
      </Checkbox.Group>
      {picked.length === 0 ? (
        <Typography.Text type="warning" style={{ fontSize: 12, display: "block", marginTop: 10 }}>
          一个角色都不给的话，他下次请求会拿到 401——不是"只读"，是登不进。
        </Typography.Text>
      ) : null}
    </Modal>
  );
}

/** 批准待开通（F6-11）：开通与"当场指定角色"是同一件事，所以同一次提交 */
function ApproveDialog({
  target,
  roles,
  onClose,
  onDone,
}: {
  target: UserRow | null;
  roles: RoleRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<{ roleIds: string[] }>();

  // 每次打开清空（同一竞态：afterOpenChange 要等动画，别用它做初始化）
  useEffect(() => {
    if (target) form.resetFields();
  }, [target?.id, form]);

  const mut = useMutation({
    mutationFn: (roleIds: string[]) =>
      api.post<{ ok: true }>(`/api/users/${target?.id}/approve`, { roleIds }),
    onSuccess: () => {
      message.success("已开通并授予角色");
      onDone();
      onClose();
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "批准失败"),
  });

  return (
    <Modal
      open={target !== null}
      onCancel={onClose}
      title={`批准开通 · ${target?.displayName ?? ""}`}
      okText="批准并授予"
      confirmLoading={mut.isPending}
      onOk={() => {
        const v = form.getFieldsValue();
        if (!v.roleIds?.length) {
          message.warning("至少指定一个角色");
          return;
        }
        mut.mutate(v.roleIds);
      }}
    >
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item
          label="角色"
          name="roleIds"
          rules={[{ required: true, message: "至少指定一个角色" }]}
        >
          <Checkbox.Group style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {roles.map((r) => (
              <Checkbox key={r.id} value={r.id}>
                {r.name}
              </Checkbox>
            ))}
          </Checkbox.Group>
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** 本地凭据设置 / 重置（F6-9）。口令只进不出：提交后不回显、列表里只有"已设/未设" */
function CredentialDialog({
  target,
  onClose,
  onDone,
}: {
  target: UserRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<{ password: string }>();

  useEffect(() => {
    if (target) form.resetFields();
  }, [target?.id, form]);

  const mut = useMutation({
    mutationFn: (password: string) =>
      api.post<{ ok: true }>(`/api/users/${target?.id}/credential`, { password }),
    onSuccess: () => {
      message.success("口令已设置。请当面或走安全渠道交给本人——系统不会回显它。");
      onDone();
      onClose();
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "设置失败"),
  });

  return (
    <Modal
      open={target !== null}
      onCancel={onClose}
      title={`${target?.hasCredential ? "重置口令" : "设置口令"} · ${target?.displayName ?? ""}`}
      okText="保存"
      confirmLoading={mut.isPending}
      onOk={() => {
        const v = form.getFieldsValue();
        if (!v.password || v.password.length < 8) {
          message.warning("口令至少 8 位");
          return;
        }
        mut.mutate(v.password);
      }}
    >
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item
          label="新口令"
          name="password"
          rules={[
            { required: true, message: "请输入新口令" },
            { min: 8, message: "口令至少 8 位" },
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
