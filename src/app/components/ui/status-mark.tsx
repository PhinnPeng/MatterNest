"use client";

import { INK } from "@/app/theme/brand";
import { Badge, Space, Tag } from "antd";

import { useMeta, type HostKind } from "@/app/lib/client/api";
import { SEMANTIC_TONE } from "@/app/theme/antd";

/**
 * 状态标记：**点 + 词**，不给整块底色。
 *
 * 名称与语义都从 `/api/meta` 的状态配置表来——状态是配置驱动（枚举表 §0），
 * 运营改了某个 code 的中文名，这里跟着变，前端不抄第二份中文。
 * 词必须留：色觉障碍与灰阶打印都会让"绿点=结案"失效，而状态是要被引用和被扫读的东西。
 */
export function StatusMark({ host, code }: { host: HostKind; code: string | null | undefined }) {
  const { data } = useMeta(host);
  const hit = data?.statuses.find((s) => s.code === code);
  if (!code) return <span style={{ color: INK.faint }}>—</span>;
  // 索引访问在 noUncheckedIndexedAccess 下可能是 undefined，所以给一个**显式兜底对象**
  // （而不是 `!`）：语义值来自配置表，理论上五个之内，但真出现历史脏值时界面不该崩。
  const FALLBACK = { color: "default", badge: "default" } as const;
  const tone = SEMANTIC_TONE[hit?.semantics ?? "custom"] ?? SEMANTIC_TONE.custom ?? FALLBACK;

  return (
    <Badge
      status={tone.badge as "default" | "processing" | "success" | "error" | "warning"}
      text={hit?.name ?? code}
    />
  );
}

/**
 * 与状态正交的第二个事实（归档、已转案件）用描边 Tag，不用第二个点：
 * 修订稿 §3.4 明写"已转案件不占状态位"，视觉上也不该跟状态抢同一个位置。
 */
export function FlagMark({
  children,
  tone = "neutral",
  title,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "info" | "warn" | "danger";
  title?: string;
}) {
  const color =
    tone === "info" ? "blue" : tone === "warn" ? "orange" : tone === "danger" ? "red" : undefined;
  return (
    <Tag
      color={color}
      title={title}
      style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: "18px" }}
    >
      {children}
    </Tag>
  );
}

/** 键值行（详情页顶部与 Descriptions 之外的紧凑场合） */
export function MetaLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Space size={6} align="baseline">
      <span style={{ color: INK.muted, fontSize: 12 }}>{label}</span>
      <span style={{ fontSize: 13 }}>{children}</span>
    </Space>
  );
}
