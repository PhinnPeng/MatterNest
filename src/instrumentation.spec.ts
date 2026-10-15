import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PumpResult } from "@/app/lib/server/services/pump-gate";
import { BUSINESS_TIMEZONE } from "@/shared/time/zh-cn";
import { makeOnOverrun, makeTick, startTimer, type TickDeps } from "./instrumentation-node";

/**
 * 定时器的四个前置件里，能在**离线**钉住的那几条（MATT-74）。
 *
 * ## 这里钉的是什么，以及为什么必须钉
 *
 * 前置件 2（`try/catch` 在 tick **回调体内部**）是四个里最容易做错、代价最大的一个：
 * tick 是 async 回调体，抛错变成 `unhandledRejection`，而那时 `register()` 早已返回、
 * server ready 早已放行——**外层 `try/catch` 连执行机会都没有**，
 * 紧接着 Node ≥15 的默认（`--unhandled-rejections=throw`）**带走整个进程**。
 * 「这条不钉住，前置件 2 会被后人改回去」是票面原话，所以下面第一条断言盯的就是它。
 *
 * 前置件 3（croner 四项配置）与前置件 4（单飞）分别由
 * 「真 croner 走一遍」与 `services/pump-gate.spec.ts` 钉住。
 *
 * 前置件 1（`register()` 不 await 任何 I/O）用**源码断言**钉：
 * 同步函数在语法上就不可能 `await`（那是编译错误），所以「register 是同步声明」
 * 这一条等价于「它不可能 await 任何东西」。写成 `async` 的话下面第二条会红。
 *
 * 本文件**不碰数据库、不碰网络**（另有一条纪律：`pnpm verify` 必须离线可跑，
 * `api/internal/pump/route.spec.ts:11` 同款）——所以假泵、假心跳全都注入进来。
 */

const quiet: TickDeps["log"] = { info: () => {}, error: () => {} };

/** 一次成功 pump 的形状（三个字段都是服务层现成的返回类型，这里逐字照抄） */
const PUMP_OK: PumpResult = {
  outbox: { scanned: 1, published: 1, failed: 0, events: 1, merged: 0 },
  scan: { scanned: 2, events: 1, merged: 0 },
  archive: {
    ruleFound: true,
    enabled: true,
    scanned: 3,
    events: 0,
    merged: 0,
    skipped: [],
    dateKey: "2026-10-14",
  },
};

function fakeDeps(over: Partial<TickDeps> = {}): TickDeps {
  return { pump: async () => PUMP_OK, heartbeat: async () => {}, log: quiet, ...over };
}

describe("前置件 2：tick 抛错 ⇒ 不拒绝、进程存活、日志有记录", () => {
  it("泵抛错时 tick **resolve**（不是 reject），且**不写心跳**", async () => {
    const error = vi.fn();
    const heartbeat = vi.fn(async () => {});
    const tick = makeTick(
      fakeDeps({
        pump: async () => {
          throw new Error("boom-pump");
        },
        heartbeat,
        log: { info: () => {}, error },
      }),
    );

    // 关键：`.resolves` 而不是 `.rejects`——拒绝就是 unhandledRejection，就是进程没了
    await expect(tick()).resolves.toBeUndefined();
    expect(heartbeat).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain("pump 抛错");
    expect(error.mock.calls[0]?.[0]).toContain("boom-pump");
  });

  it("成功路径：心跳前进一次，info 里带三个扫描的计数", async () => {
    const info = vi.fn();
    const heartbeat = vi.fn(async () => {});
    const tick = makeTick(fakeDeps({ heartbeat, log: { info, error: () => {} } }));

    await expect(tick()).resolves.toBeUndefined();
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toContain("outbox 扫 1");
    expect(info.mock.calls[0]?.[0]).toContain("规则 9 扫 3");
  });

  it("心跳写失败 ⇒ 仍是 resolve，且日志把两种红**分开说**（泵是好的）", async () => {
    const error = vi.fn();
    const tick = makeTick(
      fakeDeps({
        heartbeat: async () => {
          throw new Error("boom-heartbeat");
        },
        log: { info: () => {}, error },
      }),
    );

    await expect(tick()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain("心跳写入失败");
    expect(error.mock.calls[0]?.[0]).toContain("泵是好的");
  });
});

describe("前置件 3：真 croner 上的四项配置与不拒绝的回调", () => {
  it("四项配置都在，且回调抛错时 `trigger()` 也不拒绝", async () => {
    const error = vi.fn();
    const job = startTimer(
      fakeDeps({
        pump: async () => {
          throw new Error("boom-in-croner");
        },
        log: { info: () => {}, error },
      }),
    );
    try {
      expect(job.getPattern()).toBe("*/5 * * * *");
      expect(job.options.timezone).toBe(BUSINESS_TIMEZONE);
      expect(job.options.unref).toBe(true);
      expect(typeof job.options.protect).toBe("function");
      expect(typeof job.options.catch).toBe("function");

      // 手动触发走的是同一个回调（`src/croner.ts:560-562`）——它必须 resolve
      await expect(job.trigger()).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]?.[0]).toContain("boom-in-croner");
      // tick 内部那层兜底接住了 ⇒ croner 自己的 catch（前置件 3d 的告警）**不该**被触发
      expect(error.mock.calls[0]?.[0]).not.toContain("croner 的 catch 被触发");
    } finally {
      job.stop();
    }
  });

  it("`protect` 用函数形态：丢轮那一刻**真的**会被调用（丢轮的唯一写入方）", () => {
    const error = vi.fn();
    const onOverrun = makeOnOverrun({ info: () => {}, error });
    onOverrun();
    onOverrun();
    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[1]?.[0]).toContain("累计 2 次");
    // 措辞里必须点明处置方向：丢轮 ≠ 停摆
    expect(error.mock.calls[1]?.[0]).toContain("不是定时器没起来");
  });
});

/**
 * 启动期的密钥自检（MATT-36 决策第 4 项）。
 *
 * ## 为什么它必须在 `registerNode()` 里而不是「第一次用到加密时」
 *
 * 缺 `MN_AES_KEY` 的真实形态**不是**报错，而是：应用照常起来、界面照常显示，
 * 直到某个人第一次打开当事人详情页才 500。在那之前**没有任何一处会报错**。
 * `field-crypto.ts` 的文件头把这条叫「静默降级」，并写明它最贵的地方在于
 * 「无法事后区分哪些行是密文、哪些是明文」—— 所以自检要抢在 ready 之前。
 *
 * ## 为什么每条用例都要 `vi.resetModules()`
 *
 * `aesKey()` / `hmacKey()` / `pepper()` 都是**模块级缓存**（见收紧第 2 项）。
 * 于是删掉 env 之后再调自检会命中缓存 ⇒ **不抛** ⇒ 测试假绿，
 * 而且它假绿的方式与「自检根本没生效」一模一样。
 * 每条用例重新 import 一次，拿的是缓存-cold 的模块实例。
 */
describe("启动期密钥自检：缺任何一把都在 ready 之前抛", () => {
  const KEYS = ["MN_AES_KEY", "MN_HMAC_KEY", "MN_SESSION_PEPPER"] as const;
  /**
   * 三个**互不相同**的合法 32 字节值（`parseKeyMaterial` 认的 base64url 形状）。
   *
   * ⚠ 必须三个不同：自检里有「三把互不相同」那一条，而这条测试写出来时
   * 三处都用了同一个 `GOOD` —— 立刻被自检判红。留着这条注释，
   * 下一个人加用例时不必重新踩一遍。
   */
  const AES = Buffer.alloc(32, 1).toString("base64url");
  const HMAC = Buffer.alloc(32, 2).toString("base64url");
  const PEPPER = Buffer.alloc(32, 3).toString("base64url");
  const ALL = { MN_AES_KEY: AES, MN_HMAC_KEY: HMAC, MN_SESSION_PEPPER: PEPPER };

  async function selfCheckWith(env: Partial<Record<(typeof KEYS)[number], string>>) {
    const saved = new Map(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(env)) process.env[k as string] = v;
    vi.resetModules();
    try {
      const mod = await import("./instrumentation-node");
      return mod.assertServerSecretsConfigured();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      vi.resetModules();
    }
  }

  it("三把都在且互不相同 ⇒ 自检通过（先证明这条不是恒红）", async () => {
    // `.resolves` 而不是 `.not.toThrow()`：后者收的是**函数**，给 Promise 会静默通过
    await expect(selfCheckWith(ALL)).resolves.toBeUndefined();
  });

  it("缺 MN_AES_KEY ⇒ 抛，且消息点名这一个变量", async () => {
    await expect(selfCheckWith({ MN_HMAC_KEY: HMAC, MN_SESSION_PEPPER: PEPPER })).rejects.toThrow(
      /MN_AES_KEY/,
    );
  });

  it("缺 MN_HMAC_KEY ⇒ 抛", async () => {
    await expect(selfCheckWith({ MN_AES_KEY: AES, MN_SESSION_PEPPER: PEPPER })).rejects.toThrow(
      /MN_HMAC_KEY/,
    );
  });

  it("缺 MN_SESSION_PEPPER ⇒ 也抛（**三把都要在**，不只是字段加密那两把）", async () => {
    await expect(selfCheckWith({ MN_AES_KEY: AES, MN_HMAC_KEY: HMAC })).rejects.toThrow(
      /MN_SESSION_PEPPER/,
    );
  });

  /**
   * 三把填成同一个值 ⇒ **静默通过**（实测：`assertFieldCryptoConfigured()` 只各读一次，
   * `parseKeyMaterial` 只管长度与字符集，没有任何一处比较过它们）。
   *
   * 这直接违反 NIST SP 800-57 Pt1 R5 §5.2 的 `shall`：「a single key shall be used
   * for only one purpose」，理由之二就是「限制一把钥匙的用途，就限制了它失陷时的爆炸面」。
   * 而三把共用一把 ⇒ 拿到它的人一次就同时拿到「解密全部 PII」与「伪造任意会话」。
   *
   * 这条也是 MATT-36 决策第 4 项里 CI 改造的**动因**：CI 的
   * `MN_AES_KEY` / `MN_HMAC_KEY` 兜底值逐字相同（两个 64 个 0），
   * 所以「加这条断言」与「CI 改运行时生成」必须同时做，否则 CI 自己起不来。
   */
  it("三把逐字相同 ⇒ 抛（NIST §5.2 的 shall：一条 key 只做一个用途）", async () => {
    await expect(
      selfCheckWith({ MN_AES_KEY: AES, MN_HMAC_KEY: AES, MN_SESSION_PEPPER: AES }),
    ).rejects.toThrow(/同一把/);
  });

  /**
   * 逐字比较会漏掉的形态：AES 写成 hex、HMAC 写成同一把的 base64url。
   * 所以自检比的是**解析后的 32 字节**，不是字符串。
   */
  it("同一把的不同写法（hex vs base64url）⇒ 也抛", async () => {
    const bytes = Buffer.alloc(32, 4);
    await expect(
      selfCheckWith({
        MN_AES_KEY: bytes.toString("hex"),
        MN_HMAC_KEY: bytes.toString("base64url"),
        MN_SESSION_PEPPER: PEPPER,
      }),
    ).rejects.toThrow(/同一把/);
  });

  it("pepper 长度不对 ⇒ 抛（此前它是三把里唯一只查「非空」的）", async () => {
    await expect(
      selfCheckWith({ MN_AES_KEY: AES, MN_HMAC_KEY: HMAC, MN_SESSION_PEPPER: "x" }),
    ).rejects.toThrow(/MN_SESSION_PEPPER/);
  });

  /**
   * 自检必须在 `startTimer()` **之前**。
   *
   * 顺序反了不会立刻出事，但会留下一条更难查的形态：定时器已经起来、心跳在推进、
   * 只有自检那一行还没执行 —— 于是「密钥缺失」这件事被推迟到某个请求上，
   * 而那时候进程日志里已经有「定时器已启动」这几行，读的人会先怀疑定时器。
   */
  it("`registerNode()` 里自检排在 `startTimer()` 之前（顺序不能被后人挪反）", () => {
    const src = readFileSync(new URL("./instrumentation-node.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("export function registerNode()"));
    const checkAt = body.indexOf("assertServerSecretsConfigured()");
    const startAt = body.indexOf("startTimer()");
    expect(checkAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(startAt);
  });
});

describe("入口 `src/instrumentation.ts` 的形态（前置件 1 + Edge 编译的前提）", () => {
  const entry = readFileSync(new URL("./instrumentation.ts", import.meta.url), "utf8");

  it("**没有任何静态 import** —— 否则 Edge 那一份 instrumentation 编译会把 Node 模块拖进来", () => {
    // 本轮实测的形态：静态 import 会让 Next 的 Edge instrumentation 编译报
    // 「A Node.js module is loaded ('node:crypto')」+「Ecmascript file had an error」。
    // 这条断言把它变成一句人话（而不是启动日志里一段 import trace）。
    const statics = entry.match(/^\s*import\s/gm) ?? [];
    expect(statics).toHaveLength(0);
    expect(entry).toContain(`require("./instrumentation-node")`);
  });

  it("register 是同步声明（因此**不可能** await 任何东西）", () => {
    // 同步函数里出现 `await` 是编译错误 ⇒ 两条一起把前置件 1 钉死
    expect(entry).toContain("export function register(): void {");
    expect(entry).not.toContain("export async function register");
  });
});
