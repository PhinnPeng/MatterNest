import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 当事人两个端点与软删端点必须**显式接住** `frozen`（MATT-82 / ADR 0005）。
 *
 * ## 为什么用源码断言，而不是发一个请求
 *
 * 与 `../nodes/route.spec.ts` 同一条理由：本仓没有 HTTP 级的路由测试地基，
 * 而路由这一层要守的不是「有没有分支」，是**掉进兜底时说了什么**。
 * 源码里恰好一句话就能钉住。
 *
 * ## 它守的是什么形态（MATT-80 真咬过一次）
 *
 * 服务层补上冻结门之后，`frozen` 若不在这层显式接住，就会掉进路由的兜底：
 *
 * - 追加 / 摘除当事人掉进 `notFound()` → **404「不存在」**（这条事项明明在，用户会去核对 id）
 * - 软删掉进 `attributionRequired()` → **403「你不是经办人」**（用户会去找经办人代劳，
 *   而代劳的人拿到的还是同一句拒绝）
 *
 * 既有五条冻结路径一律 `422 frozen` + 共享文案 `RISK_FROZEN_MESSAGE`，
 * 本票这三条端点必须同形。
 */
const BRANCH = 'if (r.why === "frozen") return fail(422, "frozen", RISK_FROZEN_MESSAGE);';

const appendSrc = readFileSync("src/app/api/risk-matters/[id]/parties/route.ts", "utf8");
const removeSrc = readFileSync("src/app/api/risk-matters/[id]/parties/[linkId]/route.ts", "utf8");
const rootSrc = readFileSync("src/app/api/risk-matters/[id]/route.ts", "utf8");

const count = (src: string) =>
  (
    src.match(/if \(r\.why === "frozen"\) return fail\(422, "frozen", RISK_FROZEN_MESSAGE\);/g) ??
    []
  ).length;

describe("当事人与软删端点的冻结原因（不是 404 / 403 / unchanged）", () => {
  it("追加当事人（POST）有一条显式的 `frozen` 分支，共用同一条对外文案", () => {
    expect(
      count(appendSrc),
      "少了这条分支就会掉进 404 —— 把「转过案件」说成「不存在」，用户会去核对 id",
    ).toBe(1);
    expect(appendSrc).toContain(BRANCH);
  });

  it("摘除当事人（DELETE）有一条显式的 `frozen` 分支，共用同一条对外文案", () => {
    expect(
      count(removeSrc),
      "少了这条分支就会掉进 404 —— 把「转过案件」说成「这条挂接不存在」",
    ).toBe(1);
    expect(removeSrc).toContain(BRANCH);
  });

  it("软删（DELETE /api/risk-matters/:id）有一条显式的 `frozen` 分支，落在 DELETE 处理函数里", () => {
    // 同一个文件里的 PATCH（改字段）早就有这条分支，所以按**处理函数**切开来查：
    // 文件级计数会把 PATCH 那条也算进来，DELETE 少了分支照样绿。
    const del = rootSrc.slice(rootSrc.indexOf("export async function DELETE("));
    expect(del, "DELETE 不在这个文件里了 —— 先看清楚再改这条断言").not.toBe("");
    expect(
      del.includes(BRANCH),
      "少了这条分支就会掉进 attributionRequired() —— 把「转过案件」说成「你不是经办人」",
    ).toBe(true);
  });
});
