import { createHash, createHmac } from "node:crypto";

/**
 * 对象存储（MinIO / S3 兼容）的**签名面**——只签 URL，不中转字节。
 *
 * ## 为什么手写 SigV4，而不引 SDK
 *
 * 服务端在这条链路里只做四件事：签一个 PUT URL、签一个 GET URL、签一个 DELETE、
 * 判对象在不在。`@aws-sdk/client-s3` 为这四件事带进来的是几十个包与一整套凭据链；
 * 仓库此前对 `mn_attachment` 的结论就是「服务端只签 PUT/GET URL」（技术选型 §12.2 C3）。
 * 签名本身是**纯函数**（输入：方法/键/过期/时间；输出：URL），没有需要重试的状态，
 * 所以这里保留一份 60 行的实现，并用 `pnpm storage:check` 对真 MinIO 做端到端验证 ——
 * 签名错不错由服务端说了算，不由单测的自说自话说了算。
 *
 * ## 三个刻意的选择
 *
 * 1. **PUT 把 `content-type` 签进去**：对象存下来是什么类型由服务端定，不信客户端声明。
 *    代价是浏览器必须原样带回这个头（见 `lib/client/upload.ts`）；好处是一个 `.html`
 *    改成 `.pdf` 上传后，桶里的 Content-Type 仍是 application/pdf，不会被当成网页执行。
 * 2. **GET 带 `response-content-disposition` / `response-content-type`**：下载一律
 *    `attachment`，中文名走 RFC 5987 的 `filename*=UTF-8''…`。签名后的响应头不能被客户端改。
 * 3. **payload 用 `UNSIGNED-PAYLOAD`**：预签名 URL 根本不知道将要传什么字节，
 *    这是 S3 为这条路径留的固定值。
 */

/** 读环境变量得到的连接参数。`null` = 服务账号没配（附件功能如实不可用） */
export type StorageConfig = {
  /** 形如 `http://127.0.0.1:30090`，**不带**桶名与尾斜杠 */
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
  /** 下载签名有效期（秒）。§7.1 的口径是 60 */
  getSeconds: number;
};

/** 签名失败/配置缺失都抛它，路由层统一翻成 503（不是 500：这是部署没开通，不是代码崩了） */
export class StorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageUnavailableError";
  }
}

/**
 * 从环境变量读配置。**没有 key 就返回 null**，不抛——
 * "没开通"与"配错了"必须分开：前者是 `unavailable`（界面说清楚），
 * 后者才是部署事故（`pnpm storage:check` 会红）。
 */
export function loadStorageConfig(
  env: Record<string, string | undefined> = process.env,
): StorageConfig | null {
  const endpoint = env.MINIO_ENDPOINT?.trim().replace(/\/+$/, "");
  const bucket = env.MINIO_BUCKET?.trim();
  const accessKey = env.MINIO_ACCESS_KEY?.trim();
  const secretKey = env.MINIO_SECRET_KEY?.trim();
  if (!endpoint || !bucket || !accessKey || !secretKey) return null;
  return {
    endpoint,
    bucket,
    accessKey,
    secretKey,
    // MinIO 单机不需要 region，但 SigV4 必须有一个；`us-east-1` 是 S3 兼容实现的默认值
    region: env.MINIO_REGION?.trim() || "us-east-1",
    getSeconds: Number(env.MINIO_PRESIGN_GET_SECONDS ?? 60) || 60,
  };
}

const RFC3986 = /[!'()*]/g;

/**
 * RFC 3986 编码。`encodeURIComponent` **不够**：它放过 `!'()*`，
 * 而 S3 的规范查询串要求这些也转义 —— 文件名里一个半角括号就能让签名对不上。
 */
function enc(v: string): string {
  return encodeURIComponent(v).replace(
    RFC3986,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

function hmac(key: string | Buffer, v: string): Buffer {
  return createHmac("sha256", key).update(v).digest();
}

/** `20261022T081500Z` 与 `20261022` */
function amzDates(now: Date) {
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export type PresignInput = {
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  /** 对象键（不含桶名、不以 `/` 开头） */
  key: string;
  /** 有效期：PUT/DELETE 用短值，GET 用 `config.getSeconds` */
  expiresIn: number;
  /** PUT 必填：签进签名，客户端必须原样发送 */
  contentType?: string;
  /** GET 用：强制下载 */
  downloadName?: string;
  /** 测试用固定时钟；不传就是此刻 */
  now?: Date;
};

/**
 * 生成预签名 URL。纯函数：同一个 `now` 与输入永远得到同一个 URL。
 *
 * 步骤就是 AWS 文档那七步（canonical request → string to sign → 派生密钥 → 签名），
 * 唯一与本项目相关的是**键的形状**：`att/<uuid>`，路径里只有安全字符。
 */
export function presignUrl(config: StorageConfig, input: PresignInput): string {
  const now = input.now ?? new Date();
  const { amzDate, dateStamp } = amzDates(now);
  const endpoint = new URL(config.endpoint);
  const host = endpoint.host;
  const basePath = endpoint.pathname.replace(/\/+$/, "");
  const canonicalUri = `${basePath}/${enc(config.bucket)}/${input.key.split("/").map(enc).join("/")}`;

  const query: [string, string][] = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${config.accessKey}/${dateStamp}/${config.region}/s3/aws4_request`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(Math.max(1, Math.floor(input.expiresIn)))],
    ["X-Amz-SignedHeaders", input.method === "PUT" ? "content-type;host" : "host"],
  ];
  if (input.method === "GET") {
    // 签进去的响应头：下载一律 attachment，中文名用 RFC 5987
    if (input.downloadName) {
      query.push([
        "response-content-disposition",
        `attachment; filename*=UTF-8''${enc(input.downloadName)}`,
      ]);
    }
    query.push(["response-content-type", "application/octet-stream"]);
  }
  const canonicalQuery = query
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalHeaders =
    input.method === "PUT"
      ? `content-type:${input.contentType ?? "application/octet-stream"}\nhost:${host}\n`
      : `host:${host}\n`;
  const signedHeaders = input.method === "PUT" ? "content-type;host" : "host";

  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretKey}`, dateStamp), config.region), "s3"),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  return `${config.endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/**
 * 对象是否存在，以及它的大小/类型。
 *
 * ## 为什么用「GET + Range: bytes=0-0」而不是 HEAD
 *
 * 语义上 HEAD 最合适（不产生字节），但**实测共享 dev 机的端口映射不转发 HEAD**：
 * 请求发出后对端直接关连接（`UND_ERR_SOCKET`，bytesRead=0），而同样的 URL 换 GET 就通。
 * 一条只在生产可用、开发环境永远走不到的自检没有任何价值，所以这里取 Range 只读 1 个字节：
 * 206 的 `Content-Range` 尾部就是总大小，代价可以忽略。
 *
 * 返回 `null` = 对象不在（404）。其他状态码抛错——把网络故障当成"不在"，
 * 会让一次断网变成评论里少了几个附件。
 */
export async function probeObject(
  config: StorageConfig,
  key: string,
  init?: { fetchImpl?: typeof fetch; now?: Date },
): Promise<{ sizeBytes: number; contentType: string | null } | null> {
  const url = presignUrl(config, {
    method: "GET",
    key,
    expiresIn: 30,
    now: init?.now,
  });
  const res = await (init?.fetchImpl ?? fetch)(url, {
    method: "GET",
    headers: { range: "bytes=0-0" },
  });
  if (res.status === 404) return null;
  if (!res.ok && res.status !== 206) {
    throw new StorageUnavailableError(`对象存储读取失败（HTTP ${res.status}）`);
  }
  // 空对象（0 字节）会回 200 + content-length: 0；`Content-Range: bytes 0-0/1234` 才是常态
  const range = res.headers.get("content-range");
  const total = range?.split("/")[1];
  return {
    sizeBytes: total ? Number(total) : Number(res.headers.get("content-length") ?? 0),
    contentType: res.headers.get("content-type"),
  };
}

/** 删除对象（物理删除只用于"上传了但评论没发出去"的补偿，见 `services/attachments.ts`） */
export async function deleteObject(
  config: StorageConfig,
  key: string,
  init?: { fetchImpl?: typeof fetch; now?: Date },
): Promise<void> {
  const url = presignUrl(config, { method: "DELETE", key, expiresIn: 30, now: init?.now });
  const res = await (init?.fetchImpl ?? fetch)(url, { method: "DELETE" });
  // 404 = 已经不在了，对补偿逻辑而言是成功
  if (!res.ok && res.status !== 404) {
    throw new StorageUnavailableError(`对象删除失败（HTTP ${res.status}）`);
  }
}

/**
 * **带 Authorization 头的签名请求**（不是预签名 URL）。
 *
 * 只有桶级管理动作（建桶、配 CORS）需要它：这些请求带 XML 体、走 `?cors` 这类子资源。
 * 用预签名 URL 表达会把"对象键"与"桶子资源"两种路径混在一起。浏览器永远走不到这里。
 */
export function signedRequest(
  config: StorageConfig,
  input: {
    method: "PUT" | "GET" | "POST" | "DELETE";
    /** `/` 开头的完整路径（含桶名），如 `/mn-attachments` */
    path: string;
    /** 子资源，如 `[["cors", ""]]` */
    query?: [string, string][];
    body?: string | Uint8Array;
    contentType?: string;
    now?: Date;
  },
): { url: string; headers: Record<string, string> } {
  const now = input.now ?? new Date();
  const { amzDate, dateStamp } = amzDates(now);
  const endpoint = new URL(config.endpoint);
  const canonicalUri = `${endpoint.pathname.replace(/\/+$/, "")}/${input.path.replace(/^\/+/, "")}`;
  const canonicalQuery = (input.query ?? [])
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const payloadHash = createHash("sha256")
    .update(input.body ?? "")
    .digest("hex");
  const headerPairs: [string, string][] = [["host", endpoint.host]];
  if (input.contentType) headerPairs.push(["content-type", input.contentType]);
  headerPairs.push(["x-amz-content-sha256", payloadHash], ["x-amz-date", amzDate]);
  headerPairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalHeaders = headerPairs.map(([k, v]) => `${k}:${v}\n`).join("");
  const signedHeaders = headerPairs.map(([k]) => k).join(";");

  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretKey}`, dateStamp), config.region), "s3"),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  const headers: Record<string, string> = {
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (input.contentType) headers["content-type"] = input.contentType;

  return {
    url: `${config.endpoint}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`,
    headers,
  };
}
