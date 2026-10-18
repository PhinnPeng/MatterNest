import { describe, expect, it } from "vitest";
import {
  CONFIG_GROUPS,
  CONFIG_KINDS,
  CONFIG_KIND_LABELS,
  CONFIG_KIND_META,
  ENUM_CONFIG_KINDS,
  NO_ENTITY_CONFIG_KINDS,
  WRITABLE_CONFIG_KINDS,
  configCreateSchema,
  configItemSchema,
  configKindFromParam,
  configKindPath,
  configUpdateBodySchema,
  configUpdateSchema,
  isConfigKind,
  isWritableConfigKind,
} from "./config";

/**
 * 14 个细项的分档与字段 —— MATT-101 票面「14 细项三档」那条的**机器可核对形态**。
 *
 * ## 这一组断言的存在理由
 *
 * "页面比接口宽"是勘误第 8 条的核心裁定：`[kind]` 的合法值 = 14，接口只认 5 个。
 * 这两套值域一旦被收成一套（比如后来者觉得"14 个都建了页面、接口也该都覆盖"），
 * 7 个闭集枚举与 2 个无承载项就会冒出**能写但写不动**的接口 —— 而失败形态是静默的：
 * 页面能打开、按钮能点，提交时才 400。所以这里把两套值域钉死，并且钉住"14 = 5 + 7 + 2"。
 *
 * ## 为什么字段能力也要断言
 *
 * `configCreateSchema("tag")` 与 `configCreateSchema("risk_level")` 必须长得**不一样**
 * （标签没有 code，风险等级没有 color）—— 这是一条容易被"统一一个 create schema"抹平的差异。
 * 抹平之后，给标签塞 `code` 会被 zod 静默剥离（若没 `.strict()`）或落库报"列不存在"，
 * 两种都不好在联调时看出来。
 */

describe("kind 的三套值域", () => {
  it("14 个细项 = 5 可写 + 7 闭集枚举 + 2 无承载，三块互斥且覆盖全集", () => {
    expect(CONFIG_KINDS.length).toBe(14);
    expect(WRITABLE_CONFIG_KINDS.length).toBe(5);
    expect(ENUM_CONFIG_KINDS.length).toBe(7);
    expect(NO_ENTITY_CONFIG_KINDS.length).toBe(2);

    const union = [...WRITABLE_CONFIG_KINDS, ...ENUM_CONFIG_KINDS, ...NO_ENTITY_CONFIG_KINDS];
    expect(new Set(union).size, "三块有重叠").toBe(14);
    expect([...union].sort()).toEqual([...CONFIG_KINDS].sort());
  });

  it("两个状态细项的 kind 名是 `case_status` / `item_status`（不是 `matter_status`）", () => {
    // 同住 `mn_status_config`，靠 host_type 分；一个 kind 名不能指两个宿主，
    // 否则 `[kind]` 表达不出宿主（这是规格勘误第 8 条落在命名上的后果）。
    expect(CONFIG_KINDS).toContain("case_status");
    expect(CONFIG_KINDS).toContain("item_status");
    expect(CONFIG_KINDS).not.toContain("matter_status");
    expect(CONFIG_KIND_META.case_status.host).toBe("matter");
    expect(CONFIG_KIND_META.item_status.host).toBe("risk_matter");
  });

  it("`isWritableConfigKind` 只认 5 个；闭集枚举与无承载都不是可写 kind", () => {
    for (const k of WRITABLE_CONFIG_KINDS) expect(isWritableConfigKind(k)).toBe(true);
    for (const k of ENUM_CONFIG_KINDS) expect(isWritableConfigKind(k)).toBe(false);
    for (const k of NO_ENTITY_CONFIG_KINDS) expect(isWritableConfigKind(k)).toBe(false);
    expect(isWritableConfigKind("matter_status")).toBe(false);
  });

  it("路由参数：14 个都合法，其余（含空/大写/别名）一律 null", () => {
    for (const k of CONFIG_KINDS) expect(configKindFromParam(k)).toBe(k);
    for (const bad of ["", "matter_status", "CASE_STATUS", "foo", "case-status"]) {
      expect(configKindFromParam(bad), `${bad} 不该是合法 kind`).toBeNull();
    }
    expect(configKindFromParam(undefined)).toBeNull();
    expect(isConfigKind("node_notify_time")).toBe(true);
    expect(isConfigKind("nope")).toBe(false);
  });
});

describe("入口页五张卡片", () => {
  it("五组覆盖全部 14 个细项，一个不漏一个不重", () => {
    const listed = CONFIG_GROUPS.flatMap((g) => g.kinds);
    expect(listed.length).toBe(14);
    expect(new Set(listed).size).toBe(14);
    expect([...listed].sort()).toEqual([...CONFIG_KINDS].sort());
    expect(CONFIG_GROUPS.map((g) => g.label)).toEqual([
      "事项配置",
      "案件配置",
      "当事人配置",
      "风险配置",
      "通知配置",
    ]);
  });

  it("每个细项都有中文名（页面上不出现英文 kind）", () => {
    for (const k of CONFIG_KINDS) {
      expect(CONFIG_KIND_LABELS[k], `${k} 缺中文名`).toBeTruthy();
      expect(CONFIG_KIND_META[k].label).toBe(CONFIG_KIND_LABELS[k]);
    }
  });

  it("细项页地址就是 `/config/<kind>`", () => {
    expect(configKindPath("case_status")).toBe("/config/case_status");
    expect(configKindPath("node_notify_time")).toBe("/config/node_notify_time");
  });
});

describe("字段能力按细项裁剪（不是一份通用 schema）", () => {
  it("标签没有 code 列 ⇒ 给 code 的请求被 `.strict()` 拒（不是静默剥离）", () => {
    const tagOk = configCreateSchema("tag").safeParse({ name: "涉外" });
    expect(tagOk.success).toBe(true);
    const tagWithCode = configCreateSchema("tag").safeParse({ name: "涉外", code: "foreign" });
    expect(tagWithCode.success, "标签页不该收 code —— 那一列在 mn_tag 里不存在").toBe(false);
  });

  it("状态细项收 code 与 color（两列都在 mn_status_config 里）", () => {
    const r = configCreateSchema("case_status").safeParse({
      name: "已撤诉",
      code: "withdrawn",
      color: "gray",
    });
    expect(r.success).toBe(true);
  });

  it("风险等级没有 color 列 ⇒ 给 color 的请求被拒", () => {
    const bad = configCreateSchema("risk_level").safeParse({ name: "高", code: "high", color: "red" });
    expect(bad.success).toBe(false);
  });

  it("新增**不接受 semantics**（新建状态只能给 custom，由服务层写死）", () => {
    const withSemantics = configCreateSchema("case_status").safeParse({
      name: "自定义态",
      code: "custom_x",
      semantics: "closed",
    });
    expect(withSemantics.success, "semantics 不在新增入参里").toBe(false);
    // 编辑才收（且只收 E09 的五个值）
    expect(configUpdateSchema("case_status").safeParse({ semantics: "closed" }).success).toBe(true);
    expect(configUpdateSchema("case_status").safeParse({ semantics: "wat" }).success).toBe(false);
    // 无语义列的细项连编辑也不收
    expect(configUpdateSchema("risk_level").safeParse({ semantics: "closed" }).success).toBe(false);
  });

  it("编码按库里的小写形态校验（不是原型画的大写）", () => {
    expect(configCreateSchema("case_status").safeParse({ name: "x", code: "in_progress" }).success).toBe(
      true,
    );
    for (const bad of ["FILED", "in-progress", "9start", "", "有中文"]) {
      expect(
        configCreateSchema("case_status").safeParse({ name: "x", code: bad }).success,
        `${bad} 不该通过编码校验`,
      ).toBe(false);
    }
  });
});

describe("更新请求体带 id 且不含 code", () => {
  it("`configUpdateBodySchema` 收 id + 字段；给 code 被拒（code 创建后不可改）", () => {
    const ok = configUpdateBodySchema("case_status").safeParse({ id: "3", name: "已结案" });
    expect(ok.success).toBe(true);
    const withCode = configUpdateBodySchema("case_status").safeParse({
      id: "3",
      name: "已结案",
      code: "closed",
    });
    expect(withCode.success, "code 是不可改的引用键 —— 更新 schema 里不该有它").toBe(false);
  });

  it("id 必须匹配路径 id 同款形态（数字字符串，上界 19 位）", () => {
    const s = configUpdateBodySchema("risk_level");
    expect(s.safeParse({ id: "3001" }).success).toBe(true);
    expect(s.safeParse({ id: "abc" }).success).toBe(false);
    expect(s.safeParse({ id: "9".repeat(20) }).success).toBe(false);
  });
});

describe("响应行形状", () => {
  it("`configItemSchema` 认一行完整形状（标签行 code/semantics 为 null，hostType 有值）", () => {
    const tagRow = {
      id: "5001",
      code: null,
      name: "建设工程",
      color: "cobalt",
      sortOrder: 1,
      isEnabled: true,
      semantics: null,
      isInitialStatus: false,
      isSystem: true,
      hostType: "matter",
    };
    expect(configItemSchema.safeParse(tagRow).success).toBe(true);
    const statusRow = {
      id: "1",
      code: "pending",
      name: "已登记",
      color: "slate",
      sortOrder: 1,
      isEnabled: true,
      semantics: "open",
      isInitialStatus: true,
      isSystem: true,
      hostType: null,
    };
    expect(configItemSchema.safeParse(statusRow).success).toBe(true);
  });
});
