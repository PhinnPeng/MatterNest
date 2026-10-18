import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import type { Actor } from "@/app/lib/server/auth/auth";

/**
 * `GET /api/roles` 的行为门（MATT-100）。
 *
 * 服务层整体 mock：本门钉的是**路由层**的三件事 ——
 *   ① 登录即可读：无 `canManageUser` 也**不是 403**，角色定义照给；
 *   ② 权限门只做**一件事**：把 `actor.privileges.canManageUser` 翻译成服务层的
 *      `includeMembers` 布尔（`true` = 给成员清单，`false` = 只给计数）；
 *   ③ 响应体原样透出服务的形状（页面按 `roles[].dataScope` 走 `DATA_SCOPE_LABELS` 翻译）。
 *
 * ⚠ **只断言形状与权限，不断言 SQL**（先例：`api/matters/export/route.spec.ts`）。
 *   「无 `canManageUser` ⇒ 成员清单真的变成 null」这条由**服务层的纯投影**断言
 *   （`services/roles.spec.ts`）—— 那一层不需要库就能钉住，本草稿不重复。
 *
 * ⚠ 权限门反向红：把 `withActor` 里那行 `includeMembers` 换成硬编码 `true`，
 *   第②组断言必须变红。
 */
const { listRoleDetails, readActor } = vi.hoisted(() => ({
  listRoleDetails: vi.fn(),
  readActor: vi.fn(),
}));

vi.mock("@/app/lib/server/services/roles", () => ({ listRoleDetails }));
vi.mock("@/app/lib/server/auth/auth", () => ({ readActor }));

const actorWith = (canManageUser: boolean): Actor => ({
  userId: "9001",
  displayName: "冒烟账号",
  dataScope: "all",
  isAdmin: false,
  isSystemOwner: false,
  privileges: {
    canUnarchive: false,
    canReadPlain: false,
    canManageUser,
    canManageConfig: false,
  },
});

/** 服务层返回的完整形状（含成员清单）。 */
const ROLES_FULL = [
  {
    id: "10",
    code: "sys_admin",
    name: "系统管理",
    dataScope: "owned",
    canUnarchive: false,
    canReadPlain: false,
    canManageUser: true,
    canManageConfig: true,
    isSystem: true,
    holderCount: 1,
    members: [{ id: "101", username: "admin", displayName: "系统管理员" }],
  },
  {
    id: "11",
    code: "full_admin",
    name: "全局管理",
    dataScope: "all",
    canUnarchive: true,
    canReadPlain: true,
    canManageUser: false,
    canManageConfig: false,
    isSystem: true,
    holderCount: 1,
    members: [{ id: "101", username: "admin", displayName: "系统管理员" }],
  },
];

const get = () => GET();

beforeEach(() => {
  readActor.mockResolvedValue(actorWith(true));
  listRoleDetails.mockResolvedValue(ROLES_FULL);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/roles：角色定义登录即可读", () => {
  it("有 `canManageUser` ⇒ 200，透出完整成员清单", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roles: typeof ROLES_FULL };
    expect(body.roles).toEqual(ROLES_FULL);
    expect(body.roles[0]!.members).toHaveLength(1);
  });

  it("**无 `canManageUser` ⇒ 仍 200**（不是整页 403：普通用户要看得到角色说明）", async () => {
    readActor.mockResolvedValue(actorWith(false));
    listRoleDetails.mockResolvedValue(ROLES_FULL.map((r) => ({ ...r, members: null })));
    const res = await get();
    expect(res.status).toBe(200);
  });

  it("未登录 ⇒ 401（不给「匿名能读全量成员」这种口子）", async () => {
    readActor.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(401);
    expect(listRoleDetails).not.toHaveBeenCalled();
  });
});

describe("GET /api/roles：权限门把特权翻译成 includeMembers", () => {
  it("有 `canManageUser` ⇒ `includeMembers: true`（反向红锚点）", async () => {
    await get();
    expect(listRoleDetails).toHaveBeenCalledWith({ includeMembers: true });
  });

  it("**无 `canManageUser` ⇒ `includeMembers: false`**（且仍然走到服务层）", async () => {
    readActor.mockResolvedValue(actorWith(false));
    listRoleDetails.mockResolvedValue([]);
    await get();
    expect(listRoleDetails).toHaveBeenCalledWith({ includeMembers: false });
  });

  it("**不做 403**：无 `canManageUser` 时服务层照常被调用一次", async () => {
    readActor.mockResolvedValue(actorWith(false));
    listRoleDetails.mockResolvedValue([]);
    await get();
    expect(listRoleDetails).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/roles：响应形状", () => {
  it("角色定义在任何权限档下都在（code / name / dataScope / 四项特权都是正确类型）", async () => {
    readActor.mockResolvedValue(actorWith(false));
    listRoleDetails.mockResolvedValue(ROLES_FULL.map((r) => ({ ...r, members: null })));
    const res = await get();
    const body = (await res.json()) as { roles: typeof ROLES_FULL };
    expect(body.roles.map((r) => r.code)).toEqual(["sys_admin", "full_admin"]);
    for (const r of body.roles) {
      expect(typeof r.name).toBe("string");
      expect(typeof r.dataScope).toBe("string");
      for (const k of ["canUnarchive", "canReadPlain", "canManageUser", "canManageConfig"]) {
        expect(typeof (r as unknown as Record<string, unknown>)[k]).toBe("boolean");
      }
    }
  });

  it("列表原样透出服务的顺序（内置角色按 id 升序，页面左栏的次序依赖它）", async () => {
    const res = await get();
    const body = (await res.json()) as { roles: typeof ROLES_FULL };
    expect(body.roles.map((r) => r.id)).toEqual(["10", "11"]);
  });
});
