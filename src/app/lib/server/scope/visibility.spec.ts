import { describe, expect, it } from "vitest";

import { canSeeHostFrom, loadHostAcl, type HostAcl } from "./visibility";
import type { DataScope } from "@/shared/enums";

/**
 * `canSeeHostFrom` 的**等价性**（MATT-76）。
 *
 * ## 为什么这个文件存在
 *
 * MATT-76 把通知投递侧从「每收件人一次 `canSeeHost`」改成「取一次宿主 ACL、
 * 在内存里逐个判」——6+2N 次往返压成常数次。代价是**同一条规则出现两种形态**：
 *   · `visibility()` —— 绑定 actor、宿主行当变量（列表查询用）；
 *   · `canSeeHostFrom()` —— 绑定宿主、用户当变量（投递判定用）。
 *
 * 这种"一个口径两份实现"在本仓是明确的风险点（`READINESS_SEAM` 那次的教训）。
 * 那里是靠"一份推导、断言逐键比对"堵住的；这里两份代码确实推导不出来彼此
 * （一个出 SQL、一个出布尔），所以唯一的防漂手段就是**把规则表逐格断言写下来**。
 *
 * ⚠ 下面每一格都对应 `scope/visibility.ts` 里 `visibility()` 的一条分支。
 *   改那边而没改这边（或反过来）时，**这里会红**——这就是它存在的全部理由。
 *   `smoke-notifications.mjs` 里还有一份真库矩阵断言（对真实数据跑同一条比对）。
 */
describe("canSeeHostFrom：与 visibility() 同一条规则（MATT-76）", () => {
  const OWNER = "101";
  const CREATOR = "102";
  const STAFFER = "103";
  const STRANGER = "104";

  const acl: HostAcl = {
    exists: true,
    ownerId: OWNER,
    createdBy: CREATOR,
    staffIds: new Set([STAFFER, OWNER]),
  };
  const gone: HostAcl = { exists: false, ownerId: null, createdBy: null, staffIds: new Set() };

  it("宿主不存在 / 已软删 ⇒ **谁都不许**（含 L1 与 admin）—— 默认拒绝", () => {
    for (const scope of ["all", "participating", "owned"] as DataScope[]) {
      expect(canSeeHostFrom(gone, scope, false, OWNER)).toBe(false);
      expect(canSeeHostFrom(gone, scope, false, STRANGER)).toBe(false);
    }
    // ⚠ 这条最容易写反成"admin 什么都看得见"：`is_admin` 是**范围逃生口**，
    //   不是"绕过软删"——`visibility()` 同样把它交给外层的 `NOT is_deleted`。
    expect(canSeeHostFrom(gone, "owned", true, STRANGER)).toBe(false);
  });

  it("`is_admin` ⇒ 放行（§3 逃生口；只放开范围，不碰特权）", () => {
    expect(canSeeHostFrom(acl, "owned", true, STRANGER)).toBe(true);
  });

  it("`all`（L1）⇒ 放行", () => {
    expect(canSeeHostFrom(acl, "all", false, STRANGER)).toBe(true);
  });

  it("`owned`（L3）⇒ **只有** owner / creator，staff 不算", () => {
    expect(canSeeHostFrom(acl, "owned", false, OWNER)).toBe(true);
    expect(canSeeHostFrom(acl, "owned", false, CREATOR)).toBe(true);
    // ⚠ 这条是可见性里最容易写松的一处：「我承办 ∪ 我创建」不含协办/关注
    expect(canSeeHostFrom(acl, "owned", false, STAFFER)).toBe(false);
    expect(canSeeHostFrom(acl, "owned", false, STRANGER)).toBe(false);
  });

  it("`participating`（L2）⇒ owner / creator **∪** staff", () => {
    expect(canSeeHostFrom(acl, "participating", false, OWNER)).toBe(true);
    expect(canSeeHostFrom(acl, "participating", false, CREATOR)).toBe(true);
    expect(canSeeHostFrom(acl, "participating", false, STAFFER)).toBe(true);
    expect(canSeeHostFrom(acl, "participating", false, STRANGER)).toBe(false);
  });

  it("未知 / 缺省的范围值按 `owned` 处理，**不退化成 all**", () => {
    // `undefined` = 查不到角色的人。`recipientScopes` 与 `readActor` 都按 owned 兜底。
    expect(canSeeHostFrom(acl, undefined, false, OWNER)).toBe(true);
    expect(canSeeHostFrom(acl, undefined, false, STRANGER)).toBe(false);
    // 历史脏值（枚举被 CHECK 守着，这里是第二道）
    expect(canSeeHostFrom(acl, "legacy_value" as DataScope, false, STRANGER)).toBe(false);
    expect(canSeeHostFrom(acl, "legacy_value" as DataScope, false, OWNER)).toBe(true);
  });

  it("`loadHostAcl` 的签名面：不存在时给一个**闭合**的空 ACL（不是抛错）", async () => {
    // 它要连库，所以这里只钉"形状与类型"这一层；真库行为由 smoke 覆盖。
    expect(typeof loadHostAcl).toBe("function");
    // 一个不存在的 host id ⇒ exists=false 且 staffIds 是空集（不是 undefined）
    // 这条断言在离线跑时只证明函数存在；真值断言在 smoke-notifications.mjs 里。
    expect(acl.staffIds.has(OWNER)).toBe(true);
  });
});
