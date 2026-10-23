import { z } from "zod";

import { HOST_TYPES } from "@/shared/enums/targets";

/**
 * 附件的写入契约（§7.1）。
 *
 * 两个入口各一份 schema，因为它们收的东西根本不同：
 *
 * · **上传**收"这个文件是什么"（宿主、名字、大小、校验值）。元数据走查询串、
 *   字节走请求体 —— 上传是流式转发，不能先解析一遍 multipart 再把文件读进内存；
 * · **提交评论**只收**附件 id**（上传成功后服务端发的）。键与归属由服务端记死，
 *   客户端交回来的若是任意 `storage_key`，等于允许把别人的文件挂到自己的评论上。
 */

/** 评论能挂的附件 id 列表；空数组与不传同义（前端在没附件时干脆不带这个键） */
export const commentAttachmentIdsSchema = z
  .array(z.string().regex(/^\d+$/, "附件 id 只能是数字字符串"))
  .max(10, "一条评论最多挂 10 个附件")
  .optional();

/**
 * 上传的元数据（查询串）。
 *
 * 为什么不用 JSON body：请求体已经是文件字节了（流式转发，见
 * `services/attachments.ts` 的 `receiveCommentUpload`）。再包一层 multipart
 * 就得先把整个请求解析进内存，那正是 §7.1 要避开的做法。
 */
export const attachmentUploadQuerySchema = z.object({
  host: z.enum(HOST_TYPES),
  hostId: z.string().regex(/^\d+$/, "宿主 id 只能是数字字符串"),
  /** 原始文件名（服务端只取最后一段）。长度对齐 `mn_attachment.file_name varchar(255)` */
  fileName: z.string().trim().min(1, "缺少文件名").max(255),
  /** 单文件 ≤50MB 由服务层判（§7.1）；这里只挡掉明显非法的值 */
  sizeBytes: z.coerce.number().int().positive("空文件不能作为附件"),
  /** 浏览器算好的 SHA-256（小写十六进制）——服务端边转发边重算，不一致就拒收 */
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/, "缺少文件校验值，请重新选择该文件"),
});

export type AttachmentUploadQuery = z.infer<typeof attachmentUploadQuerySchema>;
