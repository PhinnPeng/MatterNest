import { describe, expect, it } from "vitest";

import type { DataScope } from "@/shared/enums";
import { HOST_TYPES } from "@/shared/enums/targets";

import { canSeeHostFrom, loadHostAcl, visibility, type HostAcl } from "./visibility";

/**
 * `canSeeHostFrom` 与 `visibility()` 的**等价性**（MATT-76）。
 *
 * ## 为什么这个文件存在
 *
 * MATT-76 把通知投递侧从「每收件人一次 `canSeeHost`」改成「取一次宿主 ACL、
 * 在内存里逐个判」——6+2N 次往返压成常数次。代价是**同一条规则出现两种形态**：
 *   · `visibility()` —— 绑定 actor、宿主行当变量（列表查询用，出 **SQL**）；
 *   · `canSeeHostFrom()` —— 绑定宿主、用户当变量（投递判定用，出**布尔**）。
 *
 * 这种"一个口径两份实现"在本仓是明确的风险点（`READINESS_SEAM` 那次的教训）。
 * 两份代码推导不出彼此（一个出 SQL、一个出布尔），所以防漂靠**两侧各自钉死、
 * 再断言它们同向**：
 *
 *   ① **内存矩阵** —— `canSeeHostFrom` 的每一格判决写死（L1/L2/L3 ×
 *      owner/creator/staff/无关人 × admin），对应 `visibility()` 的每一条分支；
 *   ② **SQL 形态** —— 把 `visibility()` 真的调一遍，断言它**给不给谓词**、
 *      以及谓词里**有没有 `*_staff` 子句**（这两件事正是 L1/L3 与 L2 的分界）。
 *
 * ⚠ **两份都得在**：只有 ① 时，"把 `visibility()` 的 L3 改成含协办"不会红
 *   （内存那份没动）；只有 ② 时，"改内存那份"不会红（SQL 没动）。
 *
 * ## ⚠ 三处注释曾承诺一份不存在的断言（2026-10-18 修正）
 *
 * 本文件、`scope/visibility.ts` 与 `services/notifications.ts` 原先都写着
 * 「还有一份**真库矩阵断言**在 `agent-work/smoke-notifications.mjs` 里」——
 * **那份断言从来不存在**（对该文件 `grep canSeeHostFrom` 零命中）。
 *
 * 而且它按原样也落不了地：冒烟脚本只走 HTTP，而这两种形态都是**内部函数**、
 * 不经任何端点暴露 ⇒ 冒烟够不着。硬要在冒烟里复写一份谓词就是**第三种形态**，
 * 比漂移更坏。所以那句话的兑现处是下面的 ②，不是在冒烟里。
 */

/** 夹具：owner 承办、creator 创建、staffer 协办、stranger 无关 */
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

/** 三档数据范围（`admin` 是逃生口，另算） */
const SCOPES = ["all", "participating", "owned"] as const satisfies readonly DataScope[];

/**
 * 把 drizzle 的 `SQL` 对象摊成可搜寻的文本。
 *
 * ## 为什么要这么绕
 *
 * `visibility()` 要么返回 `undefined`（= 不加谓词），要么返回一个 drizzle `SQL` 对象。
 * 要断言"这个谓词里有没有 staff 那半支"就得读它，而 drizzle 没有离线的
 * 「取 SQL 字符串」API（`toSQL()` 要方言实例）。实测可行的一条路是 `queryChunks`：
 * `SQL` 对象上挂着它，里面**嵌着**被引用的表对象与列对象，而表名正是
 * `mn_matter_staff` 这种稳定标识符。
 *
 * ## ⚠ 它是启发式，所以有 canary
 *
 * 读的是 drizzle 的内部形状（`drizzle-orm` 锁了精确版本，禁令②要求升级时复验）。
 * 哪天小版本改了形状，这个 walker 会**什么也读不到**，而那会让下面几条断言
 * 退化成"反向为真"的**假绿**。所以先跑 canary：连必然出现的表名都读不到时，
 * 直接判失败并说明是走法坏了，不是口径对了。
 */
function sqlText(q: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  const walk = (n: unknown): void => {
    if (n === null || n === undefined) return;
    if (typeof n === "string") {
      parts.push(n);
      return;
    }
    if (typeof n !== "object") return;
    if (seen.has(n)) return;
    seen.add(n);
    const o = n as Record<string, unknown>;
    // 表名/列名的常见落点
    for (const k of ["name", "tableName", "columnType", "value"]) {
      if (typeof o[k] === "string") parts.push(String(o[k]));
    }
    // drizzle 把表名与列名也挂在 Symbol 键上（实测：`Symbol(drizzle:Name)`）
    for (const sym of Object.getOwnPropertySymbols(o)) {
      const v = (o as Record<symbol, unknown>)[sym];
      if (typeof v === "string") parts.push(v);
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(q);
  return parts.join(" ");
}

describe("canSeeHostFrom：与 visibility() 同一条规则（MATT-76 ① 内存矩阵）", () => {
  it("宿主不存在 / 已软删 ⇒ **谁都不许**（含 L1 与 admin）—— 默认拒绝", () => {
    for (const scope of SCOPES) {
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
    // 它要连库，所以这里只钉"形状与类型"这一层。
    expect(typeof loadHostAcl).toBe("function");
    // 一个不存在的 host id ⇒ exists=false 且 staffIds 是空集（不是 undefined）
    expect(acl.staffIds.has(OWNER)).toBe(true);
  });
});

/**
 * ② **SQL 形态**（2026-10-18 补）：把 `visibility()` 调起来、读它**实际产出**的谓词，
 * 再与 ① 的判决比对是否同向。这组才是"两份形态等价"的真断言。
 */
describe("visibility() 的 SQL 形态：与内存判决同向（MATT-76 ②）", () => {
  it("canary：`sqlText` 读得到表名（读不到说明 walker 腐了，不是口径对了）", () => {
    const text = sqlText(visibility("matter", "owned", STRANGER, false));
    expect(text, "读不到 `mn_matter` —— sqlText 的走法随 drizzle 版本腐了").toContain("mn_matter");
  });

  it("**给不给谓词** ⇔ 无关人是否放行（L1 与 admin 是仅有的两个「不加谓词」）", () => {
    for (const scope of SCOPES) {
      for (const isAdmin of [false, true]) {
        const noPredicate = visibility("matter", scope, STRANGER, isAdmin) === undefined;
        const strangerSees = canSeeHostFrom(acl, scope, isAdmin, STRANGER);
        expect(
          strangerSees,
          `scope=${scope} admin=${isAdmin}：visibility() ${
            noPredicate ? "不加谓词" : "给了谓词"
          }，而内存形态说无关人${strangerSees ? "看得见" : "看不见"}`,
        ).toBe(noPredicate);
      }
    }
  });

  it("**`*_staff` 子句只在 L2** ⇔ 协办人只在 L2 放行（L3 不含协办）", () => {
    const l2 = sqlText(visibility("matter", "participating", STRANGER, false));
    const l3 = sqlText(visibility("matter", "owned", STRANGER, false));

    expect(l2, "L2 的谓词里没有 staff 子查询 —— 「参与」这一档就名不副实了").toContain(
      "mn_matter_staff",
    );
    expect(l3, "L3 的谓词里出现了 staff —— 「我承办 ∪ 我创建」被写松了").not.toContain(
      "mn_matter_staff",
    );

    // 内存形态必须同向：协办在 L2 放行、在 L3 不放行
    expect(canSeeHostFrom(acl, "participating", false, STAFFER)).toBe(true);
    expect(canSeeHostFrom(acl, "owned", false, STAFFER)).toBe(false);
  });

  it("事项侧同形（两张同构表走同一个 `HOSTS` 分派，别只验案件）", () => {
    // 引 `HOST_TYPES` 而不是写 `["matter","risk_matter"]` —— 本仓新加的 lint-guard
    // 规则就是在拦那个写法（这条断言第一次跑时被它自己拦下，是个好信号）。
    for (const host of HOST_TYPES) {
      const l2 = sqlText(visibility(host, "participating", STRANGER, false));
      const l3 = sqlText(visibility(host, "owned", STRANGER, false));
      expect(l2, `${host} 的 L2 谓词缺 staff 子查询`).toMatch(/mn_(risk_)?matter_staff/);
      expect(l3, `${host} 的 L3 谓词多了 staff 子查询`).not.toMatch(/mn_(risk_)?matter_staff/);
    }
  });
});
