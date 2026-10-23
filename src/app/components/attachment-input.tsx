"use client";

import { useRef, useState } from "react";
import { App as AntdApp, Button, Tooltip } from "antd";
import { CloseOutlined, PaperClipOutlined } from "@ant-design/icons";

import { api, ApiFailure, type CommentAttachment } from "@/app/lib/client/api";
import {
  fileProblem,
  formatBytes,
  openAttachment,
  uploadAttachment,
} from "@/app/lib/client/attachments";
import {
  ATTACHMENT_ACCEPT_ATTR,
  ATTACHMENT_ACCEPT_TEXT,
  ATTACHMENT_MAX_PER_COMMENT,
} from "@/shared/attachments";

/**
 * 评论附件（§7.1）：编辑期的选择/上传，与读评论时的下载。
 *
 * ## 为什么点选即上传，而不是"发布时才一起传"
 *
 * 评论提交是一个短事务（正文 + 提及 + 附件行）。把 50MB 的字节放进那个事务里，
 * 发布按钮会长时间转圈，失败还要用户重新选文件。这里的选择是：
 * **选完立刻传，拿到附件 id；发布时只提交 id**。于是"传得慢"和"发得掉"分开，
 * 发布失败也不会把已传好的文件作废（草稿行仍在，重试发布即可）。
 *
 * ## 草稿行对读侧不可见
 *
 * 上传完成的行 `comment_id` 仍是 NULL，列表只查"已挂到评论"的行 ——
 * 所以选了文件又放弃评论，不会在别处留下半个附件。
 */

/** 一个正在上传/已上传的附件（编辑期）。`key` 只在本地用，`id` 是服务端在传完后给的 */
export type PendingAttachment = {
  key: string;
  fileName: string;
  sizeBytes: number;
  progress: number;
  status: "uploading" | "done" | "failed";
  id?: string;
  error?: string;
};

let localSeq = 0;
const nextKey = () => `att-${++localSeq}`;

/** 上传状态机：与渲染分开，评论栏只拿 `items / add / remove / reset / readyIds` */
export function useCommentAttachments(host: "matter" | "risk_matter", hostId: string) {
  const { message } = AntdApp.useApp();
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const aborters = useRef(new Map<string, AbortController>());

  const patch = (key: string, next: Partial<PendingAttachment>) =>
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...next } : it)));

  const add = (files: File[]) => {
    if (files.length === 0) return;
    const room = Math.max(0, ATTACHMENT_MAX_PER_COMMENT - items.length);
    const accepted: { key: string; file: File }[] = [];
    for (const file of files.slice(0, room)) {
      const problem = fileProblem(file);
      if (problem) {
        // 一次只提示第一条：十个坏文件刷十条 toast 只会盖住输入框
        message.warning(`${file.name}：${problem}`);
        continue;
      }
      accepted.push({ key: nextKey(), file });
    }
    if (files.length > room) {
      message.warning(`一条评论最多 ${ATTACHMENT_MAX_PER_COMMENT} 个附件`);
    }
    if (accepted.length === 0) return;

    setItems((prev) => [
      ...prev,
      ...accepted.map(({ key, file }) => ({
        key,
        fileName: file.name,
        sizeBytes: file.size,
        progress: 0,
        status: "uploading" as const,
      })),
    ]);

    for (const { key, file } of accepted) {
      const aborter = new AbortController();
      aborters.current.set(key, aborter);
      void uploadAttachment({
        host,
        hostId,
        file,
        signal: aborter.signal,
        onProgress: (progress) => patch(key, { progress }),
      })
        .then((up) => {
          aborters.current.delete(key);
          patch(key, { status: "done", progress: 100, id: up.id });
        })
        .catch((e) => {
          aborters.current.delete(key);
          if (e instanceof DOMException && e.name === "AbortError") return;
          patch(key, {
            status: "failed",
            error: e instanceof ApiFailure ? e.message : "上传失败，请重试",
          });
        });
    }
  };

  const remove = (key: string) => {
    aborters.current.get(key)?.abort();
    aborters.current.delete(key);
    setItems((prev) => prev.filter((it) => it.key !== key));
  };

  /** 发布成功后清空；未完成的上传一并取消（草稿行不可见，对象留给维护任务） */
  const reset = () => {
    for (const a of aborters.current.values()) a.abort();
    aborters.current.clear();
    setItems([]);
  };

  return {
    items,
    add,
    remove,
    reset,
    /** 发布时只带成功的那些；失败/上传中的不能发（按钮会被 `busy` 挡住） */
    readyIds: items.flatMap((it) => (it.status === "done" && it.id ? [it.id] : [])),
    busy: items.some((it) => it.status === "uploading"),
    failed: items.filter((it) => it.status === "failed"),
  };
}

/** 回形针按钮 + 隐藏的 file input（`accept` 与白名单同源） */
export function AttachmentPicker({
  onFiles,
  disabled,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <Tooltip title={`添加附件（单文件 ≤50MB；${ATTACHMENT_ACCEPT_TEXT}）`}>
        <Button
          type="text"
          size="small"
          aria-label="添加附件"
          icon={<PaperClipOutlined />}
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        />
      </Tooltip>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        accept={ATTACHMENT_ACCEPT_ATTR}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          // 清空 value：同一个文件删掉后再选，`change` 才会再触发
          e.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}

/** 编辑期的附件清单：名字 + 进度/大小/失败原因，右侧可直接移除 */
export function AttachmentChips({
  items,
  onRemove,
}: {
  items: PendingAttachment[];
  onRemove: (key: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
      {items.map((it) => (
        <span
          key={it.key}
          className="attachment-chip"
          title={it.status === "failed" ? (it.error ?? it.fileName) : it.fileName}
        >
          <PaperClipOutlined style={{ fontSize: 11, color: "var(--ink3)" }} />
          <span className="name">{it.fileName}</span>
          <span
            className="meta num"
            style={{ color: it.status === "failed" ? "var(--red)" : "var(--ink3)" }}
          >
            {it.status === "uploading"
              ? `${it.progress}%`
              : it.status === "failed"
                ? "上传失败"
                : formatBytes(it.sizeBytes)}
          </span>
          <button
            type="button"
            aria-label={`移除 ${it.fileName}`}
            className="x"
            onClick={() => onRemove(it.key)}
          >
            <CloseOutlined style={{ fontSize: 10 }} />
          </button>
        </span>
      ))}
    </div>
  );
}

/**
 * 读评论时的附件：点一下换 60 秒签名再交给浏览器下载。
 *
 * 不在列表里直接写对象 URL：桶是私有的，URL 必须**按宿主可见性现签**（§7.1）。
 */
export function CommentAttachmentList({ items }: { items: CommentAttachment[] }) {
  const { message } = AntdApp.useApp();
  if (items.length === 0) return null;

  const download = async (a: CommentAttachment) => {
    try {
      const { url } = await api.get<{ url: string }>(`/api/attachments/${a.id}/url`);
      openAttachment(url);
    } catch (e) {
      message.error(e instanceof ApiFailure ? e.message : "附件打不开，请重试");
    }
  };

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
      {items.map((a) => (
        <button
          key={a.id}
          type="button"
          className="attachment-chip"
          title={`下载 ${a.fileName}`}
          onClick={() => void download(a)}
        >
          <PaperClipOutlined style={{ fontSize: 11, color: "var(--ink3)" }} />
          <span className="name">{a.fileName}</span>
          <span className="meta num">{formatBytes(a.sizeBytes)}</span>
        </button>
      ))}
    </div>
  );
}
