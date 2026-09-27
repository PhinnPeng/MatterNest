import { describe, expect, it } from "vitest";
import { cn } from "./utils";

/**
 * `cn()` 的行为测试（W0-2）。样式三条之② 要求"覆盖组件默认样式一律走 cn() 合并"，
 * 这条只有在合并真生效时才成立——所以把它测死，而不是假设装了包就对了。
 * 注：W0-2/N1 之后 `cn` 来自 shadcn 官方包 `cn`（本文件只 re-export），这三条测试就是它的行为契约；
 * 换回 clsx+tailwind-merge 或将来换实现时，这三条必须仍然绿，否则视为口径变更。
 */
describe("cn() 合并语义", () => {
  it("同类冲突时后者胜出，不留下互相打架的类名", () => {
    const out = cn("border-neutral-200 text-xs", "border-neutral-300");
    expect(out).not.toContain("border-neutral-200");
    expect(out).toContain("border-neutral-300");
    expect(out).toContain("text-xs");
  });

  it("条件类为假时不产出空串噪声", () => {
    const dense: boolean | undefined = false;
    expect(cn("p-2", dense && "p-8", undefined)).toBe("p-2");
  });

  it("不同工具类各自保留", () => {
    expect(cn("flex", "items-center")).toBe("flex items-center");
  });
});
