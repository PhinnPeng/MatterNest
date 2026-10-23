/**
 * 评论附件的**真浏览器外真 HTTP** 探针（§7.1，2026-10-22）。
 *
 * 判据的一半在 HTTP 响应里看不见或容易自欺：
 *   · 「上传成功」不等于「对象真的在桶里且大小对」——所以要回读一次字节；
 *   · 「下载签名」不等于「浏览器会下载」——所以要看 `Content-Disposition: attachment`；
 *   · 「附件挂上了」不等于「详情接口会把它带出来」——所以要再 GET 一次详情；
 *   · 「校验值不对」必须**拒收**，而不是存下一份打不开的文件。
 *
 * 夹具：临时 fullAdmin 账号 + 一个案件 + 一个事项。清场顺序是硬约束：
 * `mn_attachment.uploaded_by` 是 RESTRICT，先删附件行，再删评论，
 * 否则 `dropSmokeAccount` 会被外键拦住（它只认 comment/owner 那几列）。
 *
 * ⚠ 清场**只删行**：按 §7.1 的口径，被软删的附件对象要留作审计追溯。
 *   dev 桶里的 `att/` 对象因此会留下探针残片；这是数据卫生问题，
 *   不是本探针的判据（`pnpm storage:check` 会真删自己传的那一个）。
 *
 * 用法：`node --env-file=.env agent-work/probe-attachments.mjs`（需 dev 在 3777）。
 */
import { createHash } from "node:crypto";
import postgres from "postgres";
import { createSmokeAccount, dropSmokeAccount, ROLE_CODES } from "./_testacct.mjs";

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";
const stamp = Date.now().toString(36).slice(-6);

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass += 1;
    console.log(`[ ok ] ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

async function call(method, path, cookie, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(payload ? { "content-type": "application/json" } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

let account;
let matterId;
let riskId;

try {
  account = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
  const lr = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: account.username, password: account.password }),
  });
  ok("夹具账号能登录", lr.status === 200, `status=${lr.status}`);
  const cookie = (lr.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

  const mk = await call("POST", "/api/matters", cookie, {
    name: `附件探针案件 ${stamp}`,
    cause: "买卖合同纠纷",
    caseType: "civil_commercial",
    procedure: "first_instance",
    litigationRole: "plaintiff",
    level: "high",
  });
  ok("夹具案件建出来了", mk.status === 201, `status=${mk.status}`);
  matterId = mk.body.id;

  const mr = await call("POST", "/api/risk-matters", cookie, {
    name: `附件探针事项 ${stamp}`,
    type: "contract",
    level: "mid",
    description: "探针：附件上传/挂载/下载/删除。",
  });
  ok("夹具事项建出来了", mr.status === 201, `status=${mr.status}`);
  riskId = mr.body.id;

  const upload = async (host, hostId, fileName, bytes) => {
    const qs = new URLSearchParams({
      host,
      hostId,
      fileName,
      sizeBytes: String(bytes.length),
      checksumSha256: sha256(bytes),
    });
    const res = await fetch(`${BASE}/api/attachments/upload?${qs}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/octet-stream" },
      body: bytes,
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  };

  // ── ① 案件侧：上传 → 发评论（带附件）→ 详情回读 ──
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100fdff03fd0000000049454e44ae426082",
    "hex",
  );
  const up1 = await upload("matter", matterId, "证据一.png", png);
  ok("案件：PNG 上传成功", up1.status === 201, `status=${up1.status} ${up1.body?.message ?? ""}`);
  const att1 = up1.body;

  const c1 = await call("POST", `/api/matters/${matterId}/comments`, cookie, {
    body: "PROBE · 这条评论带一份证据截图",
    attachments: [att1.id],
  });
  ok("案件：带附件的评论发出去了", c1.status === 201, `status=${c1.status}`);

  const detail1 = await call("GET", `/api/matters/${matterId}`, cookie);
  const commented = detail1.body.comments?.find((c) => String(c.id) === String(c1.body.id));
  ok(
    "案件详情：评论带回了附件元数据",
    commented?.attachments?.length === 1 &&
      commented.attachments[0].fileName === "证据一.png" &&
      commented.attachments[0].sizeBytes === png.length,
    JSON.stringify(commented?.attachments ?? null),
  );

  const signed = await call("GET", `/api/attachments/${att1.id}/url`, cookie);
  ok("下载签名拿得到", signed.status === 200 && typeof signed.body.url === "string");
  const dl = await fetch(signed.body.url);
  const dlBytes = Buffer.from(await dl.arrayBuffer());
  ok("下载回来的字节与上传一致", dl.ok && Buffer.compare(dlBytes, png) === 0, `status=${dl.status}`);
  ok(
    "下载是 attachment（不会被当成网页渲染）",
    (dl.headers.get("content-disposition") ?? "").startsWith("attachment"),
    dl.headers.get("content-disposition") ?? "无",
  );

  // ── ② 事项侧：上传 → 评论 → 详情回读 ──
  const up2 = await upload("risk_matter", riskId, "合同.pdf", Buffer.from("%PDF-1.4 probe"));
  ok("事项：PDF 上传成功", up2.status === 201, `status=${up2.status}`);  const c2 = await call("POST", `/api/risk-matters/${riskId}/comments`, cookie, {
    body: "PROBE · 事项侧带合同",
    attachments: [up2.body.id],
  });
  ok("事项：带附件的评论发出去了", c2.status === 201, `status=${c2.status}`);
  const detail2 = await call("GET", `/api/risk-matters/${riskId}`, cookie);
  const rc = detail2.body.comments?.find((c) => String(c.id) === String(c2.body.id));
  ok("事项详情：评论带回了附件", rc?.attachments?.length === 1, JSON.stringify(rc?.attachments ?? null));

  // ── ②b 大文件：流式转发在 MB 量级也必须完整（5MB 随机字节，校验值不会骗人） ──
  const big = Buffer.alloc(5 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 1) big[i] = (i * 31 + 7) % 251;
  const up3 = await upload("matter", matterId, "材料包.zip", big);
  ok("5MB 文件上传成功", up3.status === 201, `status=${up3.status} ${up3.body?.message ?? ""}`);
  const signed3 = await call("GET", `/api/attachments/${up3.body.id}/url`, cookie);
  const dl3 = await fetch(signed3.body.url);
  const dl3Bytes = Buffer.from(await dl3.arrayBuffer());
  ok(
    "5MB 下载回来逐字节一致",
    dl3.ok && dl3Bytes.length === big.length && Buffer.compare(dl3Bytes, big) === 0,
    `${dl3Bytes.length} 字节`,
  );

  // ── ③ 拒绝路径 ──
  const exe = await upload("matter", matterId, "木马.exe", Buffer.from("MZ"));
  ok("非白名单类型被拒", exe.status === 400, `status=${exe.status} ${exe.body?.message ?? ""}`);

  const empty = await upload("matter", matterId, "空.pdf", Buffer.alloc(0));
  ok("空文件被拒", empty.status === 400, `status=${empty.status}`);

  const tooBig = await fetch(`${BASE}/api/attachments/upload?${new URLSearchParams({
    host: "matter",
    hostId: matterId,
    fileName: "大文件.zip",
    sizeBytes: String(60 * 1024 * 1024),
    checksumSha256: sha256(Buffer.from("x")),
  })}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/octet-stream" },
    body: Buffer.from("x"),
  });
  ok("声明超过 50MB 被拒", tooBig.status === 413, `status=${tooBig.status}`);

  const badSumQs = new URLSearchParams({
    host: "matter",
    hostId: matterId,
    fileName: "校验值不对.pdf",
    sizeBytes: "4",
    checksumSha256: sha256(Buffer.from("nope")),
  });
  const badSum = await fetch(`${BASE}/api/attachments/upload?${badSumQs}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/octet-stream" },
    body: Buffer.from("real"),
  });
  ok("校验值不一致被拒", badSum.status === 400, `status=${badSum.status}`);

  // ── ④ 删除：软删后详情里消失，下载签名 404 ──
  const del = await call("DELETE", `/api/attachments/${att1.id}`, cookie);
  ok("附件删除成功", del.status === 200, `status=${del.status}`);
  const detail3 = await call("GET", `/api/matters/${matterId}`, cookie);
  const after = detail3.body.comments?.find((c) => String(c.id) === String(c1.body.id));
  ok("删除后详情里没有这条附件了", (after?.attachments ?? []).length === 0);
  const gone = await call("GET", `/api/attachments/${att1.id}/url`, cookie);
  ok("删除后下载签名 404", gone.status === 404, `status=${gone.status}`);

  // 软删只改行：库里还能查到（§7.1 的审计追溯）
  const [row] = await sql`
    select is_deleted from mn_attachment where id = ${BigInt(att1.id)}
  `;
  ok("软删行仍在库里（审计追溯）", row?.is_deleted === true);
} catch (e) {
  fail += 1;
  console.log(`[FAIL] 探针异常：${e?.stack ?? e}`);
} finally {
  // ── 清场：附件 → 评论 → 活动 → 夹具宿主行 → 账号 ──
  try {
    const ids = [matterId, riskId].filter(Boolean).map((id) => BigInt(id));
    for (const host of ["matter", "risk_matter"]) {
      for (const id of ids) {
        await sql`delete from mn_attachment where owner_type = ${host} and owner_id = ${id}`;
        await sql`delete from mn_comment where target_type = ${host} and target_id = ${id}`;
        await sql`delete from mn_activity_log where target_type = ${host} and target_id = ${id}`;
      }
    }
    for (const id of ids) {
      await sql`delete from mn_attachment where owner_type in ('matter','risk_matter') and owner_id = ${id}`;
      await sql`delete from mn_matter_staff where matter_id = ${id}`;
      await sql`delete from mn_risk_matter_staff where risk_matter_id = ${id}`;
      await sql`delete from mn_matter_node where matter_id = ${id}`;
      await sql`delete from mn_risk_matter_node where risk_matter_id = ${id}`;
      await sql`delete from mn_matter where id = ${id}`;
      await sql`delete from mn_risk_matter where id = ${id}`;
    }
    if (account) await dropSmokeAccount(sql, account.id);
  } catch (e) {
    console.log(`[warn] 清场失败：${e?.message ?? e}`);
    fail += 1;
  }
  await sql.end();
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
