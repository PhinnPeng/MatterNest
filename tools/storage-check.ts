/**
 * 对象存储连通性自检（`pnpm storage:check`）。
 *
 * 为什么它必须是**真往返**而不是"配置看起来对"：SigV4 的签名错一位，
 * 服务端只会回 403，而 403 的成因有七八种（key、策略、时钟、编码、桶名）。
 * 只有签一个 PUT → 真传 → HEAD 核大小 → 签 GET 真下 → 删掉，才能区分
 * 「签名实现错了」与「桶/账号没权限」。
 *
 * 用 `--experimental-strip-types` 直接跑 TS（Node 22 自带类型剥离）：
 * 签名实现只有一份（`src/app/lib/server/storage/s3.ts`），
 * 自检脚本若另抄一份，就会出现"脚本绿、应用红"这种最贵的假绿。
 *
 * 退出码：0 全通；1 配置缺失或往返失败（会打印服务端原话）。
 */
import {
  loadStorageConfig,
  presignUrl,
  probeObject,
  deleteObject,
} from "../src/app/lib/server/storage/s3.ts";

try {
  process.loadEnvFile();
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}

const config = loadStorageConfig();
if (!config) {
  console.error(
    "对象存储未配置：需要 MINIO_ENDPOINT / MINIO_BUCKET / MINIO_ACCESS_KEY / MINIO_SECRET_KEY 四个值。",
  );
  console.error("（.env 已在 .gitignore 内；凭据只在部署侧与开发机本地存在。）");
  process.exit(1);
}

const key = `att/selfcheck-${Date.now().toString(36)}.txt`;
const body = new TextEncoder().encode(`mn storage selfcheck ${new Date().toISOString()}`);
const contentType = "text/plain; charset=utf-8";

function fail(step: string, detail: string): never {
  console.error(`[FAIL] ${step} —— ${detail}`);
  process.exit(1);
}

console.log(`storage:check → ${config.endpoint} bucket=${config.bucket}`);

const putUrl = presignUrl(config, { method: "PUT", key, expiresIn: 120, contentType });
const put = await fetch(putUrl, { method: "PUT", headers: { "content-type": contentType }, body });
if (!put.ok) {
  fail("PUT", `HTTP ${put.status} ${(await put.text()).slice(0, 300)}`);
}
console.log("[ ok ] 预签名 PUT 直传");

const head = await probeObject(config, key);
if (!head) fail("HEAD", "刚传上去的对象读不到");
if (head.sizeBytes !== body.byteLength) {
  fail("HEAD", `大小不符：期望 ${body.byteLength}，实际 ${head.sizeBytes}`);
}
console.log(`[ ok ] Range 读元数据（${head.sizeBytes} 字节，${head.contentType ?? "无类型"}）`);

const getUrl = presignUrl(config, {
  method: "GET",
  key,
  expiresIn: config.getSeconds,
  downloadName: "自检报告.txt",
});
const got = await fetch(getUrl);
if (!got.ok) fail("GET", `HTTP ${got.status} ${(await got.text()).slice(0, 300)}`);
const downloaded = new Uint8Array(await got.arrayBuffer());
if (Buffer.compare(Buffer.from(downloaded), Buffer.from(body)) !== 0) {
  fail("GET", "下载内容与上传不一致");
}
const disposition = got.headers.get("content-disposition") ?? "";
if (!disposition.startsWith("attachment")) {
  fail("GET", `Content-Disposition 不是 attachment：${disposition}`);
}
console.log(`[ ok ] 预签名 GET（${disposition}）`);

await deleteObject(config, key);
const gone = await probeObject(config, key);
if (gone) fail("DELETE", "删除后对象仍然存在");
console.log("[ ok ] 预签名 DELETE");

console.log("storage:check 通过");
