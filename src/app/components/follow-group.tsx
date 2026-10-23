"use client";

import { useMemo, useState } from "react";
import {
  App as AntdApp,
  Button,
  Card,
  Divider,
  Dropdown,
  Flex,
  Input,
  Space,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  ArrowLeftOutlined,
  CheckOutlined,
  DownOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  PlusOutlined,
  UserDeleteOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery } from "@tanstack/react-query";

import { api, ApiFailure } from "@/app/lib/client/api";
import { BRAND, INK } from "@/app/theme/brand";

export type FollowFollower = { id: string; userId: string; name: string };

/**
 * 右段的紧凑规格（2026-10-22 批注「宽度小一点，紧凑布局」）。
 *
 * 只收**左右内边距与字号**，高度仍交给 antd 的默认档（32）：同排还有「变更状态」
 * 这类正常尺寸的按钮，把这一组改成 `size="small"` 会凹下去一截，看起来像没对齐。
 * 也不缩「人关注」三个字——它是这一段的全部信息，省掉就只剩一个数字。
 */
const COUNT_BTN = { paddingInline: 8, fontSize: 12 } as const;
const CARET = { fontSize: 9, marginRight: 4 } as const;

/**
 * 面板的横向刻度（2026-10-22 布局批注「整体收窄」）。
 *
 * 一个面宽 + 一个内缩：面板 216，所有行都从同一条 8px 竖线起排。此前三处各写一套
 * （菜单按钮 15、名单行 10、名单头 10），左边缘参差，读起来像拼起来的三个块；
 * 内缩统一后，"菜单项 / 分组名 / 人名"共用一条起始线，是这张面板唯一的竖向轴。
 */
const PANEL_W = 216;
const ROW_INSET = 8;
/** 菜单项与名单行共用同一档高度：28。40px 是表格行，28 是面板行，中间不取别的值 */
const MENU_ITEM = {
  height: 28,
  paddingInline: ROW_INSET,
  fontSize: 13,
} as const;
const ROSTER_ROW = { padding: `3px ${ROW_INSET}px` } as const;
const ROSTER_HEAD = { padding: `4px ${ROW_INSET}px 2px` } as const;

/**
 * 关注组（2026-10-22 用户裁定「收藏和关注的口径一致」）。
 *
 * ## 一条关系，两个面
 *
 * 左段的开关与右段的「n 人关注」名单是**同一条关系**（`*_staff.staff_role='follower'`）：
 * 我点一下，我就出现在名单里、计数 +1；再点一下，我那一行消失、计数 -1。
 * 此前详情页右上那颗 ⭐ 走的是另一张表（私人收藏），于是"我关注了"与"名单里没有我"
 * 可以同时成立——用户看到的就是两套口径。现在只留公开关注这一条。
 *
 * ## 为什么合成一组
 *
 * 它们是同一个对象的两个读法：左段回答"我关不关注"，右段回答"还有谁在关注"。
 * 分成两个独立按钮时，中间的空隙会让人以为是两件事；`Space.Compact` 让它们共用
 * 一条外框，读起来像一个控件。
 *
 * ## 菜单四段（用户给的版式）
 *
 *   1. 反向操作（关注 / 取消关注）——与左段同一个动作，多一个出口；
 *   2. 添加关注人——点开**在菜单内换页**（返回 + 标题、搜索框、人员下拉），不弹新窗口；
 *   3. 分割线；
 *   4. 名单（顶部一行「n 位成员正在关注」，我在名单里时带「我」）。
 *
 * 归档态：开关与「添加」都撤，菜单仍可打开看名单——只读不等于看不见谁在关注。
 */
export function FollowGroup({
  host,
  hostId,
  followers,
  meId,
  canManage,
  isArchived,
  onChanged,
}: {
  host: "matter" | "risk_matter";
  hostId: string;
  /** 已经筛好、按姓名排好的关注人（父组件从详情 DTO 的 staff 里取，不另发请求） */
  followers: FollowFollower[];
  meId: string;
  /** §6 名单管理权：经办人 / L1 / 创建人。没有这条权利的人仍能关注/取关自己 */
  canManage: boolean;
  isArchived: boolean;
  /** 写成功后的回流（父组件 invalidate 详情查询） */
  onChanged: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const [view, setView] = useState<"menu" | "add">("menu");
  const [keyword, setKeyword] = useState("");
  /** 添加页里**还没提交**的勾（本地状态）。关页/完成时才整批送去落库。 */
  const [picked, setPicked] = useState<string[]>([]);

  const base = host === "matter" ? `/api/matters/${hostId}` : `/api/risk-matters/${hostId}`;
  const followerUrl = host === "matter" ? `${base}/staff` : `${base}/staff/followers`;

  const iFollow = followers.some((f) => f.userId === meId);

  const onErr = (e: unknown) => message.error(e instanceof ApiFailure ? e.message : "关注操作失败");
  const done = () => {
    onChanged();
    setKeyword("");
  };

  const toggleSelf = useMutation({
    mutationFn: () =>
      iFollow
        ? api.del(host === "matter" ? `${base}/staff/${meId}` : `${followerUrl}/${meId}`)
        : host === "matter"
          ? api.post(followerUrl, { userIds: [meId], staffRole: "follower" })
          : api.post(followerUrl, { userIds: [meId] }),
    onSuccess: done,
    onError: onErr,
  });

  /**
   * 提交添加页里攒下来的勾——**一次请求、整批原子**（2026-10-22 批注：不要点一下就发一条）。
   *
   * 服务层本来就按"整批原子"实现（一个不合法就整请求拒），逐行发反而把它的语义拆碎了：
   * 连点五下会产生五条审计、五次列表重取，而且中途失败时前面几个已经落库、勾却全被清掉。
   *
   * 触发点是**完成或关闭**这一页，不是每一行：点行只改本地勾，用户看到的勾是"最终结果"，
   * 关页时一次结算。所以成功也不弹提示——勾变实、名单人数变了就是回执。
   */
  const addOthers = useMutation({
    mutationFn: (userIds: string[]) =>
      host === "matter"
        ? api.post<{ added: number; skipped: string[] }>(followerUrl, {
            userIds,
            staffRole: "follower",
          })
        : api.post<{ added: number; skipped: string[] }>(followerUrl, { userIds }),
    onSuccess: () => {
      setPicked([]);
      onChanged();
    },
    onError: onErr,
  });

  const removeOne = useMutation({
    mutationFn: (userId: string) =>
      api.del(host === "matter" ? `${base}/staff/${userId}` : `${followerUrl}/${userId}`),
    onSuccess: done,
    onError: onErr,
  });

  /** 结算并离开添加页（完成 / 返回 / 关掉菜单都走这里，避免勾被静默丢掉） */
  const settle = () => {
    if (picked.length > 0) addOthers.mutate(picked);
    setPicked([]);
    setView("menu");
    setKeyword("");
  };

  /** 候选人在**点开「添加关注人」那一刻**才取：菜单只是被扫一眼时不该发这条请求 */
  const selectable = useQuery({
    queryKey: ["selectable-users", host, hostId],
    queryFn: () =>
      api.get<{ users: { id: string; displayName: string; username: string }[] }>(
        `${base}/selectable-users`,
      ),
    enabled: view === "add",
  });

  /**
   * 名单页的行：**候选人在前、已关注的打勾**。
   *
   * 为什么把 `followers` 也并进来：`selectable-users` 只给"操作者可指派的人"
   * （§4.1 收窄后的可见用户集）。某个关注人可能不在这份集合里（他后来调岗/被停用，
   * 或者本就在操作者的可见集之外），若不补进来，勾会凭空少一个，读起来像"名单丢了人"。
   * 这些行只作**读事实**（已勾、点了没反应），真正的移除在菜单的名单里。
   *
   * 自己不特殊对待：它也是候选人之一，已关注时同样挂勾。
   */
  const people = useMemo(() => {
    const followed = new Set(followers.map((f) => f.userId));
    const list = selectable.data?.users ?? [];
    const extra = followers
      .filter((f) => !list.some((u) => u.id === f.userId))
      .map((f) => ({ id: f.userId, displayName: f.name, username: "" }));
    const kw = keyword.trim().toLowerCase();
    return [...list, ...extra]
      .filter(
        (u) =>
          !kw || u.displayName.toLowerCase().includes(kw) || u.username.toLowerCase().includes(kw),
      )
      .map((u) => ({
        ...u,
        /** 已在名单里——这行只读（减人走菜单的名单），勾不可撤销 */
        locked: followed.has(u.id),
        /** 视觉上的勾 = 已在名单 or 本次选中（还没提交） */
        checked: followed.has(u.id) || picked.includes(u.id),
      }));
  }, [selectable.data, followers, keyword, picked]);

  const roster = (
    <div>
      {/*
        分组名走 caption 档（11.5）而不是 12：它与下面的 13px 人名要拉开一档，
        12 与 13 之间只差 1px，读起来是同级的两种字号。
      */}
      <div style={{ ...ROSTER_HEAD, fontSize: 11.5, color: "var(--ink3)" }}>
        {followers.length} 位成员正在关注
      </div>
      {followers.length === 0 ? (
        <div style={{ padding: `0 ${ROW_INSET}px 4px`, fontSize: 12, color: "var(--ink3)" }}>
          还没有人关注。
        </div>
      ) : (
        followers.map((f) => (
          <Flex key={f.id} align="center" gap={6} style={{ ...ROSTER_ROW, borderRadius: 6 }}>
            <span style={{ flex: 1, minWidth: 0, fontSize: 13 }}>{f.name}</span>
            {f.userId === meId ? (
              <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                我
              </Tag>
            ) : null}
            {(canManage || f.userId === meId) && !isArchived ? (
              <Tooltip title={f.userId === meId ? "取消关注" : `移除 ${f.name}`}>
                <Button
                  size="small"
                  type="text"
                  style={{ width: 22, height: 22, minWidth: 22 }}
                  icon={<UserDeleteOutlined style={{ fontSize: 12 }} />}
                  loading={removeOne.isPending}
                  onClick={() => removeOne.mutate(f.userId)}
                />
              </Tooltip>
            ) : null}
          </Flex>
        ))
      )}
    </div>
  );

  const menuBody =
    view === "add" ? (
      <div style={{ width: PANEL_W }}>
        <Flex align="center" gap={2} style={{ marginBottom: 6, marginLeft: -4 }}>
          <Button
            type="text"
            size="small"
            icon={<ArrowLeftOutlined />}
            aria-label="返回"
            onClick={settle}
          />
          <Typography.Text strong style={{ fontSize: 13 }}>
            添加关注人
          </Typography.Text>
        </Flex>
        <Input
          size="small"
          allowClear
          placeholder="搜索并添加关注人"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          style={{ marginBottom: 4 }}
        />
        {/*
          行 = 勾选框的语义：点一下改**本地**勾，不立刻发请求；关页（完成/返回/点外面）时
          把攒下来的勾**一次**提交（服务层整批原子）。已经在名单里的行只读——减人走菜单的名单。
        */}
        <div style={{ maxHeight: 232, overflowY: "auto" }}>
          {selectable.isPending ? (
            <div style={{ ...ROSTER_HEAD, fontSize: 12, color: "var(--ink3)" }}>读取中…</div>
          ) : selectable.isError ? (
            <div style={{ ...ROSTER_HEAD, fontSize: 12, color: "var(--ink3)" }}>可选名单读不到</div>
          ) : people.length === 0 ? (
            <div style={{ ...ROSTER_HEAD, fontSize: 12, color: "var(--ink3)" }}>没有匹配的同事</div>
          ) : (
            people.map((u) => (
              <button
                key={u.id}
                type="button"
                disabled={u.locked}
                aria-pressed={u.checked}
                onClick={() =>
                  setPicked((prev) =>
                    prev.includes(u.id) ? prev.filter((x) => x !== u.id) : [...prev, u.id],
                  )
                }
                style={{
                  display: "flex",
                  width: "100%",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  padding: `5px ${ROW_INSET}px`,
                  border: "none",
                  borderRadius: 6,
                  background: "transparent",
                  textAlign: "left",
                  font: "inherit",
                  height: 28,
                  fontSize: 13,
                  color: u.checked ? "var(--ink2)" : "inherit",
                  cursor: u.locked ? "default" : "pointer",
                }}
              >
                <span
                  style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {u.displayName}
                </span>
                {u.checked ? (
                  <CheckOutlined style={{ color: BRAND.primary, fontSize: 12 }} />
                ) : (
                  <PlusOutlined style={{ color: "var(--ink3)", fontSize: 11 }} />
                )}
              </button>
            ))
          )}
        </div>
        <Button
          block
          size="small"
          style={{ marginTop: 8 }}
          disabled={picked.length === 0}
          loading={addOthers.isPending}
          onClick={settle}
        >
          完成
        </Button>
      </div>
    ) : (
      <div style={{ width: PANEL_W }}>
        {!isArchived ? (
          <Button
            type="text"
            block
            style={{ ...MENU_ITEM, justifyContent: "flex-start" }}
            icon={iFollow ? <EyeInvisibleOutlined /> : <EyeOutlined />}
            loading={toggleSelf.isPending}
            onClick={() => toggleSelf.mutate()}
          >
            {iFollow ? "取消关注" : "关注"}
          </Button>
        ) : null}
        {!isArchived && canManage ? (
          <Button
            type="text"
            block
            style={{ ...MENU_ITEM, justifyContent: "flex-start" }}
            icon={<PlusOutlined />}
            onClick={() => setView("add")}
          >
            添加关注人
          </Button>
        ) : null}
        {!isArchived ? <Divider style={{ margin: "2px 0" }} /> : null}
        {roster}
      </div>
    );

  if (isArchived) {
    return (
      <Dropdown
        open={menuOpen}
        onOpenChange={setMenuOpen}
        trigger={["click"]}
        popupRender={() => (
          <Card size="small" styles={{ body: { padding: 6 } }}>
            {menuBody}
          </Card>
        )}
      >
        <Button style={COUNT_BTN}>
          {followers.length} 人关注
          <DownOutlined style={CARET} />
        </Button>
      </Dropdown>
    );
  }

  return (
    <Space.Compact>
      <Tooltip title={iFollow ? "取消关注" : "关注后，这条的状态变更与新评论会通知你"}>
        {/*
          激活态**只让图标变色**（2026-10-22 批注）：整块变主色会把一个"我在关注"的
          个人标记渲染成页面上的主行动，抢走旁边「变更状态」的注意力；眼睛的形状本身
          （实心/空心）已经说明状态，颜色只做第二重确认。
        */}
        <Button
          icon={
            iFollow ? (
              <EyeOutlined style={{ color: BRAND.primary }} />
            ) : (
              <EyeInvisibleOutlined style={{ color: INK.muted }} />
            )
          }
          loading={toggleSelf.isPending}
          aria-pressed={iFollow}
          aria-label={iFollow ? "取消关注" : "关注"}
          onClick={() => toggleSelf.mutate()}
        />
      </Tooltip>
      <Dropdown
        open={menuOpen}
        onOpenChange={(v) => {
          setMenuOpen(v);
          // 关页也要结算：攒了勾却点外面关掉，不该静默丢掉（用户要的"完成或关闭后再执行"）
          if (!v) settle();
        }}
        trigger={["click"]}
        popupRender={() => (
          <Card size="small" styles={{ body: { padding: 6 } }}>
            {menuBody}
          </Card>
        )}
      >
        <Button style={COUNT_BTN}>
          <DownOutlined style={CARET} />
          {followers.length} 人关注
        </Button>
      </Dropdown>
    </Space.Compact>
  );
}
