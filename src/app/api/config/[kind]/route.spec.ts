import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PATCH, POST } from "./route";
import type { Actor } from "@/app/lib/server/auth/auth";

/**
 * `/api/config/[kind]` 的行为门（MATT-101）。
 *
 * ## 本门钉的四件事（票面验收逐条）
 *
 *   ① **非 `canManageConfig` → 403**（写路径）；读路径登录即可（与 `/api/meta` 同档）；
 *   ② **闭集枚举 / 无承载的 kind → 400 `not_writable`**（不是 404：404 是"不可见或不存在"，
 *      而"这个 kind 不支持写"是请求不合法 —— 见 route.ts 头注）；
 *   ③ **合法 kind 能增 / 改 / 启停**（走服务层，响应形状对）；
 *   ④ **停用被规则引用的状态被拒**（服务层给 `rule_referenced`，本层翻成 422）。
 *
 * ## 为什么有时只断言"没走到服务层"
 *
 * 权限门（①）与 kind 校验（②）都在**调服务层之前**。若把它们写成"服务层返回了才拒"，
 * 那么一个没权限的 PATCH 会先把请求体解析、再进服务层、再拒 —— 副作用面大得多。
 * 所以 ②③ 的负例除了状态码，还要断言**服务层没被调用**（反向红锚点：
 * 把 resolveKind 挪到 withActor 之后，这条会红）。
 *
 * ⚠ 服务层整体 mock（先例：`api/roles/route.spec.ts`）。真正的三条硬约束判定在
 * `services/config.spec.ts`（纯函数）与 DB 的 partial unique index（迁移）两层，
 * 本门不重复。
 */
const { listConfigItems, createConfigItem, updateConfigItem, readActor } = vi.hoisted(() => ({
  listConfigItems: vi.fn(),
  createConfigItem: vi.fn(),
  updateConfigItem: vi.fn(),
  readActor: vi.fn(),
}));

vi.mock("@/app/lib/server/services/config", () => ({
  listConfigItems,
  createConfigItem,
  updateConfigItem,
}));
vi.mock("@/app/lib/server/auth/auth", () => ({ readActor }));

const actorWith = (canManageConfig: boolean): Actor => ({
  userId: "9001",
  displayName: "冒烟账号",
  dataScope: "all",
  isAdmin: false,
  isSystemOwner: false,
  privileges: {
    canUnarchive: false,
    canReadPlain: false,
    canManageUser: false,
    canManageConfig,
  },
});

const ROW = {
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

/** 造一个 `[kind]` 段的 Request + ctx */
const req = (method: string, body?: unknown) =>
  new Request(`http://test/api/config/case_status`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
const ctx = (kind: string) => ({ params: Promise.resolve({ kind }) });

beforeEach(() => {
  readActor.mockResolvedValue(actorWith(true));
  listConfigItems.mockResolvedValue([ROW]);
  createConfigItem.mockResolvedValue({ ok: true, id: "42" });
  updateConfigItem.mockResolvedValue({ ok: true, id: "1" });
});
afterEach(() => vi.clearAllMocks());

describe("GET：读配置登录即可（与 /api/meta 同档）", () => {
  it("200，透出 { kind, items }", async () => {
    const res = await GET(req("GET"), ctx("case_status"));
    expect(res.status).toBe(200);
    const b = (await res.json()) as { kind: string; items: typeof ROW[] };
    expect(b.kind).toBe("case_status");
    expect(b.items).toEqual([ROW]);
  });

  it("未登录 ⇒ 401（不给「匿名能读配置表」这种口子）", async () => {
    readActor.mockResolvedValue(null);
    const res = await GET(req("GET"), ctx("case_status"));
    expect(res.status).toBe(401);
    expect(listConfigItems).not.toHaveBeenCalled();
  });

  it("闭集枚举 kind 的 GET 也是 400（界面用页面直写事实，不经接口）", async () => {
    const res = await GET(req("GET"), ctx("case_type"));
    expect(res.status).toBe(400);
    expect(listConfigItems).not.toHaveBeenCalled();
  });
});

describe("kind 校验：只收 5 个可写细项，其余 400 not_writable", () => {
  it("7 个闭集枚举 + 2 个无承载 + 非法串，全部 400 且**不进服务层**", async () => {
    for (const bad of [
      "case_type",
      "procedure",
      "party_type",
      "id_type",
      "litigation_role",
      "risk_matter_type",
      "node_status",
      "node_notify_status",
      "node_notify_time",
      "matter_status",
      "foo",
    ]) {
      const res = await POST(req("POST", { name: "x", code: "y" }), ctx(bad));
      expect(res.status, `${bad} 应当是 400`).toBe(400);
      const b = (await res.json()) as { error: string };
      expect(b.error, `${bad} 的错误码不是 not_writable`).toBe("not_writable");
    }
    expect(createConfigItem).not.toHaveBeenCalled();
  });

  it("5 个可写细项都放行（走到服务层）", async () => {
    // 每个 kind 给**它自己的**合法形状：tag 没有 code 但有 hostType，
    // risk_level / expense_item 有 code 但没有 hostType —— 字段是按细项裁剪的。
    const payloads: Record<string, unknown> = {
      case_status: { name: "n", code: "c" },
      item_status: { name: "n", code: "c" },
      risk_level: { name: "n", code: "c" },
      tag: { name: "n", hostType: "matter" },
      expense_item: { name: "n", code: "c" },
    };
    for (const [kind, payload] of Object.entries(payloads)) {
      const res = await POST(req("POST", payload), ctx(kind));
      expect(res.status, `${kind} 应当放行`).toBe(201);
    }
    expect(createConfigItem).toHaveBeenCalledTimes(5);
  });
});

describe("写路径的权限门：非 canManageConfig ⇒ 403 privilege_required", () => {
  it("POST：无权限 ⇒ 403，且**不进服务层**", async () => {
    readActor.mockResolvedValue(actorWith(false));
    const res = await POST(req("POST", { name: "x", code: "y" }), ctx("case_status"));
    expect(res.status).toBe(403);
    const b = (await res.json()) as { error: string; message: string };
    expect(b.error).toBe("privilege_required");
    expect(b.message).toContain("管理配置");
    expect(createConfigItem).not.toHaveBeenCalled();
  });

  it("PATCH：无权限 ⇒ 403，且不进服务层", async () => {
    readActor.mockResolvedValue(actorWith(false));
    const res = await PATCH(req("PATCH", { id: "1", name: "x" }), ctx("case_status"));
    expect(res.status).toBe(403);
    expect(updateConfigItem).not.toHaveBeenCalled();
  });

  it("有权限 ⇒ POST 201、PATCH 200", async () => {
    expect((await POST(req("POST", { name: "x", code: "y" }), ctx("case_status"))).status).toBe(201);
    expect((await PATCH(req("PATCH", { id: "1", name: "x" }), ctx("case_status"))).status).toBe(200);
  });

  it("未登录的写请求 ⇒ 401（不是 403：先问会话再问权限）", async () => {
    readActor.mockResolvedValue(null);
    expect((await POST(req("POST", { name: "x", code: "y" }), ctx("case_status"))).status).toBe(401);
  });
});

describe("请求体校验：形状过 shared/schema/config.ts", () => {
  it("标签缺 hostType ⇒ 400 validation_failed（host_type 是 NOT NULL）", async () => {
    const res = await POST(req("POST", { name: "涉外" }), ctx("tag"));
    expect(res.status).toBe(400);
    const b = (await res.json()) as { error: string };
    expect(b.error).toBe("validation_failed");
    expect(createConfigItem).not.toHaveBeenCalled();
  });

  it("PATCH 给 code ⇒ 400（code 创建后不可改）", async () => {
    const res = await PATCH(req("PATCH", { id: "1", code: "closed" }), ctx("case_status"));
    expect(res.status).toBe(400);
    expect(updateConfigItem).not.toHaveBeenCalled();
  });

  it("PATCH 无 id ⇒ 400", async () => {
    const res = await PATCH(req("PATCH", { name: "x" }), ctx("case_status"));
    expect(res.status).toBe(400);
  });
});

describe("服务层拒绝理由的翻译", () => {
  it("not_found ⇒ 404（唯一出口）", async () => {
    updateConfigItem.mockResolvedValue({ ok: false, why: "not_found" });
    const res = await PATCH(req("PATCH", { id: "1" }), ctx("case_status"));
    expect(res.status).toBe(404);
  });

  it("duplicate_code ⇒ 409，文案点名那个编码", async () => {
    createConfigItem.mockResolvedValue({ ok: false, why: "duplicate_code", code: "pending" });
    const res = await POST(req("POST", { name: "已登记", code: "pending" }), ctx("case_status"));
    expect(res.status).toBe(409);
    const b = (await res.json()) as { error: string; message: string };
    expect(b.error).toBe("duplicate_code");
    expect(b.message).toContain("pending");
  });

  it("semantics_taken ⇒ 409（三条硬约束里 ux_status_closed 的可读形态）", async () => {
    updateConfigItem.mockResolvedValue({ ok: false, why: "semantics_taken", semantics: "closed" });
    const res = await PATCH(req("PATCH", { id: "1", semantics: "closed" }), ctx("case_status"));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("semantics_taken");
  });

  it("**停用被规则引用的状态 ⇒ 422 rule_referenced**，且点名规则", async () => {
    updateConfigItem.mockResolvedValue({
      ok: false,
      why: "rule_referenced",
      statusCode: "closed",
      ruleCodes: ["preset_01_close_auto_archive"],
    });
    const res = await PATCH(req("PATCH", { id: "3", isEnabled: false }), ctx("case_status"));
    expect(res.status).toBe(422);
    const b = (await res.json()) as { error: string; message: string };
    expect(b.error).toBe("rule_referenced");
    expect(b.message).toContain("preset_01_close_auto_archive");
    expect(b.message).toContain("规则");
  });

  it("停用初始态 / 归档态 ⇒ 422 且码不同", async () => {
    updateConfigItem.mockResolvedValue({ ok: false, why: "initial_status" });
    expect((await PATCH(req("PATCH", { id: "1", isEnabled: false }), ctx("case_status"))).status).toBe(
      422,
    );
    updateConfigItem.mockResolvedValue({ ok: false, why: "archived_status" });
    const res = await PATCH(req("PATCH", { id: "4", isEnabled: false }), ctx("case_status"));
    expect(((await res.json()) as { error: string }).error).toBe("archived_status");
  });
});
