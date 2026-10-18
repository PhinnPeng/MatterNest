"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Flex, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";

import { INK } from "@/app/theme/brand";
import { api } from "@/app/lib/client/api";
import { StateBlock } from "@/app/components/ui/state-block";
import { DATA_SCOPE_LABELS, type DataScope } from "@/shared/enums/targets";

/**
 * 角色权限（MATT-100，**只读**）。
 *
 * ## 这一页为什么是只读
 *
 * 角色定义（谁有什么能力）是系统的**公开契约**、稳定的少数几个；而"谁持有什么角色"
 * 是人的信息、会频繁变动。把两者摆在同一页编辑，就会有人把角色定义当成日常配置改。
 * 所以本页只讲事实：改人走**用户管理**页（授予入口在那边，角色成员卡右上角指路）。
 * 页面上明写「只读」——不摆一排禁用按钮（`config-view.tsx` 同口径：禁用按钮是
 * "这里本来能改但不让你改"的暗示，而这里根本不提供改的能力）。
 *
 * ## 成员清单分两档（票面的权限门）
 *
 * 角色定义登录即可读；**成员清单要 `canManageUser`**（与 `/api/users` 同一档：
 * 能列出全部在册同事就等于拿到一份花名册）。无权限者服务端把 `members` 给成 `null`
 * （不是空数组）——本页据此说两种不同的话：
 *   · `null` = 你看不到成员清单，**只给计数**；
 *   · `[]`   = 你看得到，但这个角色确实还没人持有（空态 + 去授予）。
 * 这两种混成一种，用户就无法区分"没权限"与"确实没人"。
 *
 * ## 布局：主从 + 两栏等高
 *
 * 左 264px 角色列表、右内容区。等高**不写死高度**（`globals.css` 的 `.master` 一节）：
 * grid 默认 stretch + 右栏 flex 列 + 选中 pane `flex:1` + pane 内**末张卡** `flex:1 1 auto`。
 * 高度取两侧内容的较大者，加第 6 个角色会自适应（原型实测 365 → 424 且仍齐平）。
 * 选中态用 React 状态，不落 URL——它是同一页上的观察位置，不是可分享的资源
 * （与通知中心"分页不进 URL"同一条理由）。
 */

type RoleMember = { id: string; username: string; displayName: string };

type RoleDetail = {
  id: string;
  code: string;
  name: string;
  dataScope: string;
  canUnarchive: boolean;
  canReadPlain: boolean;
  canManageUser: boolean;
  canManageConfig: boolean;
  isSystem: boolean;
  holderCount: number;
  /** `null` = 没有看成员清单的权限（无 `canManageUser`），页面只给计数 */
  members: RoleMember[] | null;
};

/**
 * 四项特权的名字与一句话含义。
 *
 * 用 PRD §2.1 的原词（撤销归档 / 明文导出 / 管理账号 / 管理配置）。
 * ⚠ 账号页（`users-view.tsx`）今天用的是「可管账号 / 可管配置」那一对——两处是同一件事的
 * 两种叫法，统一归本页之外的批次处理（api-touchpoints §1.3 记着这条）。
 * 这里只出现一次，不与服务端重复：服务端出的是布尔，不拼中文。
 */
const PRIVILEGES: {
  key: keyof Pick<
    RoleDetail,
    "canUnarchive" | "canReadPlain" | "canManageUser" | "canManageConfig"
  >;
  label: string;
  hint: string;
}[] = [
  { key: "canUnarchive", label: "撤销归档", hint: "把已归档的案件/事项退回在办" },
  { key: "canReadPlain", label: "明文导出", hint: "导出未脱敏的证件号" },
  { key: "canManageUser", label: "管理账号", hint: "建号、授予角色、停用" },
  { key: "canManageConfig", label: "管理配置", hint: "改功能配置里的值" },
];

export function RolesView() {
  const [selectedCode, setSelectedCode] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["roles"],
    queryFn: () => api.get<{ roles: RoleDetail[] }>("/api/roles"),
    // 角色定义几乎不变；但会话过期仍要能重取，故不用 Infinity。
    staleTime: 5 * 60 * 1000,
  });

  if (q.isPending) {
    return <div className="card" style={{ minHeight: 320 }} />;
  }
  if (q.isError) {
    return <StateBlock tone="error" title="角色读不到" hint="会话可能已过期，重新登录后再看。" />;
  }

  const roles = q.data.roles;
  if (roles.length === 0) {
    return <StateBlock title="还没有角色配置" tone="empty" />;
  }

  // 选中项走 code（服务端已按 id 升序；默认选第一个）。
  // 找不到就回落到第一个——角色列表变化时不会停在空白右栏。
  const selected = roles.find((r) => r.code === selectedCode) ?? roles[0]!;

  return (
    <div className="master">
      <div className="card">
        <div className="card-h">
          <h2>角色</h2>
          <span style={{ flex: 1 }} />
          <Tag variant="filled" style={{ marginInlineEnd: 0 }}>
            只读
          </Tag>
          <span className="num" style={{ color: INK.muted, fontSize: 12 }}>
            {roles.length} 个
          </span>
        </div>
        <div className="card-b" style={{ padding: 10 }}>
          {roles.map((r) => (
            <button
              key={r.code}
              type="button"
              className={r.code === selected.code ? "pick on" : "pick"}
              aria-current={r.code === selected.code ? "true" : undefined}
              onClick={() => setSelectedCode(r.code)}
            >
              <span className="t">
                <b>{r.name}</b>
                <span className="num" style={{ color: INK.muted, fontSize: 12 }}>
                  {r.holderCount}
                </span>
              </span>
              <span className="s">{scopeLabel(r.dataScope)}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="pane">
          <div className="card">
            <div className="card-h">
              <h3>{selected.name}</h3>
              <span className="num" style={{ color: INK.muted, fontSize: 12 }}>
                {selected.code}
              </span>
              {selected.isSystem ? (
                <Tag variant="filled" style={{ marginInlineEnd: 0 }}>
                  系统内置
                </Tag>
              ) : null}
              <span style={{ flex: 1 }} />
              <span className="num" style={{ color: INK.muted, fontSize: 12 }}>
                {selected.holderCount} 人持有
              </span>
            </div>
            <div className="card-b">
              <Flex vertical gap={10}>
                <Flex gap={12} align="baseline">
                  <Typography.Text style={{ color: INK.muted, fontSize: 12, width: 60 }}>
                    看得见
                  </Typography.Text>
                  <span style={{ fontSize: 13 }}>
                    {scopeLabel(selected.dataScope)}
                    <Typography.Text
                      style={{ fontSize: 12, color: INK.muted, marginInlineStart: 6 }}
                    >
                      · {scopeFormula(selected.dataScope)}
                    </Typography.Text>
                  </span>
                </Flex>
                <Flex gap={12} align="baseline">
                  <Typography.Text style={{ color: INK.muted, fontSize: 12, width: 60 }}>
                    能做
                  </Typography.Text>
                  <Flex vertical gap={4} style={{ minWidth: 0 }}>
                    {PRIVILEGES.filter((p) => selected[p.key]).length === 0 ? (
                      <Typography.Text style={{ fontSize: 12, color: INK.muted }}>
                        该角色没有特权项
                      </Typography.Text>
                    ) : (
                      PRIVILEGES.filter((p) => selected[p.key]).map((p) => (
                        <Flex key={p.key} gap={8} align="baseline" wrap>
                          <Tag color="green" variant="filled" style={{ marginInlineEnd: 0 }}>
                            {p.label}
                          </Tag>
                          <Typography.Text style={{ fontSize: 12, color: INK.muted }}>
                            {p.hint}
                          </Typography.Text>
                        </Flex>
                      ))
                    )}
                  </Flex>
                </Flex>
              </Flex>
            </div>
          </div>

          <MemberCard role={selected} />
        </div>
      </div>
    </div>
  );
}

/**
 * 角色成员卡（pane 内的**末张卡**，靠 `globals.css` 的 `flex:1 1 auto` 吃余量）。
 *
 * 三种形态各说各的话，不合并：
 *   · `members === null` → 只给计数 + 说明为什么看不到名单（无 `canManageUser`）；
 *   · `members.length === 0` → 空态：还没有人持有 + 去用户管理授予；
 *   · 有成员 → 账号 / 姓名 两列（服务端成员摘要只给这三列，页面不画库里没有的列）。
 */
function MemberCard({ role }: { role: RoleDetail }) {
  const columns: TableColumnsType<RoleMember> = [
    {
      key: "username",
      title: "账号",
      dataIndex: "username",
      width: 200,
      render: (v: string) => (
        <span className="num" style={{ fontSize: 12 }}>
          {v}
        </span>
      ),
    },
    { key: "displayName", title: "姓名", dataIndex: "displayName" },
  ];

  return (
    <div className="card">
      <div className="card-h">
        <h3>成员</h3>
        <span style={{ flex: 1 }} />
        {/* 授予在用户管理页做；本页不给编辑按钮。无 canManageUser 者看不到名单，
            所以也不给这个会 403 的指路链接（不给必被拒的入口）。 */}
        {role.members !== null ? (
          <Link href="/users" style={{ fontSize: 12 }}>
            去用户管理授予
          </Link>
        ) : null}
      </div>
      <div className="card-b" style={{ padding: role.members && role.members.length ? 0 : 16 }}>
        {role.members === null ? (
          <Typography.Text style={{ fontSize: 12, color: INK.muted }}>
            共 {role.holderCount} 人持有。成员清单需要「管理账号」权限。
          </Typography.Text>
        ) : role.members.length === 0 ? (
          <Flex vertical gap={10} align="center" style={{ padding: "28px 16px" }}>
            <Typography.Text style={{ fontSize: 13, color: INK.muted }}>
              还没有人持有这个角色
            </Typography.Text>
            <Link href="/users" style={{ fontSize: 12 }}>
              去用户管理授予
            </Link>
          </Flex>
        ) : (
          <Table<RoleMember>
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={role.members}
            columns={columns}
          />
        )}
      </div>
    </div>
  );
}

/** 数据范围的中文只在 `DATA_SCOPE_LABELS` 一处——不在服务端拼、不在这里抄第二份。 */
function scopeLabel(scope: string): string {
  const hit = DATA_SCOPE_LABELS[scope as DataScope];
  return hit ? hit.zh : scope;
}

function scopeFormula(scope: string): string {
  const hit = DATA_SCOPE_LABELS[scope as DataScope];
  return hit ? hit.formula : scope;
}
