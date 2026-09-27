import { describe, expect, it } from "vitest";
import { SHARED_DIRS, firstSharedDir } from "./dirs";

/**
 * W0-1 骨架阶段的唯一测试：证明 `src/shared/` 能编译、vitest 跑得起来、
 * 严格模式（`noUncheckedIndexedAccess`）确实生效。
 *
 * 真正的 shared 层测试（CHECK↔值数组一致性、`scope_key` 8 向量、同构表列集合 diff）
 * 随 W0-3 / W0-4 / W1-2 进来，与 `tools/lint-guard/check.mjs` 一起挂在 `pnpm verify` 上。
 */
describe("src/shared 纯净层", () => {
  it("五个约定子目录（与 src/shared/README.md 的表一致）", () => {
    expect([...SHARED_DIRS]).toEqual(["enums", "schema", "ids", "time", "crypto"]);
  });

  it("取首个目录不越界", () => {
    expect(firstSharedDir()).toBe("enums");
  });
});
