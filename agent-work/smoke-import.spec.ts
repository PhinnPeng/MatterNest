import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * 冒烟脚本的**进程契约**（MATT-88）。
 *
 * ## 要钉的是什么
 *
 * `agent-work/smoke-import.mjs:43` 曾经这么读本企业名：
 *
 * ```js
 * const OWN_COMPANY = (process.env.MN_OWN_COMPANY_NAMES ?? "").split(",")[0]?.trim() ?? "";
 * ```
 *
 * `?? ""` 把「没配」与「配了空串」压成了同一件事，于是变量缺失时：
 *
 * · 夹具行 `{ 对方当事人: OWN_COMPANY }` 变成「对方当事人为空」——
 *   而这一行正是 IQ-7「我方永不入当事人表」那条防呆用例的输入；
 * · 脚本**照常**跑完全部断言，红或绿取决于数据，而不取决于配置对不对。
 *
 * 2026-10-15 CI 上就是这样红的：`17 脚本 · 失败 8 · 断言 443 通过 / 21 失败`，
 * 而根因只是 CI 少注入一个环境变量。**一个部署事实的缺失，伪装成了一堆断言失败。**
 *
 * ## 为什么 seam 是「进程契约」而不是内部函数
 *
 * 能观察到的行为全在进程边界上：退出码、stderr 说了什么、stdout 里有没有断言行。
 * 里面的夹具拼装是实现细节，重构就会碎，而契约不会。
 *
 * 同仓已有一份正确写法可抄：`smoke-parties.mjs:72-78` 的守卫（退出码 3 = 环境不对；
 * 2 已经专留给「清场失败」，见 `_testacct.mjs`）。
 */

/** 被测脚本。刻意不给任何 PG* 环境变量 —— 见下面那条 canary 的说明。 */
const SCRIPT = "agent-work/smoke-import.mjs";

/**
 * 跑一次，把 `MN_OWN_COMPANY_NAMES` 从环境里摘掉。
 *
 * ⚠ 刻意**不**给 PG* 变量：那样脚本也可能因为「数据库连不上」而 exit 3（它本来就有那个守卫），
 * 于是这条测试会**因为错的原因**而绿 —— 和当初那条「过在错误的原因上」的用例同一类毛病。
 * 所以下面除了退出码，还必须断言**消息指向哪个变量**。
 */
const runWithoutOwnCompany = () => {
  const env = { ...process.env };
  delete env.MN_OWN_COMPANY_NAMES;
  delete env.PGHOST;
  delete env.PGDATABASE;
  delete env.PGUSER;
  delete env.PGPASSWORD;
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env, timeout: 60_000 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};

const ASSERTION_LINE = /^\s*\[( ok |FAIL)\]/;

describe("smoke-import.mjs：部署事实缺失时必须停下来，而不是带着错误前提跑完", () => {
  it("缺 MN_OWN_COMPANY_NAMES ⇒ 退出码 3（环境不对，不是清场失败）", () => {
    const r = runWithoutOwnCompany();
    // 2 已被「清场失败」占用、1 是断言失败 —— 用错码会让 run-smokes.mjs 归错类
    expect(r.code).toBe(3);
  });

  it("消息**点名 MN_OWN_COMPANY_NAMES**，且说清怎么配", () => {
    const r = runWithoutOwnCompany();
    expect(r.err).toContain("MN_OWN_COMPANY_NAMES");
    // 得能照着做：只说「缺」不给写法的，等于把猜谜留给值班的人
    expect(r.err).toMatch(/MN_OWN_COMPANY_NAMES=/);
  });

  it("**不是**因为数据库连不上而退出（否则这条测试会因为错的原因而绿）", () => {
    const r = runWithoutOwnCompany();
    expect(r.err).not.toContain("数据库连不上");
    expect(r.err).not.toContain("隧道");
  });

  /**
   * 这一条是整组测试的核心：**一条断言都不许产出**。
   *
   * 只查退出码不够 —— 脚本完全可以在报错退出**之前**已经跑了几条断言，
   * 那几条的红是真的（数据没配好），可它们的前提是错的，读的人不会知道。
   */
  it("**一条断言行都不许有**（不许带着空前提跑完再退出）", () => {
    const r = runWithoutOwnCompany();
    const lines = `${r.out}\n${r.err}`
      .split(/\r?\n/)
      .filter((l) => ASSERTION_LINE.test(l));
    expect(lines).toEqual([]);
  });
});