import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSessionConventions, closeDb, getDb } from "./client";

/**
 * 连接层的两条离线断言（`pnpm verify` 不许连库，所以这里全是假池）。
 *
 * 为什么值得测：会话时区/编码一旦不对，**不会当场出错**——只会在跨零点那一刻把编号与期限
 * 算到前一天（修订稿 §12.3 实测）。所以"启动断言"本身必须被证明会抛，而不是写着好看。
 */
type FakePool = Parameters<typeof assertSessionConventions>[0];

function poolReturning(tz: string, enc: string): FakePool {
  const tag = async () => [{ tz, enc }];
  // postgres.js 的池是"标签模板函数"，所以假池也得能这样调
  return tag as unknown as FakePool;
}

describe("db/client：启动断言", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("时区 UTC + UTF8 时放行", async () => {
    await expect(assertSessionConventions(poolReturning("UTC", "UTF8"))).resolves.toBe(true);
  });

  it("服务端默认 PRC（共享机实测值）时必须抛，而不是静默按 +08 跑", async () => {
    await expect(assertSessionConventions(poolReturning("PRC", "UTF8"))).rejects.toThrow(
      /会话时区不是 UTC（拿到 PRC）/,
    );
  });

  it("编码非 UTF8 也要抛（中文与全文检索的前提）", async () => {
    await expect(assertSessionConventions(poolReturning("UTC", "SQL_ASCII"))).rejects.toThrow(
      /client_encoding 不是 UTF8/,
    );
  });

  it("缺 PG* 时是配置错误，不是连不上：报的是该复制 .env.example", async () => {
    vi.stubEnv("PGHOST", "");
    vi.stubEnv("PGDATABASE", "");
    vi.stubEnv("PGUSER", "");
    await closeDb();
    await expect(getDb()).rejects.toThrow(/缺 PGHOST\/PGDATABASE\/PGUSER/);
  });

  it("大小写不敏感：`utc` 也算通过（PG 的 SHOW 值在不同版本大小写不一）", async () => {
    await expect(assertSessionConventions(poolReturning("utc", "utf8"))).resolves.toBe(true);
  });
});

/**
 * 「断言失败不许被缓存」——这条守的是一个**进程级永久钉死**的缺陷。
 *
 * `getDb()` 缓存 `asserted` 是为了让并发请求只测一回，但**promise 会把失败也缓存住**：
 * 一次瞬时断连（共享 dev 机的端口映射一抖）让断言失败之后，那个 rejected promise 会永久留在
 * `asserted` 上，之后每个请求都 await 到同一个失败 ⇒ 进程从此 500，哪怕库早就恢复。
 *
 * 症状是"跑着跑着所有接口都 500，重启 dev server 就好"——而重启**掩盖了根因**。
 * 本轮实测反复重启了三次才定位到这一行，所以必须有断言钉着，不能靠下次记得。
 *
 * ⚠ 假池必须走 `vi.mock`（模块级）：ESM 的 default 导出不可 spy
 * （`Module namespace is not configurable in ESM`）。`vi.hoisted` 是为了让工厂能引用到
 * 可变容器——`vi.mock` 的工厂会被提升到 import 之前。
 */
const h = vi.hoisted(() => ({ pool: undefined as unknown }));
vi.mock("postgres", () => ({ default: () => h.pool }));

describe("db/client：断言失败不被缓存（瞬时断连不许把进程钉死）", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeDb();
  });

  it("第一次断言失败 → 抛；下一次请求会**重跑断言**（失败的 promise 不被永久缓存）", async () => {
    vi.stubEnv("PGHOST", "127.0.0.1");
    vi.stubEnv("PGDATABASE", "fake");
    vi.stubEnv("PGUSER", "fake");
    await closeDb();

    let calls = 0;
    const flaky = Object.assign(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("write CONNECT_TIMEOUT 127.0.0.1:30432");
        return [{ tz: "UTC", enc: "UTF8" }];
      },
      { end: async () => {} },
    );
    h.pool = flaky;

    await expect(getDb()).rejects.toThrow(/CONNECT_TIMEOUT/);

    /**
     * 第二次调用：**断言会重新跑一遍**（`calls` 从 1 变 2）——这正是这条修复要保证的事。
     *
     * ⚠ 它仍然会 reject，但原因是**假池不完整**：断言通过之后 `drizzle(pool, …)` 会去读
     * 真 postgres.js 客户端上才有的属性（`parsers` 之类）。所以这里只断言"断言被重跑了"，
     * 不断言"整个 getDb 成功"——后者需要造一个完整到能骗过 drizzle 的假池，
     * 而那是另一个测试的活（真池的路径由真 HTTP 冒烟覆盖）。
     */
    await expect(getDb()).rejects.toThrow();
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
