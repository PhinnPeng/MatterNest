import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import type { Actor } from "@/app/lib/server/auth/auth";

/**
 * `GET /api/risk-matters/export` 的行为门（MATT-64 / F1-20）。
 *
 * 与 `/api/matters/export` 的 spec 同形（两处差的是筛选集合，不是口径）：
 * 本门钉住筛选透传 / 特权门只在路由层 / 400 不落服务层 / 响应体形状。
 * 事项侧多一个 `ownerEmpty`（未指派）且状态是配置驱动的自由字符串 —— 两条都在下面。
 */
const { exportRiskMatters, readActor } = vi.hoisted(() => ({
  exportRiskMatters: vi.fn(),
  readActor: vi.fn(),
}));

vi.mock("@/app/lib/server/services/risks", () => ({ exportRiskMatters }));
vi.mock("@/app/lib/server/auth/auth", () => ({ readActor }));

const actorWith = (canReadPlain: boolean): Actor => ({
  userId: "9002",
  displayName: "冒烟账号",
  dataScope: "owned",
  isAdmin: false,
  isSystemOwner: false,
  privileges: {
    canUnarchive: false,
    canReadPlain,
    canManageUser: false,
    canManageConfig: false,
  },
});

const EXPORT_RESULT = {
  plain: false,
  rows: 2,
  count: 2,
  truncated: false,
  csv: "\uFEFF编号,事项名称",
};

const get = (qs = "") => GET(new Request(`http://127.0.0.1/api/risk-matters/export${qs}`));

beforeEach(() => {
  readActor.mockResolvedValue(actorWith(true));
  exportRiskMatters.mockResolvedValue(EXPORT_RESULT);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/risk-matters/export：筛选与鉴权", () => {
  it("脱敏档：200，且列表那几个筛选原样进服务层（含 `ownerEmpty`）", async () => {
    const res = await get(
      "?status=in_progress&keyword=%E8%BF%9D%E7%BA%A6&ownerEmpty=1&archivedOnly=1",
    );
    expect(res.status).toBe(200);
    const [actor, q] = exportRiskMatters.mock.calls[0]!;
    expect(actor).toMatchObject({ userId: "9002" });
    expect(q).toMatchObject({
      status: "in_progress",
      keyword: "违约",
      ownerEmpty: true,
      archivedOnly: true,
      sortBy: "updated_at",
      sortDir: "desc",
      plain: false,
    });
  });

  it("事项状态是**配置驱动**的：自定义 code 不被 400 拦下（与报表两卡同一个值域）", async () => {
    const res = await get("?status=a_custom_status");
    expect(res.status).toBe(200);
    expect(exportRiskMatters.mock.calls[0]![1]).toMatchObject({ status: "a_custom_status" });
  });

  it("**无 `canReadPlain` 调明文导出 ⇒ 403，且不碰服务层**（反向红锚点）", async () => {
    readActor.mockResolvedValue(actorWith(false));
    const res = await get("?plain=1");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("privilege_required");
    expect(exportRiskMatters).not.toHaveBeenCalled();
  });

  it("有 `canReadPlain` ⇒ 200，且 `plain: true` 传下去", async () => {
    const res = await get("?plain=1&ownerEmpty=1");
    expect(res.status).toBe(200);
    expect(exportRiskMatters.mock.calls[0]![1]).toMatchObject({ plain: true, ownerEmpty: true });
  });

  it("未登录 ⇒ 401；非法排序键 ⇒ 400（白名单不是装饰）", async () => {
    readActor.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    readActor.mockResolvedValue(actorWith(true));
    const bad = await get("?sortBy=updated_at%3Bdrop");
    expect(bad.status).toBe(400);
    expect(exportRiskMatters).not.toHaveBeenCalled();
  });

  it("响应体原样透出服务的形状", async () => {
    expect(await (await get()).json()).toEqual(EXPORT_RESULT);
  });
});
