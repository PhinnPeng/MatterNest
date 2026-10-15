import { describe, expect, it } from "vitest";
import { APP_ROLE_MUST, DEFAULT_ROLE, provisionSql, quoteIdent } from "./ci-provision-role.mjs";

/**
 * CI 角色分权（MATT-87）的离线判据。
 *
 * ## 为什么 seam 在「SQL 文本」而不是「跑一次 CI」
 *
 * 真正的风险有两条，都不需要连库就能钉：
 *   1. **交出去的还是超级用户** —— 那等于什么都没改，而 CI 要几分钟后才在 C3 上发现。
 *   2. **口令以字面量形式出现在 SQL 文本里** —— 那么它会进日志、进 `pg_stat_activity`、
 *      进任何一次异常回显，而 MATT-36 的裁定是三把密钥「不入库 / 不进镜像 / 不进 git」。
 *      数据库口令是同一类东西。
 *
 * 连库的部分（`--check` 的复核查询）反过来**不能**在这里测：`pnpm test` 跑在
 * 「还没建库」的那一步，本仓的单测从不依赖一个活着的数据库（这是既有纪律）。
 * 所以那部分由 CI 自己在流水线里跑，并且失败即红。
 */

const args = { database: "dev_matternest", role: DEFAULT_ROLE, password: "p@ss-w0rd-xyz" };
const all = () =>
  provisionSql(args)
    .map((s) => s.text)
    .join("\n");

describe("quoteIdent：DDL 目标只能拼，所以必须自己把关", () => {
  it("只认小写开头的字母/下划线 + 数字", () => {
    expect(quoteIdent("mn_app")).toBe('"mn_app"');
    expect(quoteIdent("_x1")).toBe('"_x1"');
  });

  // 这些都是能拼进 `ALTER DATABASE … OWNER TO …` 的注入面
  it.each(['mn_app"; drop database prod; --', "MN_APP", "1app", "mn-app", "mn app", "mn_app;drop"])(
    "**拒绝** %j",
    (bad) => {
      expect(() => quoteIdent(bad)).toThrow(/不合法/);
    },
  );

  it("拒绝的理由写明是「拒绝」而不是「转义」——免得后人以为它 sanitize 过", () => {
    expect(() => quoteIdent('x";y')).toThrow(/拒绝.*不是转义|拒绝\*\*而不是转义/s);
  });
});

describe("provisionSql：交出去的角色必须是非超级用户", () => {
  it("创建语句**逐字**带 nosuperuser / nocreatedb / nocreaterole", () => {
    const t = all();
    // 拼错任何一个，C3 在几分钟后才红 —— 这里必须当场钉住
    expect(t).toMatch(/nosuperuser/);
    expect(t).toMatch(/nocreatedb/);
    expect(t).toMatch(/nocreaterole/);
    // login 要有，否则角色建出来连不上，流水线会以一条无关的连接错收场
    expect(t).toMatch(/login/);
  });

  it("**口令走参数位，不进 SQL 文本**（否则它会出现在日志与 pg_stat_activity 里）", () => {
    const stmts = provisionSql(args);
    expect(stmts.some((s) => s.text.includes(args.password))).toBe(false);
    // 且口令确实被当参数传下去了
    expect(stmts.some((s) => s.params.includes(args.password))).toBe(true);
  });

  it("库属主与 `public` schema 属主**两处都**转给新角色", () => {
    const t = all();
    expect(t).toMatch(/alter database "dev_matternest" owner to "mn_app"/i);
    // `public` 是显式改的：PG15+ 的 pg_database_owner 伪角色默认在本项目不成立
    // （本地那个库的 public 属主是真角色 oid 535384），不能假设改库属主就够
    expect(t).toMatch(/alter schema public owner to "mn_app"/i);
  });

  it("**没有空口令**：不给口令就拒跑（空口令的可登录角色比超级用户还糟）", () => {
    expect(() => provisionSql({ ...args, password: "" })).toThrow(/必填/);
    expect(() => provisionSql({ ...args, password: undefined })).toThrow(/必填/);
  });

  it("口令里带引号也不破 SQL —— 走 %L，由服务端转义", () => {
    const pw = `a'b"c\\d`;
    const stmts = provisionSql({ ...args, password: pw });
    expect(stmts.some((s) => s.text.includes(pw))).toBe(false);
    expect(stmts.some((s) => s.params.includes(pw))).toBe(true);
    // DO 块里用的是 format('%L') 而不是把值拼进去
    expect(all()).toMatch(/format\('create role %I login password %L/);
  });

  it("幂等：角色已存在时**把属性收回来**，而不是跳过 —— 否则承诺依赖历史状态", () => {
    const t = all();
    expect(t).toMatch(/if not exists \(select 1 from pg_roles where rolname = \$1\)/i);
    expect(t).toMatch(/alter role %I nosuperuser nocreatedb nocreaterole login/i);
  });
});

describe("APP_ROLE_MUST：这份清单就是 C3 的提前版", () => {
  it("**不含**任何超级用户/建库/建角色的能力", () => {
    expect(APP_ROLE_MUST.rolsuper).toBe(false);
    expect(APP_ROLE_MUST.rolcreatedb).toBe(false);
    expect(APP_ROLE_MUST.rolcreaterole).toBe(false);
  });

  it("要求它是库属主 + 在 `public` 上有 CREATE —— 与本地姿态一致", () => {
    // 姿态来自 docs/research-ci-role-privileges.md 的实测，不是猜的
    expect(APP_ROLE_MUST.ownsDatabase).toBe(true);
    expect(APP_ROLE_MUST.canCreateInPublic).toBe(true);
  });
});
