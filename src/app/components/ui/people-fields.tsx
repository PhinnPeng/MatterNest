"use client";

import { useQuery } from "@tanstack/react-query";
import { Form, Select, Typography } from "antd";

import { api } from "@/app/lib/client/api";

/**
 * 创建表单上的「处理人 / 关注人」选择面（MATT-49 / IQ-5 / IQ-14）。
 *
 * ## 为什么两个表单共用这一个组件
 *
 * 案件与事项两侧的规则**逐字相同**：候选人是全体"在册且已开通"的用户，不受 §4.1
 * 共现集限制（IQ-14 的创建期例外）。各写一份的话，两侧会在"要不要排除待开通"这种
 * 细节上慢慢分叉——而那种分叉不会报错，只会让某一侧的登记表单里少一个人。
 *
 * ## 为什么它和详情页那个选择面不是同一个数据源
 *
 * 详情页走 `/api/{host}/{id}/selectable-users`（**带宿主上下文**、有共现收窄）：
 * 往已有案卷里加人是一种权限外溢，必须收窄。
 * 创建表单走 `/api/selectable-users`（**不带宿主**）：此刻还没有案卷可依据，
 * 而首次上报的业务同事共现集为空——不收窄的话这个字段对新上报人根本不可用。
 * 两条口径的边界写在 `selectable-users.ts` 的文件头注里。
 *
 * ⚠ 这个下拉只是**提示**：真正的判定在写路径（`assertAssignable`），
 * 绕过界面直接 POST 一个停用账号会被 422 拒。有真 HTTP 断言与反向红。
 */
export function useCreatePeople() {
  return useQuery({
    queryKey: ["selectable-users", "create"],
    queryFn: () =>
      api.get<{ users: { id: string; displayName: string; username: string }[] }>(
        "/api/selectable-users",
      ),
    // 表单可能在一次会话里开合多次，而这个名单几乎不变
    staleTime: 5 * 60_000,
  });
}

type Option = { value: string; label: string };

function toOptions(users: { id: string; displayName: string; username: string }[]): Option[] {
  return users.map((u) => ({ value: u.id, label: `${u.displayName}（${u.username}）` }));
}

/** 处理人（单选） */
export function OwnerField({ options }: { options: Option[] }) {
  return (
    <Form.Item
      label="处理人"
      name="ownerId"
      extra="留空则自己承办；只能选在册且已开通的同事"
      // 事项侧允许清空（IQ-5：未指派是合法状态），所以不设 required
    >
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="默认自己"
        options={options}
      />
    </Form.Item>
  );
}

/** 关注人（多选） */
export function FollowersField({ options }: { options: Option[] }) {
  return (
    <Form.Item label="关注人" name="followerIds">
      <Select
        mode="multiple"
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="可留空"
        options={options}
        maxTagCount="responsive"
      />
    </Form.Item>
  );
}

/** 名单读不到时的一句话（放在两个字段下方，避免同一句写两遍） */
export function PeopleLoadHint({ isError, isPending }: { isError: boolean; isPending: boolean }) {
  if (!isError && !isPending) return null;
  return (
    <Typography.Text type={isError ? "danger" : "secondary"} style={{ fontSize: 12 }}>
      {isError ? "可选名单读不到，处理人与关注人暂时选不了（其余字段不受影响）" : "读取可选名单…"}
    </Typography.Text>
  );
}

export { toOptions as toPeopleOptions };
