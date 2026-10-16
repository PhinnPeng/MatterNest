import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 节点两个端点必须**显式接住** `frozen`（MATT-80 / ADR 0005）。
 *
 * ## 为什么用源码断言，而不是发一个请求
 *
 * 本仓没有 HTTP 级的路由测试地基（`src/app/api` 下只有 `pump` 一条），
 * 而 `risks.spec.ts` 早就用「读源码 + 正则比对」抓过同类问题（判据只许出现一次、
 * 五道门必须是活的）。路由这一层要守的不是「有没有分支」，是**掉进兜底时说了什么**，
 * 源码里恰好一句话就能钉住。
 *
 * ## 它守的是什么形态（真咬过一次）
 *
 * 服务层给节点两个写路径补上冻结门之后，`frozen` 一度掉进路由的兜底：
 *
 * - `POST` → `403 forbidden`「归档是终态，或你不是这条事项的经办人」——**说了别的原因**，
 *   用户会去查权限和归档态，而真正的原因是转过案件
 * - `PATCH` → `422 unchanged`「目标状态与当前状态相同」——**说了句假话**
 *
 * 既有三道冻结路径（编辑事项 / 状态流转 / 撤销转案件）都是
 * `422 frozen` + 共享文案 `RISK_FROZEN_MESSAGE`，这两条端点必须同形。
 */
const src = readFileSync(new URL("route.ts", import.meta.url), "utf8");

describe("节点端点的冻结原因（不是笼统的 forbidden / unchanged）", () => {
  it("POST 与 PATCH 各有一条显式的 `frozen` 分支，共用同一条对外文案", () => {
    const branches =
      src.match(/if \(r\.why === "frozen"\) return fail\(422, "frozen", RISK_FROZEN_MESSAGE\);/g) ??
      [];
    expect(
      branches,
      "两个端点各要一条 —— 少一条就会掉进兜底，把「转过案件」说成「归档/权限」或「状态没变」",
    ).toHaveLength(2);
  });
});
