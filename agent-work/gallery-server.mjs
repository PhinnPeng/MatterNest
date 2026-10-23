import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 草图画廊静态服务：0.0.0.0:65310
//   /            -> .impeccable/mocks/pages/
//   /decision/*  -> .impeccable/mocks/decision/
// 局域网可访问（用户在别的机器上过目草图）。纯静态，无写接口。
const here = path.dirname(fileURLToPath(import.meta.url));
const MOUNTS = [
  { prefix: "/decision/", root: path.resolve(here, "../.impeccable/mocks/decision") },
  { prefix: "/", root: path.resolve(here, "../.impeccable/mocks/pages") },
];
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function resolve(p) {
  for (const m of MOUNTS) {
    if (p === m.prefix || p.startsWith(m.prefix)) {
      const rest = p === m.prefix ? "" : p.slice(m.prefix.length);
      const file = path.normalize(path.join(m.root, rest));
      if (file === m.root || file.startsWith(m.root + path.sep)) return file;
      return null;
    }
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  const file = resolve(p);
  if (!file) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
});

server.listen(65310, "0.0.0.0", () => {
  console.log("sketch gallery listening on 0.0.0.0:65310");
});
