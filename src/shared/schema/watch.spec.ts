import { describe, expect, it } from "vitest";

import { favoriteSchema, watchTargetSchema, WATCH_TARGET_TYPES } from "./watch";
import { WATCH_TYPES, USER_OWNABLE_WATCH_TYPES, HOST_TYPES } from "@/shared/enums/targets";

/**
 * 收藏 ⭐（MATT-63 / F1-13）的**离线可测面**。
 *
 * 能在这里测的只有 schema —— 服务层与端点要连库，由 `agent-work/smoke-watch.mjs`
 * 的真 HTTP 判据覆盖（`pnpm verify` 必须离线可跑，这是本仓口径）。
 *
 * ## 为什么这几条断言值得写（它们防的都是"不报错的错"）
 *
 * `mn_user_watch` 唯一的写入方就是本票的代码，而它的值域 CHECK 写着
 * `follow | favorite` —— 库里拦得住非法**值**，拦不住"用错的那一个"：
 *    · 客户端传 `watchType: "follow"` 若能过，用户就能自造 `follow` 行，
 *      「我关注」与「关注人名单」从此两份真相，**而两边都 200**；
 *    · `targetType` 若不收窄，收藏会挂到 `matter_node` 这类从属对象上，
 *      而「我收藏的」只查两个宿主 ⇒ 那条收藏**永远查不出来**（用户以为点了没反应）。
 *
 * 两条都是静默的：不报错、无类型错、单测不盯它就绿。
 */
describe("收藏 ⭐ 的请求形状（MATT-63）", () => {
  it("只收 `watching` 布尔，**拒掉 `watchType`** —— 否则前端能自造 follow 行", () => {
    expect(favoriteSchema.safeParse({ watching: true }).success).toBe(true);
    expect(favoriteSchema.safeParse({ watching: false }).success).toBe(true);

    // `.strict()`：多一个字段就 400，不是静默剥离
    const withType = favoriteSchema.safeParse({ watching: true, watchType: "follow" });
    expect(withType.success).toBe(false);

    expect(favoriteSchema.safeParse({ watching: "true" }).success).toBe(false);
    expect(favoriteSchema.safeParse({}).success).toBe(false);
  });

  it("宿主只收案件与事项 —— **引的就是 `HOST_TYPES` 那一份**", () => {
    // 钉"它引的是那份值域"，而不是"恰好值相同"：本模块曾自己抄一遍
    // `["matter","risk_matter"]`，某天新增宿主时改一处漏一处，两边却都编译得过。
    expect([...WATCH_TARGET_TYPES]).toEqual([...HOST_TYPES]);

    expect(watchTargetSchema.safeParse({ targetType: "matter" }).success).toBe(true);
    expect(watchTargetSchema.safeParse({ targetType: "risk_matter" }).success).toBe(true);

    // 从属对象（节点/进展/费用/账号）不在收藏范围：挂上去就永远查不出来
    for (const bad of ["matter_node", "risk_matter_node", "matter_progress", "app_user"]) {
      expect(watchTargetSchema.safeParse({ targetType: bad }).success).toBe(false);
    }
  });

  it("**id 的形态不归本模块管** —— 它只在 `http.ts:pathId()` 一处", () => {
    // 本 schema 曾自带 `/^\d{1,19}$/` 并让路由按自造的 `bad_target` 报错，
    // 于是仓里有了第二份 id-shape 规则、且与全仓 61 处 `pathId()` 不同码。
    // 那条规则已摘掉；这条断言是它的反面：`targetId` 根本不在本形状里，
    // 给什么都由路由层的 `pathId()` 表态（`bad_id` / 400）。
    expect(watchTargetSchema.shape).not.toHaveProperty("targetId");
  });

  it("**`follow` 不在可自建值域里** —— 这条断言是「两份真相」的防线", () => {
    expect([...USER_OWNABLE_WATCH_TYPES]).toEqual(["favorite"]);
    // 值域本身仍含 follow（它由 *_staff 同步生成，不是用户建的）
    expect([...WATCH_TYPES].sort()).toEqual(["favorite", "follow"]);
    expect(USER_OWNABLE_WATCH_TYPES).not.toContain("follow");
  });
});
