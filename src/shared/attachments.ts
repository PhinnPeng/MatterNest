/**
 * 附件的**规则**（§7.1）——服务端与浏览器共用的唯一一份。
 *
 * 为什么规则不能各写一份：白名单与大小上限若前后端各有一条，失败形态是
 * 「前端放行、服务端 400」（用户要重选一遍才知道哪里错了），或者更糟——
 * 「前端拦住、服务端其实允许」（一个本来能传的合同被挡在门外，没人会去查规则）。
 * 这里只放**纯判定**，不碰 IO：服务端拿它做权威校验，浏览器拿它做即时预检。
 */

/** §7.1：单文件 ≤50MB */
export const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
/** §7.1：单宿主 ≤100 个（只数已挂到评论的，草稿不占名额） */
export const ATTACHMENT_MAX_PER_HOST = 100;
/** 一条评论最多挂 10 个：再多就不是"随手附一份材料"，而是把评论当文件柜 */
export const ATTACHMENT_MAX_PER_COMMENT = 10;

/**
 * §7.1 的上传白名单。**按扩展名判、由服务端给出 Content-Type**：
 * `File.type` 可以随便写，信它就等于让 `.html` 以 `image/png` 落库。
 */
export const ATTACHMENT_MIME_BY_EXT: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  zip: "application/zip",
};

/** 白名单的可读说法（错误文案只写一遍，前后端都不许各抄一份） */
export const ATTACHMENT_ACCEPT_TEXT = "PDF、Word、Excel、图片（png/jpg）与 zip";

/** 扩展名（小写、不带点）；没有扩展名返回空串 */
export function extensionOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** 白名单命中 → 服务端认定的 MIME；不在名单 → null（调用方给 400，文案说清是哪一条） */
export function mimeForFileName(fileName: string): string | null {
  return ATTACHMENT_MIME_BY_EXT[extensionOf(fileName)] ?? null;
}

/** `input accept` 属性：与白名单同源，改白名单不必再改一处 HTML */
export const ATTACHMENT_ACCEPT_ATTR = Object.keys(ATTACHMENT_MIME_BY_EXT)
  .map((ext) => `.${ext}`)
  .join(",");
