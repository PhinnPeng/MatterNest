import { describe, expect, it } from "vitest";
import { UnknownPartyError, batchKeyOf, pickPartyLink, type PartyLinkInput } from "./parties";

const base: PartyLinkInput = {
  partyRole: "plaintiff",
  represented: true,
  name: "江苏恒基建设集团有限公司",
  type: "legal_person",
  idNumber: "91320100MA1X00001A",
};

/**
 * 建案时"引用既有当事人 vs 再建一行"的判定（master F2-15、修订稿 §6.2）。
 *
 * 为什么单独测这层纯函数：外层 `planPartyLinks` 要连库，而 `pnpm verify` 的口径是离线可跑。
 * 抽出来的正是四条最容易写反、且写错后**永不报错**的分支 —— 尤其是第四条：
 * 同名自动合并会把两家不相干的公司并成一行，从此当事人详情页的"涉及案件"少一半。
 */
describe("pickPartyLink：四条分支", () => {
  it("给了 partyId 就引用既有行，不看名称", () => {
    const r = pickPartyLink({ ...base, partyId: "6001" }, { byId: 6001n }, 9n);
    expect(r.decision).toEqual({ kind: "link", partyId: 6001n });
  });

  it("partyId 指向库里没有的行 → 硬失败，不降级成新建", () => {
    expect(() => pickPartyLink({ ...base, partyId: "9999" }, { byId: null }, 9n)).toThrow(
      UnknownPartyError,
    );
  });

  it("证件号精确命中就复用（与 uk_mn_party_identity 同口径）", () => {
    const r = pickPartyLink(base, { byIdentity: 6001n }, 9n);
    expect(r.decision).toEqual({ kind: "link", partyId: 6001n });
  });

  it("同一批次里第二行同证件号：复用刚生成的那个 id，而不是再插一行", () => {
    const r = pickPartyLink(base, { inBatch: 7001n }, 9n);
    expect(r.decision).toEqual({ kind: "link", partyId: 7001n });
  });

  it("只有同名 → 新建 + 回提示，**绝不自动合并**", () => {
    const r = pickPartyLink(
      { ...base, idNumber: null },
      { sameName: [{ id: 6001n, name: base.name! }] },
      7002n,
    );
    expect(r.decision).toEqual({
      kind: "create",
      partyId: 7002n,
      name: base.name,
      type: base.type,
    });
    expect(r.conflicts).toEqual([{ partyId: "6001", name: base.name, row: 0 }]);
  });

  it("什么都没命中 → 新建，且 id 用传入的那个（事务外算好，事务里才插）", () => {
    const r = pickPartyLink(base, {}, 7003n);
    expect(r.decision).toMatchObject({ kind: "create", partyId: 7003n });
    expect(r.conflicts).toEqual([]);
  });

  it("空白证件号按未填处理，不去查 byIdentity", () => {
    const r = pickPartyLink({ ...base, idNumber: "   " }, { byIdentity: 6001n }, 7004n);
    // 未填证件号 ⇒ 不参与精确命中（同名的两家小公司最容易被这种值并掉）
    expect(r.decision.kind).toBe("create");
  });
});

describe("batchKeyOf：批次内去重的键", () => {
  it("无证件号不给键（不给「同名即同一行」留机会）", () => {
    expect(batchKeyOf("legal_person", null)).toBeNull();
    expect(batchKeyOf("legal_person", "")).toBeNull();
  });

  it("同类型不同证件号是两条键", () => {
    expect(batchKeyOf("legal_person", "A")).not.toBe(batchKeyOf("legal_person", "B"));
    expect(batchKeyOf("natural_person", "A")).not.toBe(batchKeyOf("legal_person", "A"));
  });
});
