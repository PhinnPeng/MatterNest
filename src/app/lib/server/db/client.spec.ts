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
