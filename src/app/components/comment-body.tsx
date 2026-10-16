"use client";

import { Tooltip } from "antd";

import { alpha, BRAND, INK } from "@/app/theme/brand";
import type { CommentPart } from "@/shared/notification/comment-body";

/**
 * 评论正文（含 @提及）的渲染件 —— 案件详情的「过程记录」与事项详情的「评论」两处共用。
 *
 * ## 为什么是一个共用组件，而不是各画一遍
 *
 * 两处此前都是"把 `c.body` 原样铺出来"。给其中一处加高亮就等于声明**第二套正文渲染口径**，
 * 而正文在两边是同一种东西（同一张 `mn_comment`、同一套 `mention_ids`）。
 * 本仓在导出（`services/exports.ts`）与图标（`components/icons`）上已经栽过同一种跟头：
 * 两份实现各自 200，只在"某一处改动没同步"时静默分叉。
 *
 * ## 前端只做一件事：把服务端给的分段画出来
 *
 * `parts` 由服务端算好（`services/comment-mentions.ts`）。这里**不碰文本** ——
 * 不做 `@` 匹配、不做名字解析：那件事的权威是 `mention_ids`（= 当时真的发了通知的那批人），
 * 在浏览器里重算会在"编辑过的正文"和"改过名字的同事"上画出与通知不一致的高亮。
 *
 * `data-mention` / `data-mention-state` 不是给样式用的：真浏览器探针
 * （`agent-work/probe-mention-render.mjs`）靠它们区分"这段是提及"与"正文里恰好写了 `@张三`"，
 * 而后者（正文里手打的 `@名字`、但 `mention_ids` 里没有）**必须长得与普通文本一样**。
 */
export function CommentBody({ body, parts }: { body: string; parts?: CommentPart[] }) {
  // 没有分段（老接口、或服务端判定"整条都是纯文本"）时按纯文本画，不因此少显示一个字
  const segments: CommentPart[] =
    parts && parts.length > 0 ? parts : [{ kind: "text", text: body }];
  return (
    <>
      {segments.map((part, i) =>
        part.kind === "text" ? (
          <span key={i}>{part.text}</span>
        ) : (
          <MentionTag key={i} name={part.name} ids={part.ids} status={part.status} />
        ),
      )}
    </>
  );
}

/**
 * 一处提及。停用的人**照样高亮**，只是降级配色 + 一句说明（口径见
 * `shared/notification/comment-body.ts` 的文件头：抹成纯文本会让读者以为那个 `@` 是随手打的）。
 */
function MentionTag({
  name,
  ids,
  status,
}: {
  name: string;
  ids: string[];
  status: "active" | "inactive";
}) {
  const inactive = status === "inactive";
  const color = inactive ? INK.muted : BRAND.primary;
  const chip = (
    <span
      data-mention={ids.join(",")}
      data-mention-state={status}
      style={{
        background: alpha(color, 0.1),
        color,
        borderRadius: 4,
        padding: "0 4px",
      }}
    >
      @{name}
    </span>
  );
  if (!inactive) return chip;
  return <Tooltip title="该同事已停用">{chip}</Tooltip>;
}
