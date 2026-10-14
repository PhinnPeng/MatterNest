import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

/**
 * `POST /api/internal/pump` 的行为门（MATT-73）。
 *
 * 服务层两个函数整体 mock：本门钉的是**路由层**的三件事——
 * 鉴权口径（缺/错 token ⇒ 404）、不碰会话、返回体形状；
 * 泵本身的正确性由 `services/notifications.spec.ts` 与冒烟负责，
 * 而 `pnpm verify` 的口径是离线可跑（`matters.spec.ts` 同一条理由）。
 *
 * ⚠ 「错 token ⇒ 404」这一条是**反向红**的锚点：把 route 里的判定摘掉，
 * 下面两条断言必须变红（且是断言失败，不是编译错误）——它证明这道门
 * 真的把「无 token 请求」挡在服务层之前，而不是碰巧绿。
 */
const { pumpNotifications, scanArchiveIncomplete } = vi.hoisted(() => ({
  pumpNotifications: vi.fn(),
  scanArchiveIncomplete: vi.fn(),
}));

vi.mock("@/app/lib/server/services/notifications", () => ({
  pumpNotifications,
}));
vi.mock("@/app/lib/server/services/archive-reminder", () => ({
  scanArchiveIncomplete,
}));

const TOKEN = "pump-smoke-token";

const post = (authorization?: string) =>
  POST(
    new Request("http://127.0.0.1/api/internal/pump", {
      method: "POST",
      headers: authorization === undefined ? {} : { authorization },
    }),
  );

const PUMP_RESULT = {
  outbox: { scanned: 3, published: 3, failed: 0, events: 2, merged: 1 },
  scan: { scanned: 12, events: 1, merged: 0 },
};

beforeEach(() => {
  process.env.MN_INTERNAL_TOKEN = TOKEN;
  pumpNotifications.mockResolvedValue(PUMP_RESULT);
  scanArchiveIncomplete.mockResolvedValue({
    ruleFound: true,
    enabled: true,
    scanned: 5,
    events: 0,
    merged: 0,
    skipped: [],
    dateKey: "2026-10-14",
  });
});

afterEach(() => {
  delete process.env.MN_INTERNAL_TOKEN;
  vi.clearAllMocks();
});

describe("POST /api/internal/pump 鉴权（bearer token ⇒ MN_INTERNAL_TOKEN）", () => {
  it("缺 token ⇒ 404（不吐「这端点存在」，也不碰服务层）", async () => {
    const res = await post();
    expect(res.status).toBe(404);
    expect(pumpNotifications).not.toHaveBeenCalled();
    expect(scanArchiveIncomplete).not.toHaveBeenCalled();
  });

  it("错 token ⇒ 404（反向红锚点：摘掉 route 里的判定，本条必须变红）", async () => {
    const res = await post("Bearer definitely-wrong");
    expect(res.status).toBe(404);
    expect(pumpNotifications).not.toHaveBeenCalled();
    expect(scanArchiveIncomplete).not.toHaveBeenCalled();
  });

  it("不带 Bearer 前缀的裸 token ⇒ 404（前缀不是装饰，是口径）", async () => {
    const res = await post(TOKEN);
    expect(res.status).toBe(404);
    expect(pumpNotifications).not.toHaveBeenCalled();
  });

  it("env 缺 MN_INTERNAL_TOKEN ⇒ 一律 404（fail closed，没有默认值可走）", async () => {
    delete process.env.MN_INTERNAL_TOKEN;
    const res = await post(`Bearer ${TOKEN}`);
    expect(res.status).toBe(404);
    expect(pumpNotifications).not.toHaveBeenCalled();
  });

  it("对 token ⇒ 200 + { outbox, scan } 计数，两个泵各跑一次、无参调用", async () => {
    const res = await post(`Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual(PUMP_RESULT);
    expect(pumpNotifications).toHaveBeenCalledTimes(1);
    // 无参调用是「逐字相同」的行为落点：加了参数（limit 之类）这条会红
    expect(pumpNotifications).toHaveBeenCalledWith();
    expect(scanArchiveIncomplete).toHaveBeenCalledTimes(1);
    expect(scanArchiveIncomplete).toHaveBeenCalledWith();
  });
});

describe("源码守卫：本端点是全仓第一个无会话的 /api 路由", () => {
  /**
   * 会话模型对这个端点既不必要也不该有（见 route 文件头）。
   * 一旦有人「顺手」用 withActor 包起来，触发器会拿到 401——
   * 而 cron 失败在库里长得和「没有待投递事件」一模一样，
   * 正是 `notifications/route.ts:22-23` 点名的那个坑。
   *
   * 先剥注释再断言：注释里会**写**这些词来解释「为什么不用它」，
   * 词级匹配会把说明文字自己拦下来（与 notifications.spec.ts 同一姿态）。
   */
  it("route.ts 的**代码**里不出现 withActor / readActor", () => {
    const src = readFileSync("src/app/api/internal/pump/route.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    expect(src).not.toContain("withActor");
    expect(src).not.toContain("readActor");
  });
});
