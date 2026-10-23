"use client";

import { useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { Alert, App as AntdApp, Avatar, Button, Form, Input, Modal, Tag } from "antd";
import { useState } from "react";

import { api, ApiFailure, useActor, type Actor } from "@/app/lib/client/api";
import { PageHeader } from "@/app/components/page-header";
import { StateBlock } from "@/app/components/ui/state-block";
import { DATA_SCOPE_LABELS, type DataScope } from "@/shared/enums/targets";

/**
 * 个人设置（2026-10-18）。
 *
 * ## 这一页能说什么、不能改什么
 *
 * 一期**没有任何自助写路径**：改显示名没有接口；改自己的口令要 `isSystemOwner`
 * （`services/users.ts` 的 `setUserCredential` 第一行就拦），且 PRD §7 假设 E 把本地密码
 * 限定给极少数账号。所以这一页的主体是**只读事实**——它回答"我是谁、我能看到多少、
 * 我手里有哪些特权"，而不是一个设置表单。摆一排禁用控件会暗示"这里本来能改"，
 * 那是假的（`roles-view.tsx` 对只读页同一条口径）。
 *
 * 唯一的动作是「设置本地口令」，且**只对系统所有者出现**——他的账号是凭据生命线，
 * 而这一页正是他给自己设口令最自然的落点（用户管理页也能设，但那是"管别人"的地方）。
 *
 * ## 数据来源
 *
 * 全部来自 `/api/session`（`useActor`，`staleTime: Infinity`）。**不为这一页新开端点**：
 * 所要用到的字段它一个不少，再开一个 `/api/me` 就是同一份 DTO 的第二个来源。
 */

/** 四项特权的中文名。与 `roles-view.tsx` 的 `PRIVILEGES` 同词（PRD §2.1 原词）。 */
const PRIVILEGE_ITEMS: { key: keyof Actor["privileges"]; label: string; hint: string }[] = [
  { key: "canUnarchive", label: "撤销归档", hint: "把已归档的案件/事项退回在办" },
  { key: "canReadPlain", label: "明文导出", hint: "导出未脱敏的证件号" },
  { key: "canManageUser", label: "管理账号", hint: "建号、授予角色、停用" },
  { key: "canManageConfig", label: "管理配置", hint: "改功能配置里的值" },
];

export function ProfileView() {
  const { data: actor, isError, error, refetch, isFetching } = useActor();
  const [credOpen, setCredOpen] = useState(false);

  const held = useMemo(
    () => (actor ? PRIVILEGE_ITEMS.filter((p) => actor.privileges[p.key]) : []),
    [actor],
  );

  if (isError) {
    return (
      <StateBlock
        tone="error"
        title="读不到当前会话"
        hint={error instanceof Error ? error.message : "未知错误"}
        action={
          <button type="button" className="btn sm" onClick={() => void refetch()}>
            重试
          </button>
        }
      />
    );
  }

  return (
    /*
     * 外层**刻意不是 `.stack`**：`.page > .stack > *:last-child` 会让末张卡吃掉整屏余量
     * （那是对"表格/主从区要撑满"的处置），而本页是几张某自然高的卡片，
     * 被拉高之后末卡里空一大片——实测过，观感很糟。
     * 功能配置页的卡片网格是同一处置（`globals.css` 那条注释里写着它）：
     * 不需要撑满的页就用**独立容器**，于是余量规则不命中；卡片间距由 `.card + .card` 承担。
     *
     * `maxWidth` 是这一页自己的事：纯文字卡片摊到 1400px 会读起来费劲，
     * 而全站的表格页需要那个宽度。这不是"窄容器组件"，是一处页级参数。
     */
    <div style={{ maxWidth: 720 }}>
      <PageHeader
        title="个人设置"
        actions={
          actor?.isSystemOwner ? (
            <Button onClick={() => setCredOpen(true)}>设置本地口令</Button>
          ) : null
        }
      />

      <div className="card">
        <div className="card-h">
          <h2>账号</h2>
        </div>
        <div className="card-b">
          {actor ? (
            <div className="rowflex" style={{ gap: 14, alignItems: "center" }}>
              <Avatar size={44}>{actor.displayName.slice(0, 1)}</Avatar>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{actor.displayName}</div>
                <div className="mut3" style={{ fontSize: 12 }}>
                  {DATA_SCOPE_LABELS[actor.dataScope as DataScope]?.zh ?? actor.dataScope}
                </div>
              </div>
              {actor.isSystemOwner ? (
                <Tag color="blue" style={{ marginInlineStart: "auto" }}>
                  系统所有者
                </Tag>
              ) : null}
            </div>
          ) : (
            <div className="ph" style={{ fontSize: 13 }}>
              读取中…
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>数据范围</h2>
        </div>
        <div className="card-b">
          {/*
            只写**定义**（这一档看得见什么），不写"为什么你没有更宽的范围"——
            那是旁白（副标题纪律）。范围公式来自 `DATA_SCOPE_LABELS`，不在本页抄第二份。
          */}
          <div style={{ fontSize: 13 }}>
            {actor ? (DATA_SCOPE_LABELS[actor.dataScope as DataScope]?.formula ?? "—") : "—"}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>持有特权</h2>
        </div>
        <div className="card-b">
          {actor ? (
            held.length ? (
              <ul className="tl" style={{ display: "grid", gap: 8 }}>
                {held.map((p) => (
                  <li key={p.key} style={{ fontSize: 13 }}>
                    {p.label}
                    <span className="mut3" style={{ fontSize: 12, marginLeft: 8 }}>
                      {p.hint}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mut3" style={{ fontSize: 13 }}>
                没有额外特权。你仍可查看与办理数据范围内的案件与事项。
              </div>
            )
          ) : (
            <div className="ph" style={{ fontSize: 13 }}>
              读取中…
            </div>
          )}
        </div>
      </div>

      {isFetching && !actor ? null : null}

      <CredentialDialog
        open={credOpen}
        onClose={() => setCredOpen(false)}
        actor={actor}
        onDone={() => void refetch()}
      />
    </div>
  );
}

/**
 * 设置 / 重置**自己**的本地口令。
 *
 * 与用户管理页那份（`users-view.tsx` 的 `CredentialDialog`）差别只有两处，都是实质的：
 *   · 目标固定是 `actor.userId`，不由外部传——这一页不可能作用到别人身上；
 *   · 端点相同（`/api/users/<自己>/credential`），判定仍在服务端（`isSystemOwner`）。
 *     前端把"是不是所有者"当作**显不显示按钮**，不当作授权——非所有者即便手搓请求也是 403。
 */
function CredentialDialog({
  open,
  actor,
  onClose,
  onDone,
}: {
  open: boolean;
  actor: Actor | undefined;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<{ password: string }>();

  const mut = useMutation({
    mutationFn: (password: string) =>
      api.post<{ ok: true }>(`/api/users/${actor?.userId}/credential`, { password }),
    onSuccess: () => {
      message.success("口令已设置。下次登录用它——系统不会回显它。");
      form.resetFields();
      onDone();
      onClose();
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "设置失败"),
  });

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="设置本地口令"
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
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          title="本地口令只在这套系统内生效"
          description="它是系统所有者账户的恢复通道：设好之后请自行留存，系统不会回显，也没有第二个人能替你重置。"
        />
        <Form.Item
          label="新口令"
          name="password"
          rules={[
            { required: true, message: "请输入新口令" },
            { min: 8, message: "口令至少 8 位" },
            { max: 128, message: "口令别超过 128 位" },
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
