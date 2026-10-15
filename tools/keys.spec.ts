import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `tools/keys.mjs` 的护栏测试（MATT-36 决策落地）。
 *
 * ## 测什么、为什么不测「生成的值对不对」
 *
 * 产出值本身没法断言（随机）。能断言、且**出事要出人命**的是两条护栏：
 *   1. `gen` 在 env 已有值时**拒绝运行**（防止覆盖正在用的密钥 ⇒ 全库 PII 永久不可读）
 *   2. `check` 抓得住**字符颠倒**与**只贴值没贴校验**这两类手工搬运事故
 *
 * 第 2 条是本工具存在的理由，所以必须验它真的抓得住 ——
 * `parseKeyMaterial` 只管长度与字符集，颠倒后长度对、解出的字节数也对，
 * 它**不会**报错。工具若也抓不住，这一整套就是装饰。
 *
 * ## 为什么用子进程而不是 import
 *
 * 它是给运维在目标机器上执行的 CLI，行为的一部分就包含退出码与 stderr。
 * import 进来测不到那部分，而**退出码正是脚本之间唯一的契约**。
 */

const TOOL = "tools/keys.mjs";
const KEY_NAMES = ["MN_AES_KEY", "MN_HMAC_KEY", "MN_SESSION_PEPPER"] as const;

let dir: string;
let envPath: string;

/**
 * 跑一次工具，返回 `{code, out}`（out 是 stdout + stderr 合并）。
 *
 * ⚠ 用 `spawnSync` 而不是 `execFileSync`：后者在**退出码 0 时只给 stdout**，
 * 而本工具的警告（`--force` 仍在跑、护栏拦下了）走的是 stderr ——
 * 用 `execFileSync` 的话，恰恰是最该被断言的那些警告在断言里读不到，
 * 测试会「因为读不到而红」或「因为读不到而绿」，两种都是假信号。
 */
function run(...args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** 把 `gen --force` 的输出原样当成一份 env 文件（那就是运维粘贴后的样子）。 */
function generateBlock(): string {
  const r = run("gen", "--force", "--env", join(tmpdir(), "keys-spec-nonexistent.env"));
  expect(r.code).toBe(0);
  return r.out;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mn-keys-"));
  envPath = join(dir, ".env");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("keys.mjs gen：产出的三把形状对、且彼此独立", () => {
  it("三把互不相同，且都是 43 字符 base64url（解出 32 字节）", () => {
    const out = generateBlock();
    // 整体形状断言（testing-guidelines.md:18）：一次比三把，于是「少了一把」
    // 会自己变成 diff 的一行，而不是被 `!` 吞成 undefined 继续往下跑。
    const values = KEY_NAMES.map((n) => new RegExp(`^${n}=(\\S+)$`, "m").exec(out)?.[1] ?? null);
    expect(values).toEqual(KEY_NAMES.map(() => expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)));
    expect(values.map((v) => Buffer.from(v ?? "", "base64url").length)).toEqual([32, 32, 32]);
    expect(new Set(values).size).toBe(3);
  });

  it("每次产出都带 sha256 校验行，且**紧贴**在值的上一行", () => {
    const out = generateBlock();
    for (const n of KEY_NAMES) {
      const at = out.split(/\r?\n/).findIndex((l) => l.startsWith(`${n}=`));
      expect(at).toBeGreaterThan(0);
      // 必须是紧邻的上一行 —— 这是 keys:check 的读取契约
      expect(out.split(/\r?\n/)[at - 1]).toMatch(/^# sha256 前 8 位：[0-9a-f]{8}$/);
    }
  });

  it("每次运行都打印「之后一直用同一把」与三把各自的不可逆后果", () => {
    // 这条是给人看的文案，但它挡的是最贵的那个事故 —— 它掉了就该有人发现
    const out = generateBlock();
    expect(out).toContain("就一直用同一把");
    expect(out).toContain("永久不可读");
    expect(out).toContain("同一人查不出同一人");
    expect(out).toContain("全部会话立即失效");
  });
});

describe("keys.mjs gen 的护栏：env 已有值时拒绝运行（防覆盖正在用的密钥）", () => {
  it("三把里有值 ⇒ 非零退出，且说清是哪几个文件哪几把", () => {
    writeFileSync(envPath, "MN_AES_KEY=abc\n", "utf8");
    const r = run("gen", "--env", envPath);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("拒绝运行");
    expect(r.out).toContain("MN_AES_KEY");
    // 且必须点名它有多贵
    expect(r.out).toContain("永久不可读");
  });

  it("--force 才继续，且继续时仍然警告", () => {
    writeFileSync(envPath, "MN_AES_KEY=abc\n", "utf8");
    const r = run("gen", "--force", "--env", envPath);
    expect(r.code).toBe(0);
    expect(r.out).toContain("--force");
  });

  it("只有空值（`MN_AES_KEY=`）不算「已填」—— 那是还没开始填", () => {
    writeFileSync(envPath, "MN_AES_KEY=\nMN_HMAC_KEY=\nMN_SESSION_PEPPER=\n", "utf8");
    expect(run("gen", "--env", envPath).code).toBe(0);
  });

  it("被注释掉的行不算（运维常常留着 `.env.example` 的注释形态）", () => {
    writeFileSync(envPath, "# MN_AES_KEY=abc\n", "utf8");
    expect(run("gen", "--env", envPath).code).toBe(0);
  });
});

describe("keys.mjs check：抓得住 parseKeyMaterial 抓不住的事故", () => {
  it("正确粘贴 ⇒ 通过", () => {
    writeFileSync(envPath, generateBlock(), "utf8");
    const r = run("check", "--env", envPath);
    expect(r.code).toBe(0);
    expect(r.out).toContain("核对通过");
  });

  /**
   * 本工具存在的核心理由。
   *
   * 43 字符里颠倒两个位置 ⇒ 仍是 43 字符、仍解出 32 字节 ⇒
   * `parseKeyMaterial` **通过** ⇒ 启动期自检也通过 ⇒ 直到读当事人详情才 500。
   * 而「服务起来了、登录能用、点开详情才 500」与「服务没配好」极难区分。
   */
  it("字符颠倒 ⇒ 报错（而 parseKeyMaterial 此时是绿的）", () => {
    const lines = generateBlock().split(/\r?\n/);
    const at = lines.findIndex((l) => l.startsWith("MN_AES_KEY="));
    const value = lines[at].slice(lines[at].indexOf("=") + 1);
    const swapped = value.slice(0, 5) + value[6] + value[5] + value.slice(7);
    lines[at] = `MN_AES_KEY=${swapped}`;
    writeFileSync(envPath, lines.join("\n"), "utf8");

    // 前提确认：这一步 parseKeyMaterial 看不出来
    expect(swapped).toHaveLength(value.length);
    expect(Buffer.from(swapped, "base64url")).toHaveLength(32);

    const r = run("check", "--env", envPath);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("对不上");
  });

  /**
   * **A-1 的回归用例。**
   *
   * 早先这里只把 HMAC 的值换成 AES 的，于是它上方那行校验值自然对不上，
   * `check` 报「对不上」—— 看着是过了，实际过在**错误的原因**上，
   * 而「抓不住贴错行」这件事被完全掩盖（评审抓到）。
   *
   * 现在把三把的值**与各自上方的校验值**一起改一致，于是校验值这一层
   * 完全无话可说，**只剩互不相同那一条**能拦 —— 它正是本用例要钉的。
   */
  it("三把贴成同一把、且各自上方的校验值都改对 ⇒ 仍须报错（只剩互不相同能拦）", () => {
    const lines = generateBlock().split(/\r?\n/);
    const aes = /\nMN_AES_KEY=(\S+)/.exec(generateBlock())?.[1] ?? null;
    expect(aes).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const fp = createHash("sha256")
      .update(aes ?? "")
      .digest("hex")
      .slice(0, 8);

    for (const n of KEY_NAMES) {
      const at = lines.findIndex((l) => l.startsWith(`${n}=`));
      lines[at] = `${n}=${aes}`;
      lines[at - 1] = `# sha256 前 8 位：${fp}`;
    }
    writeFileSync(envPath, lines.join("\n"), "utf8");

    const r = run("check", "--env", envPath);
    expect(r.code).not.toBe(0);
    // 必须是「同一把」这条，不许是「校验值对不上」那条
    expect(r.out).toContain("同一把密钥");
    expect(r.out).not.toContain("对不上");
  });

  it("只贴了值、没贴上方的校验行 ⇒ 报错（否则本工具等于没跑）", () => {
    const bare = KEY_NAMES.map((n) => `${n}=${"A".repeat(43)}`).join("\n");
    writeFileSync(envPath, bare, "utf8");
    const r = run("check", "--env", envPath);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("没贴注释");
  });

  it("**一个都没核对成功 ⇒ 报错**（canary：否则它会报「全部通过」而什么都没验）", () => {
    // 三个键都不在这份文件里 —— 早先写成 `checked === 0` 之前，这里会打印「核对通过」
    writeFileSync(envPath, "PGHOST=127.0.0.1\n", "utf8");
    const r = run("check", "--env", envPath);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("什么都没验");
  });
});

describe("keys.mjs 的进程契约：退出码、以及它从不写 env", () => {
  it("未知命令 ⇒ 退出码 2 并给出用法", () => {
    const r = run("nope");
    expect(r.code).toBe(2);
    expect(r.out).toContain("用法");
  });

  it("工具**从不写** env 文件（护栏是只读的一半，缺了另一半就是自动填充）", () => {
    const before = readFileSync(envPath, "utf8");
    run("gen", "--force", "--env", envPath);
    run("check", "--env", envPath);
    expect(readFileSync(envPath, "utf8")).toBe(before);
  });
});
