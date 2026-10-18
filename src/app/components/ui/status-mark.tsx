"use client";

import { useMeta, type HostKind } from "@/app/lib/client/api";

/**
 * 状态标记：**点 + 词**（canon `.pill`），不给整块底色。
 *
 * 名称与语义都从 `/api/meta` 的状态配置表来——状态是配置驱动（枚举表 §0），
 * 运营改了某个 code 的中文名，这里跟着变，前端不抄第二份中文。
 * 词必须留：色觉障碍与灰阶打印都会让"绿点=结案"失效，而状态是要被引用和被扫读的东西。
 *
 * ## 2026-10-18（MATT-99）：换 canon
 *
 * 从 antd `Badge` 换成 canon `.pill`（6px 圆点 + 词，"永远点与词同时出现"）。
 * 四档只有三个语义色 + 中性：状态**不是**期限，不该借 `over`/`due` 的红黄——
 * 那是"逾期/临期"专用的两个词（颜色不作唯一通道、一个颜色一个含义）。
 * 所以只有终态（`closed`）用 `.pill ok`，其余一律中性 `.pill gray`；
 * 状态之间的区分由**词**承担，这正是 canon 对语义色的用法。
 */
export function StatusMark({ host, code }: { host: HostKind; code: string | null | undefined }) {
  const { data } = useMeta(host);
  if (!code) return <span className="ph">—</span>;
  const hit = data?.statuses.find((s) => s.code === code);
  // 语义值来自配置表，理论上五个之内，但真出现历史脏值时界面不该崩，所以给了兜底
  const semantics = hit?.semantics ?? "custom";
  const cls = semantics === "closed" ? "pill ok" : "pill gray";

  return (
    <span className={cls}>
      <i />
      {hit?.name ?? code}
    </span>
  );
}

/**
 * 与状态正交的第二个事实（归档、已转案件）用描边 `.tag`，不用第二个点：
 * 修订稿 §3.4 明写"已转案件不占状态位"，视觉上也不该跟状态抢同一个位置。
 * `tone` 映射到 canon 的 `.tag.blue/.amber/.red`（默认描边中性 tag）。
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
  const cls =
    tone === "info"
      ? "tag blue"
      : tone === "warn"
        ? "tag amber"
        : tone === "danger"
          ? "tag red"
          : "tag";
  return (
    <span className={cls} title={title}>
      {children}
    </span>
  );
}

/** 键值行（详情页顶部、字段表之外的紧凑场合）。 */
export function MetaLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="rowflex" style={{ gap: 6, alignItems: "baseline" }}>
      <span className="mut3" style={{ fontSize: 12 }}>
        {label}
      </span>
      <span style={{ fontSize: 13 }}>{children}</span>
    </span>
  );
}
