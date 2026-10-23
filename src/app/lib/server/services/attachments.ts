import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";

import type { Actor } from "../auth/auth";
import { getDb } from "../db/client";
import { attachment, comment } from "../db/schema";
import { HOSTS, scopedWhere } from "../scope/visibility";
import { logActivity } from "./activity";
import { nextId } from "@/shared/ids/snowflake";
import {
  StorageUnavailableError,
  deleteObject,
  loadStorageConfig,
  presignUrl,
  probeObject,
  type StorageConfig,
} from "../storage/s3";
import type { HostType } from "@/shared/enums/targets";
import type { AttachmentScope } from "@/shared/enums/business";
import type { AttachmentListState } from "@/shared/schema/attachments";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_COMMENT,
  ATTACHMENT_MAX_PER_HOST,
  ATTACHMENT_MIME_BY_EXT,
  ATTACHMENT_ACCEPT_TEXT,
  mimeForFileName,
} from "@/shared/attachments";

type Db = Awaited<ReturnType<typeof getDb>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * 附件（§7.1）。服务端只做三件事：**签 URL、登记元数据、判可见性**，不中转字节。
 *
 * ## 为什么上传分成"预签名 → 落草稿行 → 评论提交时挂上"
 *
 * 预签名 PUT 是浏览器直传对象存储，服务端在写入那一刻看不到文件。于是"这条附件是谁传的、
 * 属于谁"只剩两条路：
 *
 *   · 让客户端把 `storage_key` 交回来 —— 但键是随机的，服务端无法证明它真是这个客户端传的，
 *     拿到别人键的人可以把别人的文件挂到自己的评论上；
 *   · **预签名时就落一行草稿**（`comment_id` 为 NULL），键由服务端发、归属由行记死。
 *     评论提交时只收附件 id，服务端再核：是我的草稿、属于这个宿主、对象真的在、大小对得上。
 *
 * 后者是这里的做法。草稿行对读侧不可见（列表只查已挂到评论的行），所以"传了但没发评论"
 * 不会在界面上留下半个附件；它也不会占住"单宿主 ≤100"的名额（那条只数已挂载的行）。
 *
 * ## 归档宿主
 *
 * §7.1：「宿主转 `archived` 后附件只读、不可删」。所以新增（预签名）与删除都先看
 * 宿主的 `is_archived`；下载不受限（归档记录仍要能查证）。
 */

/** §7.1：单文件 ≤50MB */
export const MAX_BYTES = ATTACHMENT_MAX_BYTES;
/** §7.1：单宿主 ≤100 个（只数**已挂到评论**的，草稿不占名额） */
export const MAX_PER_HOST = ATTACHMENT_MAX_PER_HOST;
/** 一条评论最多挂 10 个 */
export const MAX_PER_COMMENT = ATTACHMENT_MAX_PER_COMMENT;
/** PUT 签名有效期：慢网传 50MB 也要留够 */
const PUT_SECONDS = 15 * 60;

/**
 * §7.1 的上传白名单 —— 规则本体在 `shared/attachments.ts`（前后端共用一份）。
 * 这里保留 `MIME_BY_EXT` 这个名字只为让调用点的意图读起来仍是"查表"。
 */
export const MIME_BY_EXT = ATTACHMENT_MIME_BY_EXT;

/** 展示用的大小（前端也有一份格式化？**不**：这里只给字节，格式化属于界面） */
export type AttachmentDto = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
  uploadedBy: string;
};

function storage(): StorageConfig {
  const config = loadStorageConfig();
  if (!config) {
    throw new StorageUnavailableError(
      "附件功能尚未开通（对象存储凭据未配置）。请联系管理员配置 MINIO_ACCESS_KEY / MINIO_SECRET_KEY。",
    );
  }
  return config;
}

/** 附件功能此刻是否可用（路由用它给界面一个明确的 503，而不是 500） */
export function attachmentStorageReady(): boolean {
  return loadStorageConfig() !== null;
}

/**
 * 宿主可见性 + 归档态。不可见与不存在同样对待（元规则 3：不给"存在但你没权"）。
 */
async function loadHost(
  db: Db,
  actor: Actor,
  host: HostType,
  hostId: string,
): Promise<{ isArchived: boolean } | null> {
  const h = HOSTS[host];
  const [row] = await db
    .select({ id: h.hostId, isArchived: h.table.isArchived })
    .from(h.table)
    .where(scopedWhere(host, actor, eq(h.hostId, BigInt(hostId))))
    .limit(1);
  return row ?? null;
}

/**
 * 单宿主 ≤100 的口径：已挂到评论上的附件 + 宿主级材料。
 *
 * 草稿（`comment_id IS NULL` 且 `scope='comment'`）不占名额：它是"传了但没发评论"的中间态，
 * 不该把用户的配额吃掉。宿主级材料一上传就是正式附件，必须计入。
 */
async function attachedCount(db: Db, host: HostType, hostId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(attachment)
    .where(
      and(
        eq(attachment.ownerType, host),
        eq(attachment.ownerId, BigInt(hostId)),
        sql`(${attachment.commentId} is not null or ${attachment.scope} = 'host')`,
        sql`NOT ${attachment.isDeleted}`,
      ),
    );
  return row?.n ?? 0;
}

export type UploadInput = {
  host: HostType;
  hostId: string;
  fileName: string;
  sizeBytes: number;
  /** 浏览器算好的 SHA-256（小写十六进制）—— 服务端边转发边重算，不一致就拒收 */
  checksumSha256: string;
  /**
   * 用途（2026-10-23 / 迁移 0023）：默认 `comment`（评论附件，落草稿等评论提交）；
   * `host` 表示宿主级材料，上传即归属，不挂评论。
   */
  scope?: AttachmentScope;
  /** 宿主级材料的名称；`scope=comment` 时忽略 */
  displayName?: string;
  /** 宿主级材料的描述；`scope=comment` 时忽略 */
  description?: string;
};

export type UploadResult = {
  id: string;
  fileName: string;
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  scope: AttachmentScope;
};

/**
 * 接收一次附件上传：校验 → 落草稿行 → **把请求体流式转发给 MinIO** → 复核大小与校验值。
 *
 * ## 为什么字节经过应用服务器（而不是浏览器直传）
 *
 * §7.1 的原始选择是浏览器拿预签名 URL 直传，理由是"框架会把 multipart 整个缓冲进内存"。
 * 这条理由在 Next 的 Route Handler 上不成立（`req.body` 是流），但它另一条隐性前提
 * **在社区版 MinIO 上无法满足**：浏览器跨源直传需要桶级 CORS，而 MinIO 的
 * `PutBucketCors` 只在 AIStor（收费版）实现，社区版固定回 501。能用的开关是
 * `MINIO_API_CORS_ALLOW_ORIGIN`（服务级、要重启共享实例）。
 *
 * 所以这里走**应用内流式转发**：不缓冲（`TransformStream` 边读边转）、不落临时文件、
 * 不经过 Next 的 multipart 解析。代价是应用服务器多转发一遍字节；
 * 换来的是"今天就能用、不依赖运维改配置"。将来若桶级/服务级 CORS 到位，
 * 只需把这一段换成返回预签名 URL，校验与登记逻辑（哈希、大小、草稿行）不用动。
 *
 * ## 为什么要在这里算哈希
 *
 * 直传时服务端看不到字节，只能存客户端声明的值（§7.1 的"事后异步校验"）。
 * 既然字节无论如何经过这里，就顺手把 SHA-256 与大小**当场核掉**：
 * 半截上传或前端算错，都不会变成评论里一份打不开的文件。
 */
export async function receiveUpload(
  actor: Actor,
  input: UploadInput,
  stream: ReadableStream<Uint8Array>,
): Promise<UploadResult> {
  const config = storage();
  const db = await getDb();
  const host = await loadHost(db, actor, input.host, input.hostId);
  if (!host) throw new AttachmentRejected(404, "没有找到这条记录，或你没有访问它的权限");
  if (host.isArchived) throw new AttachmentRejected(409, "已归档的记录不再接收新附件");

  const scope = input.scope ?? "comment";
  // 路由层已经按 query 校验过；服务层再挡一次，避免"名称必填"只在某一层成立
  if (scope === "host" && !input.displayName?.trim()) {
    throw new AttachmentRejected(400, "附件名称不能为空");
  }
  if (input.sizeBytes <= 0) throw new AttachmentRejected(400, "空文件不能作为附件");
  if (input.sizeBytes > MAX_BYTES) {
    throw new AttachmentRejected(413, "单个附件不能超过 50MB");
  }
  const mimeType = mimeForFileName(input.fileName);
  if (!mimeType) {
    throw new AttachmentRejected(400, `不支持这种文件类型。可上传 ${ATTACHMENT_ACCEPT_TEXT}`);
  }
  if (!/^[0-9a-f]{64}$/.test(input.checksumSha256)) {
    throw new AttachmentRejected(400, "缺少文件校验值，请重新选择该文件");
  }
  if ((await attachedCount(db, input.host, input.hostId)) >= MAX_PER_HOST) {
    throw new AttachmentRejected(409, `这条记录的有效附件已满 ${MAX_PER_HOST} 个`);
  }

  const id = BigInt(nextId());
  const storageKey = `att/${randomUUID()}`;
  /** 文件名只留最后一段：浏览器给的是裸名，但服务端不假设这一点 */
  const fileName = (input.fileName.split(/[\\/]/).pop() ?? input.fileName).slice(0, 255);
  /** 名称在上面已判非空；这里仍保留 trim（接口可能被脚本调用） */
  const displayName = scope === "host" ? input.displayName!.trim() : null;
  const description = scope === "host" ? input.description?.trim() || null : null;

  // 先落草稿行：对象键必须先有账，上传中途失败才有东西可清
  await db.insert(attachment).values({
    id,
    ownerType: input.host,
    ownerId: BigInt(input.hostId),
    commentId: null,
    scope,
    displayName,
    description,
    fileName,
    storageKey,
    mimeType,
    sizeBytes: BigInt(input.sizeBytes),
    checksumSha256: input.checksumSha256,
    uploadedBy: BigInt(actor.userId),
  });

  const hash = createHash("sha256");
  let received = 0;
  let overLimit = false;
  // 边转发边算：超过上限立刻断开源流，不把 200MB 的"错误"传完再拒
  const body = stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > MAX_BYTES) {
          overLimit = true;
          controller.error(new Error("attachment_too_large"));
          return;
        }
        hash.update(chunk);
        controller.enqueue(chunk);
      },
    }),
  );

  try {
    const putUrl = presignUrl(config, {
      method: "PUT",
      key: storageKey,
      expiresIn: PUT_SECONDS,
      contentType: mimeType,
    });
    const res = await fetch(putUrl, {
      method: "PUT",
      headers: {
        "content-type": mimeType,
        // S3 的 PUT 必须有长度：流式请求体默认走 chunked，MinIO 会回 411
        "content-length": String(input.sizeBytes),
      },
      body,
      // 流式请求体的开关；Node 的 fetch 需要它，否则直接拒绝 ReadableStream
      duplex: "half",
    } as RequestInit);
    if (!res.ok) {
      throw new StorageUnavailableError(`对象存储写入失败（HTTP ${res.status}）`);
    }
    if (overLimit) {
      throw new AttachmentRejected(413, "单个附件不能超过 50MB");
    }
    if (received !== input.sizeBytes) {
      throw new AttachmentRejected(400, `「${fileName}」上传不完整，请重试`);
    }
    if (hash.digest("hex") !== input.checksumSha256) {
      throw new AttachmentRejected(400, `「${fileName}」校验值不一致，请重试`);
    }
  } catch (e) {
    // 失败的上传不该留下一份半截对象或一行孤儿草稿
    await discardObjectQuietly(config, storageKey);
    await db
      .update(attachment)
      .set({ isDeleted: true, deletedAt: new Date().toISOString() })
      .where(eq(attachment.id, id))
      .catch(() => undefined);
    if (overLimit && !(e instanceof AttachmentRejected)) {
      throw new AttachmentRejected(413, "单个附件不能超过 50MB");
    }
    throw e;
  }

  return {
    id: String(id),
    fileName,
    displayName: displayName ?? fileName,
    mimeType,
    sizeBytes: input.sizeBytes,
    scope,
  };
}

/** 补偿用的对象删除：失败只记一行日志，不覆盖真正的错误 */
async function discardObjectQuietly(config: StorageConfig, key: string) {
  try {
    await deleteObject(config, key);
  } catch {
    console.warn(`[attachment] 清理对象失败：${key}`);
  }
}

/** 业务拒绝：带状态码，路由层直接翻（不用 Error 消息做字符串匹配） */
export class AttachmentRejected extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413,
    message: string,
  ) {
    super(message);
    this.name = "AttachmentRejected";
  }
}

/**
 * 评论提交前**在事务外**核一遍草稿：归属、宿主、对象存在与大小。
 *
 * 为什么不在事务里做：`probeObject` 是网络 IO，一次最多 10 个，放进写事务等于
 * 持锁等 MinIO。核过的行在事务里只做 `comment_id` 的赋值，冲突由
 * `where comment_id is null` 保证（同一条草稿不会被两条评论抢走）。
 */
export async function verifyDraftAttachments(
  actor: Actor,
  host: HostType,
  hostId: string,
  ids: readonly string[],
): Promise<{ id: bigint; fileName: string; sizeBytes: number }[]> {
  if (ids.length === 0) return [];
  const config = storage();
  const db = await getDb();
  const rows = await db
    .select({
      id: attachment.id,
      fileName: attachment.fileName,
      storageKey: attachment.storageKey,
      sizeBytes: attachment.sizeBytes,
      uploadedBy: attachment.uploadedBy,
    })
    .from(attachment)
    .where(
      and(
        inArray(attachment.id, ids.map(BigInt)),
        eq(attachment.ownerType, host),
        eq(attachment.ownerId, BigInt(hostId)),
        eq(attachment.scope, "comment"),
        sql`${attachment.commentId} is null`,
        sql`NOT ${attachment.isDeleted}`,
      ),
    );

  if (rows.length !== ids.length) {
    throw new AttachmentRejected(400, "附件已失效，请重新上传");
  }
  for (const row of rows) {
    if (String(row.uploadedBy) !== actor.userId) {
      throw new AttachmentRejected(400, "附件已失效，请重新上传");
    }
    const object = await probeObject(config, row.storageKey);
    if (!object) {
      throw new AttachmentRejected(400, `「${row.fileName}」没有上传成功，请重试`);
    }
    if (BigInt(object.sizeBytes) !== row.sizeBytes) {
      // 客户端宣告 3MB、实际只传了 300KB —— 不拦下来，下载时就是一份坏文件
      throw new AttachmentRejected(400, `「${row.fileName}」上传不完整，请重试`);
    }
  }
  return rows.map((r) => ({ id: r.id, fileName: r.fileName, sizeBytes: Number(r.sizeBytes) }));
}

/** 事务内：把草稿挂到评论上，并逐条落审计 */
export async function attachToComment(
  tx: Tx,
  actor: Actor,
  args: {
    host: HostType;
    hostId: string;
    commentId: bigint;
    rows: readonly { id: bigint; fileName: string; sizeBytes: number }[];
  },
) {
  if (args.rows.length === 0) return;
  const updated = await tx
    .update(attachment)
    .set({ commentId: args.commentId })
    .where(
      and(
        inArray(
          attachment.id,
          args.rows.map((r) => r.id),
        ),
        isNull(attachment.commentId),
      ),
    )
    .returning({ id: attachment.id });
  if (updated.length !== args.rows.length) {
    // 并发：同一条草稿被另一条评论抢先挂上（或刚被删）。整笔失败比半挂上更好查。
    throw new AttachmentRejected(409, "附件已被其他评论使用，请重新上传");
  }
  for (const row of args.rows) {
    await logActivity(tx, actor, {
      [args.host === "matter" ? "matterId" : "riskMatterId"]: BigInt(args.hostId),
      targetType: args.host,
      targetId: BigInt(args.hostId),
      action: "ATTACHMENT_UPLOADED",
      payload: {
        attachmentId: String(row.id),
        commentId: String(args.commentId),
        fileName: row.fileName,
        sizeBytes: row.sizeBytes,
      },
    });
  }
}

/**
 * 一批评论的附件（按评论 id 索引）。
 *
 * 与 `mentionPartsOf` 同一个理由返回 Map：调用方迟早会过滤/排序评论，
 * 位置对齐的数组会在那天静默错位。
 */
export async function attachmentsOfComments(
  db: Db,
  commentIds: readonly bigint[],
): Promise<Map<string, AttachmentDto[]>> {
  const out = new Map<string, AttachmentDto[]>();
  if (commentIds.length === 0) return out;
  const rows = await db
    .select({
      id: attachment.id,
      commentId: attachment.commentId,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      uploadedAt: attachment.uploadedAt,
      uploadedBy: attachment.uploadedBy,
    })
    .from(attachment)
    .where(and(inArray(attachment.commentId, commentIds), sql`NOT ${attachment.isDeleted}`))
    .orderBy(attachment.uploadedAt, attachment.id);
  for (const r of rows) {
    const key = String(r.commentId);
    const list = out.get(key) ?? [];
    list.push({
      id: String(r.id),
      fileName: r.fileName,
      mimeType: r.mimeType,
      sizeBytes: Number(r.sizeBytes),
      uploadedAt: r.uploadedAt,
      uploadedBy: String(r.uploadedBy),
    });
    out.set(key, list);
  }
  return out;
}

/**
 * 一条附件的下载签名。**可见性按宿主判**（§7.1：签发时逐条判定宿主可见性），
 * 归档与否不影响读。
 */
/** `owner_type` → 宿主。未知值不可能是合法落点（CHECK 守着），按不可见处理。 */
function hostOfOwnerType(ownerType: string): HostType | null {
  return ownerType === "matter" || ownerType === "risk_matter" ? ownerType : null;
}

export type AttachmentState = AttachmentListState;

export type HostAttachment = {
  id: string;
  displayName: string;
  description: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
  uploadedBy: string;
  isDeleted: boolean;
  deletedAt: string | null;
};

/**
 * 宿主级材料列表（2026-10-23 / 迁移 0023）。
 *
 * 只查 `scope='host'`：评论附件已经在评论里展示，再列一遍会让同一份材料出现两次。
 * `state` 是「全部 / 生效 / 作废」的口径；作废行故意可查——材料作废是业务事实，
 * 归档追溯需要看得见。
 */
export async function listHostAttachments(
  actor: Actor,
  host: HostType,
  hostId: string,
  state: AttachmentState,
): Promise<{ items: HostAttachment[]; counts: { active: number; deleted: number } } | null> {
  const db = await getDb();
  if (!(await loadHost(db, actor, host, hostId))) return null;

  const base = and(
    eq(attachment.ownerType, host),
    eq(attachment.ownerId, BigInt(hostId)),
    eq(attachment.scope, "host"),
  );
  const where =
    state === "active"
      ? and(base, sql`NOT ${attachment.isDeleted}`)
      : state === "deleted"
        ? and(base, eq(attachment.isDeleted, true))
        : base;

  const [rows, counts] = await Promise.all([
    db
      .select({
        id: attachment.id,
        displayName: attachment.displayName,
        description: attachment.description,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        uploadedAt: attachment.uploadedAt,
        uploadedBy: sql<string>`(select u.display_name from mn_app_user u where u.id = ${attachment.uploadedBy})`,
        isDeleted: attachment.isDeleted,
        deletedAt: attachment.deletedAt,
      })
      .from(attachment)
      .where(where)
      .orderBy(desc(attachment.uploadedAt)),
    db
      .select({ deleted: attachment.isDeleted, n: sql<number>`count(*)::int` })
      .from(attachment)
      .where(base)
      .groupBy(attachment.isDeleted),
  ]);

  const countOf = (deleted: boolean) => counts.find((c) => c.deleted === deleted)?.n ?? 0;
  return {
    items: rows.map((r) => ({
      ...r,
      id: String(r.id),
      displayName: r.displayName ?? r.fileName,
      sizeBytes: Number(r.sizeBytes),
    })),
    counts: { active: countOf(false), deleted: countOf(true) },
  };
}

/**
 * 编辑材料元数据（名称 / 描述）。文件本身不可替换 —— 换文件是一次新的上传。
 *
 * **只收宿主材料**（`scope='host'`）：评论附件的显示名与评论渲染无关，允许改会变成
 * 静默无效写。权限与删除同一把尺：上传者本人、或 L1/`is_admin`。归档宿主只读。
 * 两个字段按**整体置位**语义写入（PATCH 缺省即清空），与编辑弹窗的提交形状一致。
 * 审计走 `ATTACHMENT_UPDATED`，payload 同时留 before/after（改了什么可回看）。
 */
export async function updateAttachmentMeta(
  actor: Actor,
  id: string,
  input: { displayName: string; description?: string | null },
): Promise<"ok" | "forbidden" | null> {
  const db = await getDb();
  const [row] = await db
    .select({
      id: attachment.id,
      ownerType: attachment.ownerType,
      ownerId: attachment.ownerId,
      uploadedBy: attachment.uploadedBy,
      displayName: attachment.displayName,
      description: attachment.description,
    })
    .from(attachment)
    .where(
      and(
        eq(attachment.id, BigInt(id)),
        eq(attachment.scope, "host"),
        sql`NOT ${attachment.isDeleted}`,
      ),
    )
    .limit(1);
  if (!row) return null;
  const host = hostOfOwnerType(row.ownerType);
  if (!host) return null;
  const hostRow = await loadHost(db, actor, host, String(row.ownerId));
  if (!hostRow) return null;
  if (hostRow.isArchived) return "forbidden";
  const privileged = actor.isAdmin || actor.dataScope === "all";
  if (!(privileged || String(row.uploadedBy) === actor.userId)) return "forbidden";

  const nextName = input.displayName.trim().slice(0, 255);
  const nextDesc = input.description?.trim() || null;
  await db.transaction(async (tx) => {
    await tx
      .update(attachment)
      .set({ displayName: nextName, description: nextDesc })
      .where(eq(attachment.id, row.id));
    await logActivity(tx, actor, {
      [host === "matter" ? "matterId" : "riskMatterId"]: row.ownerId,
      targetType: host,
      targetId: row.ownerId,
      action: "ATTACHMENT_UPDATED",
      payload: {
        attachmentId: String(row.id),
        before: { displayName: row.displayName, description: row.description },
        after: { displayName: nextName, description: nextDesc },
      },
    });
  });
  return "ok";
}

/**
 * 换 60 秒下载签名。
 *
 * 作废的**宿主材料**仍可下载（2026-10-23）：作废是业务状态，字节还在，材料列表的
 * 「作废」筛选明确承诺可回看；评论附件作废后仍按原口径不可下载（列表里也不再出现）。
 */
export async function signAttachmentDownload(actor: Actor, id: string): Promise<string | null> {
  const config = storage();
  const db = await getDb();
  const [row] = await db
    .select({
      fileName: attachment.fileName,
      storageKey: attachment.storageKey,
      ownerType: attachment.ownerType,
      ownerId: attachment.ownerId,
      scope: attachment.scope,
      isDeleted: attachment.isDeleted,
    })
    .from(attachment)
    .where(eq(attachment.id, BigInt(id)))
    .limit(1);
  if (!row) return null;
  if (row.isDeleted && row.scope !== "host") return null;
  const host = hostOfOwnerType(row.ownerType);
  if (!host) return null;
  const visible = await loadHost(db, actor, host, String(row.ownerId));
  if (!visible) return null;
  return presignUrl(config, {
    method: "GET",
    key: row.storageKey,
    expiresIn: config.getSeconds,
    downloadName: row.fileName,
  });
}

/**
 * 删除附件（**只软删行**，对象留作审计追溯 —— §7.1 原文）。
 *
 * 谁能删：上传者本人、评论作者、或 L1/`is_admin`。为什么不照"看得见就能写明细"放开：
 * 删除是不可逆的读侧事实（虽然字节还在，但界面上再也回不来），
 * 与"评论只许作者编辑"同一个尺度。
 */
export async function deleteAttachment(
  actor: Actor,
  id: string,
): Promise<"ok" | "forbidden" | null> {
  const db = await getDb();
  const [row] = await db
    .select({
      id: attachment.id,
      storageKey: attachment.storageKey,
      ownerType: attachment.ownerType,
      ownerId: attachment.ownerId,
      uploadedBy: attachment.uploadedBy,
      commentId: attachment.commentId,
      commentAuthor: comment.authorId,
    })
    .from(attachment)
    .leftJoin(comment, eq(comment.id, attachment.commentId))
    .where(and(eq(attachment.id, BigInt(id)), sql`NOT ${attachment.isDeleted}`))
    .limit(1);
  if (!row) return null;

  const host = hostOfOwnerType(row.ownerType);
  if (!host) return null;
  const hostRow = await loadHost(db, actor, host, String(row.ownerId));
  if (!hostRow) return null;
  if (hostRow.isArchived) return "forbidden";

  const uid = BigInt(actor.userId);
  const privileged = actor.isAdmin || actor.dataScope === "all";
  const allowed =
    privileged ||
    String(row.uploadedBy) === actor.userId ||
    String(row.commentAuthor) === actor.userId;
  if (!allowed) return "forbidden";

  await db.transaction(async (tx) => {
    await tx
      .update(attachment)
      .set({ isDeleted: true, deletedAt: new Date().toISOString(), deletedBy: uid })
      .where(and(eq(attachment.id, row.id), sql`NOT ${attachment.isDeleted}`));
    await logActivity(tx, actor, {
      [host === "matter" ? "matterId" : "riskMatterId"]: row.ownerId,
      targetType: host,
      targetId: row.ownerId,
      action: "ATTACHMENT_DELETED",
      payload: {
        attachmentId: String(row.id),
        commentId: row.commentId === null ? null : String(row.commentId),
        storageKey: row.storageKey,
      },
    });
  });
  return "ok";
}

/**
 * 评论提交失败时的补偿：把刚传上去的草稿行与对象一起清掉。
 *
 * 调不到/清理失败都**不抛**：评论已经失败，再让一个清理异常盖住真正的错误没有意义。
 * 残留的草稿行不可见、不占名额，等着将来的维护任务即可。
 */
export async function discardDrafts(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const config = loadStorageConfig();
    const db = await getDb();
    const rows = await db
      .select({ storageKey: attachment.storageKey })
      .from(attachment)
      .where(and(inArray(attachment.id, ids.map(BigInt)), isNull(attachment.commentId)));
    if (config) await Promise.all(rows.map((r) => deleteObject(config, r.storageKey)));
    await db
      .update(attachment)
      .set({ isDeleted: true, deletedAt: new Date().toISOString() })
      .where(and(inArray(attachment.id, ids.map(BigInt)), isNull(attachment.commentId)));
  } catch {
    /* 补偿路径，刻意吞掉：见函数头 */
  }
}
