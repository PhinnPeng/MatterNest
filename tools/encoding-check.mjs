#!/usr/bin/env node
/**
 * 编码门禁：所有被 git 跟踪的文本文件必须是合法 UTF-8，且不含 U+FFFD。
 *
 * ## 为什么需要它
 *
 * 2026-10-12 至 10-23，6 个文件里先后固化了 18 个 U+FFFD（`Sever` 后面本该是
 * `ity`，`把一` 后面本该是量词，都变成了替换字符）。它们都是 Windows PowerShell
 * 5.1 的默认行为留下的：
 * `Get-Content` 按 ANSI/GBK 读 UTF-8 文件，`Out-File` / `>` 又默认写 UTF-16LE。
 * 来回一次，无法映射的字节就变成替换字符，**不可逆**。
 *
 * 这类损坏不会让任何既有门禁变红：注释里的中文坏了，typecheck、测试、lint、
 * prettier 都照常绿。等到有人读那段注释时，原词已经找不回来了。
 *
 * ## 边界
 *
 * - 二进制（含 NUL 字节且无 UTF-16 BOM）直接跳过：图片、字体不该被当文本判。
 * - UTF-16 文件只认 BOM 那两个形状，报「不是 UTF-8」而不是笼统的「无法解码」，
 *   因为下一句该做的事不同：转换编码，而不是逐个修字符。
 * - 只扫 `git ls-files`：未跟踪的本地临时产物不是仓库内容，`.gitignore`
 *   已经负责它们的去留。
 */
import { isUtf8 } from "node:buffer";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const files = execFileSync("git", ["ls-files", "-z"], { maxBuffer: 64 * 1024 * 1024 })
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const problems = [];

for (const file of files) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    // 文件在索引里但工作区没有（例如稀疏检出）：交给 git 自己报，不在本门禁范围
    continue;
  }

  if (
    buf.length >= 2 &&
    ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))
  ) {
    problems.push(`${file}: 是 UTF-16（带 BOM），请转成 UTF-8`);
    continue;
  }
  if (buf.includes(0)) continue;

  if (!isUtf8(buf)) {
    problems.push(`${file}: 不是合法的 UTF-8 字节序列`);
    continue;
  }
  const text = buf.toString("utf8");

  text.split("\n").forEach((line, index) => {
    if (line.includes("\uFFFD")) {
      const first = line.indexOf("\uFFFD");
      const snippet = line.slice(Math.max(0, first - 20), first + 20);
      problems.push(`${file}:${index + 1}: 含 U+FFFD 替换字符 …${snippet}…`);
    }
  });
}

if (problems.length) {
  console.error(`编码门禁未通过：${problems.length} 处`);
  for (const p of problems) console.error("  ✗ " + p);
  console.error(
    "\n修法：用编辑器把文件按 UTF-8 重新保存，并按上下文补回原词。" +
      "\n原字节已经丢了，不要指望 git 能还原。",
  );
  process.exit(1);
}

console.log(`编码检查通过：${files.length} 个跟踪文件，全部是合法 UTF-8 且无替换字符`);
