"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { App as AntdApp, Button, Modal, Select, Space, Typography } from "antd";
import { PlusOutlined } from "@ant-design/icons";

import { api, ApiFailure } from "@/app/lib/client/api";

/**
 * 加参与人（MATT-49）。案件详情页「参与人」页签里的唯一写入口。
 *
 * ## 为什么选项来自带宿主上下文的接口，而不是「全体用户」
 *
 * 候选人是 `/api/matters/{id}/selectable-users` 给的，它的收窄规则与事项侧**同一条**
 * （`listSelectableUsers` 的宿主参数）：在册可用 + 落在**我的可见用户集**内。
 * 所以这个下拉里出现谁，取决于我本来能看见谁的案卷——不是一份全公司花名册。
 *
 * ⚠ 下拉只是**提示**，不是防线：真正的判定在写路径（`addMatterStaff` 四道门）。
 * 绕过界面直接 POST 一个不在下拉里的 id 会被 422 拒——这条有真 HTTP 断言与反向红。
 *
 * ## 为什么排除已在名单里的人
 *
 * 服务端对重复加是同一个人是幂等的（`added=0` + `skipped` 点名），但那对用户是白跑一趟。
 * 已经在名单里的人不再出现在选项里，是**减少一次无意义的往返**，不是权限判定。
 */
export function StaffPicker({
  matterId,
  staffRole,
  label,
  existingUserIds,
  onDone,
}: {
  matterId: string;
  staffRole: "co_owner" | "follower";
  label: string;
  existingUserIds: string[];
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);

  const q = useQuery({
    queryKey: ["selectable-users", "matter", matterId],
    queryFn: () =>
      api.get<{ users: { id: string; displayName: string; username: string }[] }>(
        `/api/matters/${matterId}/selectable-users`,
      ),
    // 只在打开时拉：详情页不打开弹窗就不该多发一个请求
    enabled: open,
    staleTime: 30_000,
  });

  const mut = useMutation({
    mutationFn: (userIds: string[]) =>
      api.post<{ added: number; skipped: string[] }>(`/api/matters/${matterId}/staff`, {
        userIds,
        staffRole,
      }),
    onSuccess: (r) => {
      message.success(r.added > 0 ? `已加入 ${r.added} 人` : "这些人已经在名单里了，没有变化");
      setPicked([]);
      setOpen(false);
      onDone();
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "加入失败"),
  });

  const inList = new Set(existingUserIds);
  const options = (q.data?.users ?? [])
    .filter((u) => !inList.has(u.id))
    .map((u) => ({ value: u.id, label: `${u.displayName}（${u.username}）` }));

  return (
    <>
      <Button size="small" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Modal
        open={open}
        title={label}
        okText="加入"
        confirmLoading={mut.isPending}
        okButtonProps={{ disabled: picked.length === 0 }}
        onCancel={() => {
          setPicked([]);
          setOpen(false);
        }}
        onOk={() => mut.mutate(picked)}
      >
        <Select
          mode="multiple"
          style={{ width: "100%" }}
          placeholder="选择同事"
          value={picked}
          onChange={(v) => setPicked(v as string[])}
          loading={q.isPending}
          options={options}
          optionFilterProp="label"
          notFoundContent={
            q.isError
              ? "读不到可选名单（可能这条案件你看不见）"
              : q.isPending
                ? "读取中…"
                : "没有可加的人了"
          }
        />
        {/* 一句话说清"为什么这里只有这几个人"——这是控件说明，不是旁白 */}
        <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 8 }}>
          只能加你本来就能看见的案卷里的同事；已停用、待开通、已删除的账号不在选项里。
        </Typography.Text>
        {q.isError ? (
          <Space style={{ marginTop: 8 }}>
            <Button size="small" onClick={() => void q.refetch()}>
              重试
            </Button>
          </Space>
        ) : null}
      </Modal>
    </>
  );
}
