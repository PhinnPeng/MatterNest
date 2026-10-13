import { describe, expect, it } from "vitest";

import { REPORT_FILTER_KEYS, REPORT_OMITTED_KEYS } from "@/shared/schema/list-query";
import { reportsQuerySchema } from "./reports";

/**
 * `/api/reports` 的入参契约（MATT-46 形态改判那一轮补）。
 *
 * 这一份**不碰库**：它守的是"卡片跟着列表筛选变"这条链路上最容易静默断掉的两处——
 *   1. **客户端发了、服务端不收**（值域/键名两边各写一遍）→ 卡片 400 或数字不动；
 *   2. **客户端发了、服务端静默丢掉**（zod 的 `z.object` 默认剥掉不认识的键）
 *      → 与 `ownerEmpty` 真实出过的那次一模一样：界面点了没反应，服务端一切正常。
 * 第 2 条就是这里用 `.strict()` 的理由，也是下面那组"多传一个就 400"的断言。
 */

describe("reportsQuerySchema：只收报表那三个筛选", () => {
  it("**键集合 == REPORT_FILTER_KEYS**（客户端与服务端引同一份分类表）", () => {
    expect(Object.keys(reportsQuerySchema.shape).sort()).toEqual([...REPORT_FILTER_KEYS].sort());
  });

  it.each(REPORT_OMITTED_KEYS)("`%s` 传进来是 **400**，不是被静默剥掉", (key) => {
    const parsed = reportsQuerySchema.safeParse({ [key]: "1" });
    expect(parsed.success, `${key} 被静默接受了`).toBe(false);
  });

  it("三个筛选各自收下（`status` 是配置驱动的 code，不收枚举）", () => {
    const q = reportsQuerySchema.parse({
      status: "in_progress",
      ownerEmpty: "1",
      archivedOnly: "1",
    });
    expect(q).toEqual({ status: "in_progress", ownerEmpty: true, archivedOnly: true });
    // 运营新增的状态 code 必须能筛（`configStatusField` 的存在理由：报表跨两个宿主，
    // 只能取值域的并集，收成案件那四个内置 code 会让事项侧的新状态在卡片上 400）
    expect(reportsQuerySchema.parse({ status: "ops_added_code" }).status).toBe("ops_added_code");
  });

  it("不给筛选就是不给（`archivedOnly` 默认在办，两个开关默认不限）", () => {
    const q = reportsQuerySchema.parse({});
    // `status` 是唯一一个"缺省即不存在"的键（zod 对 optional 不出现在输出里）；
    // 两个开关走的是 `*Field` 的 transform，缺省都落成 `false`（服务层按真值判，见 `listFilterOf`）
    expect("status" in q).toBe(false);
    expect(q).toMatchObject({ ownerEmpty: false, archivedOnly: false });
  });

  it("归档开关沿用列表那份二态定义：`false` 不许被判成 true，`yes` 直接拒", () => {
    // 反面教材是 `z.coerce.boolean()`：`Boolean("false") === true`，
    // 那会让"退出归档视图"静默变成"一直看归档"
    expect(reportsQuerySchema.parse({ archivedOnly: "false" }).archivedOnly).toBe(false);
    expect(reportsQuerySchema.parse({ archivedOnly: "0" }).archivedOnly).toBe(false);
    expect(reportsQuerySchema.parse({ archivedOnly: "true" }).archivedOnly).toBe(true);
    expect(reportsQuerySchema.safeParse({ archivedOnly: "yes" }).success).toBe(false);
  });

  it("状态超长被拒（32 与 `mn_status_config.code` 的列宽同源）", () => {
    expect(reportsQuerySchema.safeParse({ status: "x".repeat(33) }).success).toBe(false);
  });
});
