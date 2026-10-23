"use client";

import { ApiFailure } from "./api";
import type { AttachmentScope } from "@/shared/enums/business";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_ACCEPT_TEXT,
  mimeForFileName,
} from "@/shared/attachments";

/**
 * 浏览器侧的附件上传（§7.1）。
 *
 * ## 为什么是 XHR 而不是 fetch
 *
 * 上传要有进度条，而 `fetch` 至今没有上传进度事件。XHR 的 `upload.onprogress`
 * 是唯一稳定的做法。这里只用它做这一件事：字节仍由浏览器原样发给服务端，
 * 服务端再流式转给对象存储（理由见 `services/attachments.ts`）。
 *
 * ## 为什么先算 SHA-256
 *
 * 服务端边转发边重算哈希，不一致就拒收 —— 半截上传、代理截断、前端选错文件
 * 都会当场暴露，而不是等到某天有人点开附件发现打不开。50MB 的一次 `arrayBuffer`
 * 与哈希在桌面端是几百毫秒量级，值得。
 */

export type UploadedAttachment = {
  id: string;
  fileName: string;
  displayName?: string;
  mimeType: string;
  sizeBytes: number;
  scope?: AttachmentScope;
};

/** 选文件时的**即时**预检；返回 null = 可以传。规则与服务端同一份（`shared/attachments.ts`） */
export function fileProblem(file: File): string | null {
  if (file.size <= 0) return "空文件不能作为附件";
  if (file.size > ATTACHMENT_MAX_BYTES) return "单个附件不能超过 50MB";
  if (!mimeForFileName(file.name)) return `不支持这种文件类型。可上传 ${ATTACHMENT_ACCEPT_TEXT}`;
  return null;
}

export async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 上传一个文件。`signal` 用来在用户移除芯片时取消 —— 不取消的话，
 * 一个已经没人认领的对象会留在桶里（草稿行不可见，但对象是真实字节）。
 */
export async function uploadAttachment(args: {
  host: "matter" | "risk_matter";
  hostId: string;
  file: File;
  /** 宿主级材料（2026-10-23）：scope=host 时上传即归属，名称与描述随元数据一起落库 */
  scope?: AttachmentScope;
  name?: string;
  description?: string;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}): Promise<UploadedAttachment> {
  const { host, hostId, file, scope, name, description, signal, onProgress } = args;
  onProgress?.(0);
  const checksumSha256 = await sha256Hex(file);
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");

  const params = new URLSearchParams({
    host,
    hostId,
    fileName: file.name,
    sizeBytes: String(file.size),
    checksumSha256,
  });
  if (scope) params.set("scope", scope);
  if (name) params.set("name", name);
  if (description) params.set("description", description);

  return new Promise<UploadedAttachment>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/attachments/upload?${params.toString()}`);
    // 服务端的类型由扩展名决定，这一条只是让请求体是"原始字节"
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status === 201) {
        resolve(JSON.parse(xhr.responseText) as UploadedAttachment);
        return;
      }
      let message = "上传失败，请重试";
      try {
        const payload = JSON.parse(xhr.responseText) as { message?: string };
        if (payload.message) message = payload.message;
      } catch {
        /* 非 JSON（网关错误页）就用兜底文案 */
      }
      if (xhr.status === 401 && window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
      reject(new ApiFailure(xhr.status, { error: "upload_failed", message }));
    };
    xhr.onerror = () =>
      reject(new ApiFailure(0, { error: "network", message: "网络中断，上传未完成" }));
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/** 下载：先换 60 秒签名，再交给浏览器。`attachment` 的响应头由签名固定，不会在页内渲染 */
export async function openAttachment(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

/** 展示用大小。附件栏很窄，超过 1 位小数没有信息量 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
