import { describe, expect, it } from "vitest";
import { DATA_SCOPE_LABELS } from "@/shared/enums/targets";
import { projectRoleDetails, type RoleMember, type RoleSeed } from "./roles";

/**
 * 角色定义投影（MATT-100）。
 *
 * ## 为什么测这个纯函数，不测 `listRoleDetails` 本体
 *
 * 本体一进去就连库（`mn_role` ⋈ `mn_app_user_role` ⋈ `mn_app_user`），而 `pnpm verify`
 * 的口径是**离线可跑**（先例：`matters.spec.ts` 抽 `resolveClosingDate`、`risks.spec.ts`
 * 不测 `convertToCase` 本体）。投影那三步——按角色计数、按角色归并成员、
 * **按 `includeMembers` 决定成员清单给还是不给**——全是纯逻辑，抽出来就能在无库环境下钉死。
 *
 * ## 这一层钉的三件事
 *
 * ① **计数与成员都按角色归并**（不是全局摊平）：两个角色各 1 人时不能都数成 2；
 * ② **`members` 为 null 与计数是两条独立输入** —— 计数**必给**（不指名道姓），
 *    名单可为 null。这是票面权限门在服务层的落点，也是"只给计数"与"给花名册"的分界。
 *    ⚠ 初版把两者写成一份 `grants` 的两种投影，结果"无权限"顺手把计数也连坐成 0。
 *    所以下面有一组**专钉这个**的断言（实机两个账号对撞才发现的，纯函数单测漏了）；
 * ③ **`dataScope` 原样是 code**（`all`/`participating`/`owned`），**不在这一层翻译中文** ——
 *    标签只在页面走 `DATA_SCOPE_LABELS`，服务层抄一份就是第二份中文（票面明令禁止）。
 */

/** 5 个内置角色的形状（`mn_role` 的可见列）。id 与 seed 的预留低号段一致。 */
const ROLES: RoleSeed[] = [
  {
    id: "10",
    code: "sys_admin",
    name: "系统管理",
    dataScope: "owned",
    canUnarchive: false,
    canReadPlain: false,
    canManageUser: true,
    canManageConfig: true,
    isSystem: true,
  },
  {
    id: "11",
    code: "full_admin",
    name: "全局管理",
    dataScope: "all",
    canUnarchive: true,
    canReadPlain: true,
    canManageUser: false,
    canManageConfig: false,
    isSystem: true,
  },
  {
    id: "12",
    code: "full_operator",
    name: "全局经办",
    dataScope: "all",
    canUnarchive: false,
    canReadPlain: false,
    canManageUser: false,
    canManageConfig: false,
    isSystem: true,
  },
  {
    id: "13",
    code: "joined_operator",
    name: "参与经办",
    dataScope: "participating",
    canUnarchive: false,
    canReadPlain: false,
    canManageUser: false,
    canManageConfig: false,
    isSystem: true,
  },
  {
    id: "14",
    code: "self_operator",
    name: "承办经办",
    dataScope: "owned",
    canUnarchive: false,
    canReadPlain: false,
    canManageUser: false,
    canManageConfig: false,
    isSystem: true,
  },
];

/**
 * 库里的真实授予：只有 `admin`（id 101），同时持 sys_admin(10) + full_admin(11)。
 * 计数与名单是**两份独立的输入**（这正是修掉"计数被连坐"的那个形状）。
 */
const COUNTS = new Map<string, number>([
  ["10", 1], // sys_admin
  ["11", 1], // full_admin
]);

const MEMBERS = new Map<string, RoleMember[]>([
  ["10", [{ id: "101", username: "admin", displayName: "系统管理员" }]],
  ["11", [{ id: "101", username: "admin", displayName: "系统管理员" }]],
]);

describe("projectRoleDetails：按角色归并成员与计数", () => {
  it("只出传进来的角色，顺序不变（5 个内置角色按 id 升序）", () => {
    const out = projectRoleDetails(ROLES, COUNTS, MEMBERS);
    expect(out.map((r) => r.code)).toEqual([
      "sys_admin",
      "full_admin",
      "full_operator",
      "joined_operator",
      "self_operator",
    ]);
  });

  it("同一人的两个角色**各算一次**（计数按角色归并，不是把人去重）", () => {
    const out = projectRoleDetails(ROLES, COUNTS, MEMBERS);
    expect(out.find((r) => r.code === "sys_admin")!.holderCount).toBe(1);
    expect(out.find((r) => r.code === "full_admin")!.holderCount).toBe(1);
  });

  it("没人持有的角色是 **0**，不是 null、也不是省略（页面上写「0 人持有」）", () => {
    const out = projectRoleDetails(ROLES, COUNTS, MEMBERS);
    for (const code of ["full_operator", "joined_operator", "self_operator"]) {
      expect(out.find((r) => r.code === code)!.holderCount).toBe(0);
    }
  });

  it("成员摘要只带「账号 / 姓名 / id」，不摊开账号表的其他列", () => {
    const out = projectRoleDetails(ROLES, COUNTS, MEMBERS);
    const members = out.find((r) => r.code === "full_admin")!.members;
    expect(members).toEqual([{ id: "101", username: "admin", displayName: "系统管理员" }]);
  });

  it("没人持有的角色成员清单是**空数组**（不是 null：给了成员档就该给空清单）", () => {
    const out = projectRoleDetails(ROLES, COUNTS, MEMBERS);
    expect(out.find((r) => r.code === "full_operator")!.members).toEqual([]);
  });
});

describe("projectRoleDetails：成员名单可以是 null，计数**从不**跟着消失", () => {
  it("**名单为 null ⇒ `members` 为 null，`holderCount` 原样保留**", () => {
    const out = projectRoleDetails(ROLES, COUNTS, null);
    for (const r of out) {
      expect(r.members).toBeNull();
    }
    expect(out.find((r) => r.code === "sys_admin")!.holderCount).toBe(1);
    expect(out.find((r) => r.code === "full_operator")!.holderCount).toBe(0);
  });

  /**
   * 反向红的锚点（实机缺陷的回归守卫）。
   *
   * 初版 `listRoleDetails` 在无 `canManageUser` 时**根本不查授予行**，
   * 于是 5 个角色全报「0 人持有」——多人在场的库上那是**假读数**，
   * 而票面明写"看不到成员时**只给计数**"。纯函数从没坏过（它总是收到一份 grants），
   * 坏的是接线；所以这条断言钉的是**投影对"只有计数、没有名单"这个输入的处置**。
   *
   * 真实症状（2026-10-18 实测，两个账号对撞）：
   *   sys_admin（有 canManageUser）→ 计数 2 / 有名单
   *   full_admin（无）             → 计数 **0** ← 应为 2，页面上写「共 0 人持有」
   */
  it("只有计数、没有名单时，**计数照给**（这是实机缺陷的回归守卫）", () => {
    const out = projectRoleDetails(ROLES, COUNTS, null);
    expect(out.find((r) => r.code === "sys_admin")!.holderCount).toBe(1);
    expect(out.find((r) => r.code === "full_admin")!.holderCount).toBe(1);
    expect(out.every((r) => r.members === null)).toBe(true);
  });

  it("只有计数时，**总数与给名单时相等**（收窄不该改变任何数字）", () => {
    const full = projectRoleDetails(ROLES, COUNTS, MEMBERS);
    const narrow = projectRoleDetails(ROLES, COUNTS, null);
    expect(full.map((r) => r.holderCount)).toEqual(narrow.map((r) => r.holderCount));
  });

  it("计数里没有的角色按 **0** 处理，不是 undefined（页面上要写「0 人持有」）", () => {
    const out = projectRoleDetails(ROLES, new Map([["10", 3]]), null);
    expect(out.find((r) => r.code === "sys_admin")!.holderCount).toBe(3);
    expect(out.find((r) => r.code === "full_admin")!.holderCount).toBe(0);
  });

  it("收窄只动成员清单：角色定义（code / name / 范围 / 四项特权）两档**逐字相同**", () => {
    const full = projectRoleDetails(ROLES, COUNTS, MEMBERS);
    const narrow = projectRoleDetails(ROLES, COUNTS, null);
    const define = (r: (typeof full)[number]) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      dataScope: r.dataScope,
      canUnarchive: r.canUnarchive,
      canReadPlain: r.canReadPlain,
      canManageUser: r.canManageUser,
      canManageConfig: r.canManageConfig,
      isSystem: r.isSystem,
    });
    expect(full.map(define)).toEqual(narrow.map(define));
  });
});

describe("projectRoleDetails：dataScope 原样是 code，不在服务层翻译", () => {
  it("返回的仍是 `all` / `participating` / `owned` 三个 code 之一", () => {
    const out = projectRoleDetails(ROLES, COUNTS, MEMBERS);
    for (const r of out) {
      expect(Object.keys(DATA_SCOPE_LABELS)).toContain(r.dataScope);
    }
  });

  it("**不返回中文标签**（第二份中文就是票面明令禁止的那份）", () => {
    const out = projectRoleDetails(ROLES, COUNTS, MEMBERS);
    const zhValues = Object.values(DATA_SCOPE_LABELS).map((l) => l.zh);
    for (const r of out) {
      expect(zhValues).not.toContain(r.dataScope);
    }
  });
});
