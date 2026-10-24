"use client";

import { useMemo, useState } from "react";
import { App as AntdApp, Button, Input, Space } from "antd";
import { useMutation } from "@tanstack/react-query";

import { api, ApiFailure, type RailComment } from "@/app/lib/client/api";
import { calDate, fromNow } from "@/app/lib/client/format";
import { CommentBody } from "@/app/components/comment-body";
import { MentionInput } from "@/app/components/mention-input";
import { StateBlock } from "@/app/components/ui/state-block";
import { hostBase } from "@/shared/hosts";
import {
  AttachmentChips,
  AttachmentPicker,
  CommentAttachmentList,
  useCommentAttachments,
} from "@/app/components/attachment-input";

/**
 * 右栏「评论」——案件与事项**同一件**（2026-10-23 用户批注「与案件中的一致」）。
 *
 * 先前两侧各写一份：案件走 canon 的 `.chat` 三块（头 / 可滚消息区 / 钉底输入区），
 * 事项走 antd Listy + 自绘 flex，连空态文案都分叉成「还没有处置记录」。
 * 两份实现分叉时不会报错，只会让同一件事在两个页面长出两种读法。
 *
 * ## 三层结构
 *
 * `.chat` 是 flex 列：头与输入区不伸缩、`.chat-b` 吃余量并 `overflow:auto`。
 * `min-height:0` 是滚动的真正前提（少了它整栏会被消息撑高，钉底当场失效）。
 *
 * ## 编辑
 *
 * 只有事项侧的 PATCH 存在（案件评论接口只有 POST）。所以 `editable` 由调用方给，
 * 案件不传、按钮不出现；这不是视觉差异，是能力差异。
 */
export type { RailComment };

type Host = "matter" | "risk_matter";

export function CommentRail({
  host,
  hostId,
  comments,
  onDone,
  readOnly = false,
  editable = false,
}: {
  host: Host;
  hostId: string;
  comments: RailComment[];
  onDone: () => void;
  /** 归档宿主：只读，不出现输入区与编辑 */
  readOnly?: boolean;
  /** 事项侧有 PATCH；案件没有，默认关 */
  editable?: boolean;
}) {
  const { message } = AntdApp.useApp();
  const base = hostBase(host);
  const [body, setBody] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  /** 附件：选完立刻传，发布时只带已经传完的 id（见 `attachment-input.tsx`） */
  const att = useCommentAttachments(host, hostId);

  const post = useMutation({
    mutationFn: () =>
      api.post(`/api/${base}/${hostId}/comments`, {
        body: body.trim(),
        attachments: att.readyIds,
      }),
    onSuccess: () => {
      setBody("");
      att.reset();
      onDone();
      message.success("评论已发布");
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "提交失败"),
  });

  const edit = useMutation({
    mutationFn: (vars: { id: string; text: string }) =>
      api.patch(`/api/${base}/${hostId}/comments?commentId=${vars.id}`, { body: vars.text }),
    onSuccess: () => {
      setEditing(null);
      onDone();
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "编辑失败"),
  });

  const threads = useCommentThreads(comments);

  return (
    <>
      <div className="chat-h">
        <h3>评论</h3>
        <span className="sp" />
        {/* 条数用 `.num` 等宽字形：新评论进来时数字变化不推动栏宽 */}
        <span className="num">{comments.length} 条</span>
      </div>

      <div className="chat-b">
        {threads.length ? (
          threads.map((g) => (
            <div key={g.day}>
              <div className="chat-day">{g.day}</div>
              {g.items.map((t) => (
                <div key={t.root.id}>
                  <CommentMessage
                    c={t.root}
                    canEdit={editable && !readOnly}
                    editing={editing === t.root.id}
                    editText={editText}
                    editingPending={edit.isPending}
                    onStartEdit={() => {
                      setEditing(t.root.id);
                      setEditText(t.root.body);
                    }}
                    onEditText={setEditText}
                    onSave={() => edit.mutate({ id: t.root.id, text: editText })}
                    onCancel={() => setEditing(null)}
                  />
                  {t.replies.map((r) => (
                    <div className="msg-reply" key={r.id}>
                      <CommentMessage
                        c={r}
                        canEdit={editable && !readOnly}
                        editing={editing === r.id}
                        editText={editText}
                        editingPending={edit.isPending}
                        onStartEdit={() => {
                          setEditing(r.id);
                          setEditText(r.body);
                        }}
                        onEditText={setEditText}
                        onSave={() => edit.mutate({ id: r.id, text: editText })}
                        onCancel={() => setEditing(null)}
                      />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))
        ) : (
          <StateBlock title="还没有评论" hint="在下方输入框写第一条。" />
        )}
      </div>

      {readOnly ? null : (
        <div className="chat-f">
          <AttachmentChips items={att.items} onRemove={att.remove} />
          <MentionInput
            host={host}
            hostId={hostId}
            rows={3}
            maxLength={2000}
            value={body}
            onChange={setBody}
            // Ctrl + Enter 发布：写评论的手停在键盘上时，不该为了提交去摸鼠标
            onPressEnter={(e) => {
              if ((e.ctrlKey || e.metaKey) && body.trim() && !post.isPending && !att.busy) {
                e.preventDefault();
                post.mutate();
              }
            }}
            placeholder="记录一个结论、一次沟通，或一个待确认的点；用 @姓名 提及同事"
          />
          <div className="bar">
            <AttachmentPicker onFiles={att.add} disabled={post.isPending} />
            <span className="hint">Ctrl + Enter 发布</span>
            <span className="sp" />
            <span className="hint num">
              {body.length} / <span className="num">2000</span>
            </span>
            <Button
              type="primary"
              size="small"
              disabled={!body.trim() || post.isPending || att.busy}
              onClick={() => post.mutate()}
            >
              发布
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

/** 一条消息：首字头像 + 「作者 · 时间」+ 正文。提及的分段由 `CommentBody` 负责。 */
function CommentMessage({
  c,
  canEdit,
  editing,
  editText,
  editingPending,
  onStartEdit,
  onEditText,
  onSave,
  onCancel,
}: {
  c: RailComment;
  canEdit: boolean;
  editing: boolean;
  editText: string;
  editingPending: boolean;
  onStartEdit: () => void;
  onEditText: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="msg">
      <span className="av" aria-hidden="true">
        {c.author.slice(0, 1)}
      </span>
      <div className="bd">
        <div className="meta">
          <b>{c.author}</b>
          <span className="t">{fromNow(c.createdAt)}</span>
          {c.isEdited ? <span className="t">（已编辑）</span> : null}
        </div>
        {editing ? (
          <Space orientation="vertical" size={6} style={{ width: "100%" }}>
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 6 }}
              value={editText}
              onChange={(e) => onEditText(e.target.value)}
            />
            <Space size={6}>
              <Button
                size="small"
                type="primary"
                loading={editingPending}
                disabled={!editText.trim()}
                onClick={onSave}
              >
                保存
              </Button>
              <Button size="small" onClick={onCancel}>
                取消
              </Button>
            </Space>
          </Space>
        ) : (
          <>
            <div className="txt">
              <CommentBody body={c.body} parts={c.parts} />
            </div>
            <CommentAttachmentList items={c.attachments} />
            {canEdit ? (
              <Button size="small" type="link" onClick={onStartEdit}>
                编辑
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 评论 → **按天分组的"根 + 回复"**（原型 `.chat-day` + `.msg-reply`）。
 *
 * 三条口径：
 *   · 正序（旧→新）：消息流的读法，与"最新在上"的列表相反——这一栏是**读上下文**的地方；
 *   · 只一层：回复挂在根下，回复的回复也并到同一个根（服务端只允许一层，界面不写无限递归）；
 *   · 父评论不在载荷里（被删）的孤儿**当根画**：让评论原地消失比画错层级更糟。
 */
function useCommentThreads(comments: RailComment[]) {
  return useMemo(() => {
    const sorted = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const byId = new Map(sorted.map((c) => [c.id, c]));
    const roots = new Map<string, { root: RailComment; replies: RailComment[] }>();
    for (const c of sorted) {
      // 往上走到真正的根（最多两层，循环只为兜住脏数据，不构成无限递归）
      let parentId = c.parentId;
      while (parentId && byId.get(parentId)?.parentId) parentId = byId.get(parentId)!.parentId;
      const anchor = parentId && byId.has(parentId) ? parentId : c.id;
      const slot = roots.get(anchor) ?? {
        root: byId.get(anchor) ?? c,
        replies: [] as RailComment[],
      };
      if (c.id !== anchor) slot.replies.push(c);
      roots.set(anchor, slot);
    }
    const groups: { day: string; items: { root: RailComment; replies: RailComment[] }[] }[] = [];
    for (const t of roots.values()) {
      const day = calDate(t.root.createdAt);
      const last = groups[groups.length - 1];
      if (last && last.day === day) last.items.push(t);
      else groups.push({ day, items: [t] });
    }
    return groups;
  }, [comments]);
}
