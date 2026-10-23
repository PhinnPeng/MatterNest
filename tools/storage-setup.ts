/**
 * 对象存储的一次性准备（`pnpm storage:setup`）：**建桶**。
 *
 * ## 为什么这里没有 CORS 配置
 *
 * 浏览器直传 MinIO 需要跨源许可，而 MinIO **社区版不实现桶级 CORS**
 * （`PutBucketCors` 固定回 501 NotImplemented；桶级 CORS 属收费的 AIStor）。
 * 社区版唯一的开关是服务级的 `MINIO_API_CORS_ALLOW_ORIGIN`，要改共享实例配置并重启 ——
 * 那不是应用部署能做、也不该偷偷做的事。
 *
 * 因此附件上传走**应用内流式转发**（`services/attachments.ts`），同源请求，不需要 CORS。
 * 若将来对象存储换成 AIStor / 开了服务级 CORS，把上传端点换回预签名直传即可，
 * 校验与登记逻辑不变。
 *
 * 幂等：桶已存在时 S3 回 409（BucketAlreadyOwnedByYou），不算失败。
 */
import { loadStorageConfig, signedRequest } from "../src/app/lib/server/storage/s3.ts";

try {
  process.loadEnvFile();
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}

const config = loadStorageConfig();
if (!config) {
  console.error(
    "对象存储未配置：需要 MINIO_ENDPOINT / MINIO_BUCKET / MINIO_ACCESS_KEY / MINIO_SECRET_KEY。",
  );
  process.exit(1);
}

console.log(`storage:setup → ${config.endpoint} bucket=${config.bucket}`);

const req = signedRequest(config, { method: "PUT", path: `/${config.bucket}` });
const res = await fetch(req.url, { method: "PUT", headers: req.headers });
if (!res.ok && res.status !== 409) {
  console.error(`[FAIL] 建桶 —— HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
console.log(res.status === 409 ? "[ ok ] 桶已存在" : "[ ok ] 桶已创建");

// 用凭证做一次真正的读，确认"桶在且这个账号能进"（只看建桶的 409 分不清权限）
const head = signedRequest(config, {
  method: "GET",
  path: `/${config.bucket}`,
  query: [["location", ""]],
});
const check = await fetch(head.url, { headers: head.headers });
if (!check.ok) {
  console.error(`[FAIL] 读桶 —— HTTP ${check.status} ${(await check.text()).slice(0, 300)}`);
  process.exit(1);
}
console.log("[ ok ] 凭证可读该桶");

console.log("storage:setup 完成（上传走应用内转发，不需要桶级 CORS）");
