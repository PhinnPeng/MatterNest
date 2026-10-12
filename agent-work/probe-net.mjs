/**
 * 通路分层诊断。
 *
 * 起因是「`Test-NetConnection` 报 True，但连上去什么都不说」这类现象，
 * 而且它同时发生在本机端口和网关另一侧的节点上——两种不同的原因，
 * 必须分层才能分开。只靠"再重试几次"是分不出来的。
 *
 * 分三层，每层结论不同：
 *   L1 裸 TCP     —— 分「没在监听」与「监听了但不说话」
 *   L2 协议应答   —— SSH 服务端会**主动**发 banner；PG 要我们先发 SSLRequest
 *   L3 归属       —— 是哪个进程占着这个端口（Windows 用 netstat 按 PID 反查）
 *
 * 用法：`node --env-file=.env agent-work/probe-net.mjs`
 */
import net from "node:net";
import { execSync } from "node:child_process";

const LOCAL = process.env.PGHOST ?? "127.0.0.1";
const LOCAL_PORT = Number(process.env.PGPORT ?? 5432);

/** 本机监听端口的归属进程（只在 Windows 上有意义，其他平台跳过） */
function ownerOf(port) {
  if (process.platform !== "win32") return "（非 Windows，未查）";
  try {
    const out = execSync("netstat -ano", { encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) {
      const f = line.trim().split(/\s+/);
      if (f[0] !== "TCP" || !f[1]?.endsWith(`:${port}`)) continue;
      if (f[3] !== "LISTENING") continue;
      const pid = f[4];
      let name = pid;
      try {
        name = execSync(`powershell -NoProfile -Command "(Get-Process -Id ${pid}).ProcessName"`, {
          encoding: "utf8",
        }).trim();
      } catch {
        /* 进程已退出 */
      }
      return `${name} (PID ${pid})`;
    }
  } catch {
    /* netstat 不可用 */
  }
  return "本机无监听";
}

/** L1+L2：连上后只读，不发任何字节（SSH 会主动开口；PG 则永远不会主动说话） */
function probe(host, port, { sendPgHello = false } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port });
    let peer = "?";
    let seen = "";
    const done = (v) => {
      s.destroy();
      resolve(`${v}（${Date.now() - t0} ms，对端 ${peer}）`);
    };
    s.on("connect", () => {
      peer = `${s.remoteAddress}:${s.remotePort}`;
      if (sendPgHello) {
        // PG v3 SSLRequest：length=8, magic=80877103
        const req = Buffer.alloc(8);
        req.writeInt32BE(8, 0);
        req.writeInt32BE(80877103, 4);
        s.write(req);
      }
    });
    s.on("data", (d) => {
      seen += d.toString("latin1");
      const c = seen[0];
      const what = c === "S" ? "S=支持SSL（后面是活的 PG）" : c === "E" ? "E=PG 错误应答" : `首字节=${JSON.stringify(c)}`;
      done(`L2 有应答：${what} 内容=${JSON.stringify(seen.slice(0, 32))}`);
    });
    s.setTimeout(5000);
    s.on("timeout", () => done("L2 无应答：TCP 建立了，但 5 秒内一个字节都没回"));
    s.on("error", (e) => done(`L1 连不上（${e.code ?? e.message}）`));
  });
}

const targets = [
  [LOCAL, LOCAL_PORT, true, "库（本机 .env 配的那个）"],
  ["127.0.0.1", 22, false, "SSH（本机 22）"],
];

console.log("=== 分层诊断 ===");
for (const [host, port, pg, label] of targets) {
  console.log(`\n${label}  ${host}:${port}`);
  console.log(`  ${await probe(host, port, { sendPgHello: pg })}`);
  if (port === LOCAL_PORT || port === 22) console.log(`  L3 本机该端口归属：${ownerOf(port)}`);
}

console.log(`
判读：
  · L1 连不上        → 端口没人监听，隧道/服务没起
  · L1 通 + L2 无应答 → 有人占着端口但不说这个协议（端口被别的程序抢占）
  · L1 通 + L2 有应答 → 通路正常，问题在更上层（凭据、库、配置）`);