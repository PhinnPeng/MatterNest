import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import type { Actor } from "@/app/lib/server/auth/auth";

/**
 * `GET /api/matters/export` 的行为门（MATT-64 / F2-23）。
 *
 * 服务层整体 mock：本门钉的是**路由层**的四件事 ——
 *   ① 列表的筛选**原样传下去**（"导出当前筛选的结果"是本票的语义；少传一个筛选不会报错，
 *      只会让导出比列表多几行 —— 那正是这条断言要拦的）；
 *   ② 明文档要 `canReadPlain`，判定**只在这一层**（服务层不判，见 `matters.ts` 的文件头）；
 *   ③ 参数不合法给 400，不落到服务层；
 *   ④ 响应体原样透出服务的形状（`plain/rows/count/truncated/csv`）。
 *
 * ⚠ 「无 `canReadPlain` ⇒ 403 且**不碰服务层**」是**反向红**的锚点：把那两行摘掉，
 * 下面两条断言必须变红（且是断言失败，不是编译错误）。
 *
 * "导出行数 == 同一筛选下列表的 total" 那条最要紧的断言不在离线门里 —— 它要真库，
 * 住在 `agent-work/smoke-list-export.mjs`。
 */
const { exportMatters, readActor } = vi.hoisted(() => ({
  exportMatters: vi.fn(),
  readActor: vi.fn(),
}));

vi.mock("@/app/lib/server/services/matters", () => ({ exportMatters }));
vi.mock("@/app/lib/server/auth/auth", () => ({ readActor }));

const actorWith = (canReadPlain: boolean): Actor => ({
  userId: "9001",
  displayName: "冒烟账号",
  dataScope: "all",
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
  rows: 3,
  count: 3,
  truncated: false,
  csv: "\uFEFF内部编号,正式案号",
};

const get = (qs = "") => GET(new Request(`http://127.0.0.1/api/matters/export${qs}`));

beforeEach(() => {
  readActor.mockResolvedValue(actorWith(true));
  exportMatters.mockResolvedValue(EXPORT_RESULT);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/matters/export：筛选与鉴权", () => {
  it("脱敏档：200，且**列表那几个筛选原样进服务层**（含排序）", async () => {
    const res = await get(
      "?status=closed&keyword=%E5%90%88%E5%90%8C&archivedOnly=1&sortBy=name&sortDir=asc",
    );
    expect(res.status).toBe(200);
    expect(exportMatters).toHaveBeenCalledTimes(1);
    const [actor, q] = exportMatters.mock.calls[0]!;
    expect(actor).toMatchObject({ userId: "9001" });
    expect(q).toMatchObject({
      status: "closed",
      keyword: "合同",
      archivedOnly: true,
      sortBy: "name",
      sortDir: "asc",
      plain: false,
    });
  });

  it("不带任何参数 ⇒ 默认排序、筛选全为「不限」，仍走同一张表", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(exportMatters.mock.calls[0]![1]).toMatchObject({
      sortBy: "updated_at",
      sortDir: "desc",
      plain: false,
    });
  });

  it("**无 `canReadPlain` 调明文导出 ⇒ 403，且不碰服务层**（反向红锚点）", async () => {
    readActor.mockResolvedValue(actorWith(false));
    const res = await get("?plain=1");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("privilege_required");
    expect(exportMatters).not.toHaveBeenCalled();
  });

  it("有 `canReadPlain` ⇒ 200，且 `plain: true` 传下去（档位要落到审计上）", async () => {
    const res = await get("?plain=1");
    expect(res.status).toBe(200);
    expect(exportMatters.mock.calls[0]![1]).toMatchObject({ plain: true });
  });

  it("未登录 ⇒ 401（不给「匿名能导全量」这种口子）", async () => {
    readActor.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(401);
    expect(exportMatters).not.toHaveBeenCalled();
  });

  it("非法筛选值给 400 且不落服务层（status 只认四个内置 code）", async () => {
    const res = await get("?status=whatever");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: { path: string }[] };
    expect(body.error).toBe("validation_failed");
    expect(body.issues.map((i) => i.path)).toContain("status");
    expect(exportMatters).not.toHaveBeenCalled();
  });

  it("响应体原样透出服务的形状（前端按 `rows` 写提示、按 `csv` 下载）", async () => {
    const res = await get();
    expect(await res.json()).toEqual(EXPORT_RESULT);
  });
});
