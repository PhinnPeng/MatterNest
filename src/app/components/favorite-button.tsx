"use client";

import { App as AntdApp, Button, Tooltip } from "antd";
import { StarFilled, StarOutlined } from "@ant-design/icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api, ApiFailure } from "@/app/lib/client/api";

/**
 * 收藏 ⭐（MATT-63 / F1-13）。
 *
 * ## 与「关注人」控件**刻意分开**
 *
 * 收藏是**私人的**（谁收藏了什么只有自己看得见），关注人是**公开的**
 * （「n 人关注」名单谁都读得到）。两者共用 `mn_user_watch` 一张表，但 `watch_type`
 * 不同、可见性不同、界面位置也不同——**合成一个控件会让"我点了它"变成"名单 +1"**，
 * 那正是 ADR-0003 那句「眼睛与 n 人关注是同一张表的两面」要保住的东西。
 *
 * ## 为什么是 `PUT`/`DELETE` 而不是 `POST`
 *
 * 幂等：连点两下 = 一次（`PUT` 的语义）。用户连点是常态，`POST` 语义下"每次点都产生
 * 一条记录"的暗示会让人不敢点第二次。
 *
 * ## 为什么初值从详情 DTO 来，而不是自己 GET
 *
 * `GET /api/watch/{type}/{id}` 是可枚举的存在性探针（换个 id 就能问"这条存在吗"）。
 * 详情页本来就拿到了 `favorited`，所以这里只**受控**显示——`favorited` 由父组件给，
 * 切换后由 react-query 失效重取详情。
 */
export function FavoriteButton({
  host,
  hostId,
  favorited,
}: {
  host: "matter" | "risk_matter";
  hostId: string;
  favorited: boolean;
}) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();

  const mut = useMutation({
    mutationFn: (next: boolean) =>
      next
        ? api.put<{ watching: boolean }>(`/api/watch/${host}/${hostId}`, { watching: true })
        : api.del<{ watching: boolean }>(`/api/watch/${host}/${hostId}`),
    onSuccess: (_r, next) => {
      message.success(next ? "已收藏" : "已取消收藏");
      // 详情 DTO 里带 `favorited`，所以失效详情的 key —— 不手写第二份状态。
      // 两个宿主的 key 不同名（`matter` / `risk`），这是既有约定，照抄不另立。
      void qc.invalidateQueries({ queryKey: [host === "matter" ? "matter" : "risk", hostId] });
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "操作失败"),
  });

  return (
    <Tooltip title={favorited ? "取消收藏" : "收藏后可在「我关注的」快速找到"}>
      <Button
        icon={favorited ? <StarFilled /> : <StarOutlined />}
        loading={mut.isPending}
        onClick={() => mut.mutate(!favorited)}
        aria-pressed={favorited}
        aria-label={favorited ? "取消收藏" : "收藏"}
      />
    </Tooltip>
  );
}
