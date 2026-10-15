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

  it("幂等：角色已存在时跳过 create，但**属性仍然收回来** —— 否则承诺依赖历史状态", () => {
    const fresh = provisionSql({ ...args, roleExists: false })
      .map((s) => s.text)
      .join("\n");
    const exists = provisionSql({ ...args, roleExists: true })
      .map((s) => s.text)
      .join("\n");

    // create 只在「角色不在」时发 —— 重跑不该因 42710 duplicate_role 而炸
    expect(fresh).toMatch(/format\('create role %I/);
    expect(exists).not.toMatch(/format\('create role %I/);
    // 而 alter 两边都发：镜像重建过、或有人手工抬过权限时，它把承诺收回来
    for (const t of [fresh, exists]) {
      expect(t).toMatch(
        /format\('alter role %I login password %L nosuperuser nocreatedb nocreaterole/,
      );
    }
  });

  /**
   * 早先这里写的是 `do $$ … if not exists (select 1 from pg_roles where rolname = $1) … $$;`。
   *
   * 它在**真库上直接报错**：`could not determine data type of parameter $1` ——
   * DO 块的体是函数体，`$1` 被 PL/pgSQL 当成函数参数，而这个函数没有参数。
   *
   * 16 条离线判据当时全绿，因为它们只看 SQL 文本。**这正是「文本断言盖不住真库才暴露的
   * 语义错误」的一个实例**，所以现在加一条结构断言把形态钉住。
   */
  /**
   * 这是**同一个坑的第二半**，而两次的离线判据都是全绿的。
   *
   * · 第一半：`do $ … $1 … $` —— DO 块的体是函数体，$1 被 PL/pgSQL 当成**函数参数**，
   *   而那个函数没有参数 ⇒ `could not determine data type of parameter $1`。
   * · 第二半（本条）：`format('…', $1, $2)` —— `format` 的签名是
   *   `format(text, VARIADIC "any")`，变长参数类型是 `any`，
   *   而 PG **无法**为无类型标注的占位符推断 `any` ⇒ **同一个报错**。
   *
   * 两次都是：文本断言全绿、CI 真库上直接报错。所以这里断言的不只是「文本里有 ::text」，
   * 而是**「每一条会发出去的 SQL 里，不存在没有类型标注的占位符」**。
   */
  it("**每条 SQL 里的占位符都带类型标注**（format 是 VARIADIC any，无标注必报「无法确定参数类型」）", () => {
    const sts = provisionSql(args);
    const bad = [];
    for (const s of sts) {
      // 去掉注释里的 $n 之后再找真正会发出去的占位符
      const code = s.text.replace(/\$1|\$2/g, (m) => m);
      for (const m of code.matchAll(/\$(\d+)(?!::)/g)) {
        // 允许 $n 紧跟 ) 或 , 之外的一切 —— 这里只报「后面没跟 ::」的
        bad.push(`${s.text.slice(0, 60)}… 的 ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
    // 且至少要真的用到占位符 —— 否则这条断言会像「扫到 0 处 ⇒ 假绿」那样空转
    expect(sts.some((s) => /\$\d+::text/.test(s.text))).toBe(true);
  });

  it("**不得**再出现 DO 块（它的 $1 是函数参数引用，在真库上必报「无法确定参数类型」）", () => {
    expect(all()).not.toMatch(/\bdo\s+\$\$/i);
  });

  it("凡是要在真库上执行的语句，都标了 `exec: true`（先 format、再执行它返回的 stmt）", () => {
    const sts = provisionSql(args);
    const needsExec = sts.filter((s) => s.text.includes("format("));
    expect(needsExec.length).toBeGreaterThan(0);
    for (const s of needsExec) expect(s.exec).toBe(true);
    // 而那两条 ALTER 是直接发的，不该被再执行一遍
    for (const s of sts.filter((x) => /alter (database|schema)/.test(x.text))) {
      expect(s.exec).toBeUndefined();
    }
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
