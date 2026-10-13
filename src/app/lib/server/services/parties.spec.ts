import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  UnknownPartyError,
  batchKeyOf,
  isOwnCompanyName,
  ownCompanyNames,
  partiesCsv,
  pickPartyLink,
  type PartyLinkInput,
} from "./parties";
// `maskValue` 随 MATT-47 搬到 `services/exports.ts`：脱敏规则现在由当事人导出与
// 整卷导出**共用一份**实现（两处各写一遍的失败形态是同一份证件号两种脱敏结果）。
import { maskValue } from "./exports";
import { MAX_MERGED_PARTIES, MergeInputError, normalizeMergeInput } from "./party-merge";
import {
  blindIndex,
  decryptField,
  encryptField,
  isEncrypted,
  parseKeyMaterial,
} from "../crypto/field-crypto";

const base: PartyLinkInput = {
  partyRole: "plaintiff",
  name: "江苏恒基建设集团有限公司",
  type: "legal_person",
  idNumber: "91320100MA1X00001A",
};

/**
 * 建案时"引用既有当事人 vs 再建一行"的判定（master F2-15、修订稿 §6.2），
 * 加上 MATT-40 的三块：本企业名防呆、合并入参规范化、加密与盲索引。
 *
 * 为什么单独测这层纯函数：外层 `planPartyLinks` 要连库，而 `pnpm verify` 的口径是离线可跑。
 * 抽出来的正是最容易写反、且写错后**永不报错**的分支 —— 尤其是第四条：
 * 同名自动合并会把两家不相干的公司并成一行，从此当事人详情页的"涉及案件"少一半。
 *
 * ⚠ 加解密与 CSV 的用例也住在这个文件里：本票的写范围只给了这一个 spec 文件
 * （`field-crypto.ts` 与 `parties.ts` 是一起交付的两块，用例跟着票走而不是跟着文件走）。
 */
describe("pickPartyLink：五条分支", () => {
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

  it("**名称是本企业 → reject**，即使证件号在库里命中也不复用（IQ-7 的闸门）", () => {
    const r = pickPartyLink(base, { ownCompany: true, byIdentity: 6001n }, 7005n);
    expect(r.decision).toEqual({ kind: "reject", reason: "own_company", name: base.name });
  });

  it("引用既有（带 partyId）时防呆不参与：本企业名的既有行仍可被引用", () => {
    // 防呆挡的是"建档"，不是"引用"。库里那 5 行演示数据里就有一行是本企业名（历史遗留），
    // 若连引用都拒，老案卷的当事人区会当场打不开 —— 那是把防呆做成了破坏性变更。
    const r = pickPartyLink({ ...base, partyId: "6001" }, { byId: 6001n, ownCompany: true }, 9n);
    expect(r.decision).toEqual({ kind: "link", partyId: 6001n });
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

/**
 * 本企业名防呆（IQ-7）。判据只有一条：**完全相等**（trim + 大小写无关）。
 * 包含匹配会把"某某集团财务有限公司"这类真对手方也挡掉，用户只会绕开这道闸门。
 */
describe("isOwnCompanyName：本企业名判定", () => {
  const names = ["江苏恒基建设集团有限公司", "Hengji Group"];

  it("完全相等命中（trim 与大小写都归一）", () => {
    expect(isOwnCompanyName("  江苏恒基建设集团有限公司 ", names)).toBe(true);
    expect(isOwnCompanyName("hengji group", names)).toBe(true);
  });

  it("**包含匹配不算**：名字里带本企业名的另一家法人不该被挡", () => {
    expect(isOwnCompanyName("江苏恒基建设集团财务有限公司", names)).toBe(false);
    expect(isOwnCompanyName("江苏恒基", names)).toBe(false);
  });

  it("空名与空白不算（防呆不该把「没填」当成本企业）", () => {
    expect(isOwnCompanyName("   ", names)).toBe(false);
    expect(isOwnCompanyName("", names)).toBe(false);
  });

  it("没配别名表时任何名字都不算命中（读路径的口径：不知道就不提示）", () => {
    expect(isOwnCompanyName("江苏恒基建设集团有限公司", [])).toBe(false);
  });
});

describe("ownCompanyNames：环境变量读取", () => {
  const before = process.env.MN_OWN_COMPANY_NAMES;
  beforeAll(() => {
    process.env.MN_OWN_COMPANY_NAMES = " 甲公司 ，乙公司, 丙公司 ";
  });
  afterAll(() => {
    if (before === undefined) delete process.env.MN_OWN_COMPANY_NAMES;
    else process.env.MN_OWN_COMPANY_NAMES = before;
  });

  it("中英文逗号都认，逐个 trim", () => {
    expect([...ownCompanyNames()]).toEqual(["甲公司", "乙公司", "丙公司"]);
  });

  it("**没配就抛**，不静默跳过防呆（跳过＝我方可以再次被建进当事人表）", () => {
    const keep = process.env.MN_OWN_COMPANY_NAMES;
    delete process.env.MN_OWN_COMPANY_NAMES;
    expect(() => ownCompanyNames()).toThrow(/MN_OWN_COMPANY_NAMES/);
    process.env.MN_OWN_COMPANY_NAMES = keep;
  });
});

/**
 * 合并入参规范化。三条都对应一次真实误用：
 *   · 表单把"当前这条"也带上 → 丢掉而不是报错；
 *   · 重复勾了同一条 → 去重（否则同一行会被改挂两次，第二次 update 影响 0 行，看着像成功）；
 *   · 一条不剩 → 报错（"把 A 并进 A"静默成功会让人以为做了什么）。
 */
describe("normalizeMergeInput：合并入参", () => {
  it("主记录出现在被并方里 → 丢掉", () => {
    expect(normalizeMergeInput(1n, [1n, 2n]).mergedIds).toEqual([2n]);
  });

  it("重复 id 去重", () => {
    expect(normalizeMergeInput(1n, [2n, 2n, 3n]).mergedIds).toEqual([2n, 3n]);
  });

  it("去掉之后一条不剩 → MergeInputError（不是静默成功）", () => {
    expect(() => normalizeMergeInput(1n, [1n])).toThrow(MergeInputError);
    expect(() => normalizeMergeInput(1n, [])).toThrow(MergeInputError);
  });

  it("超过上限 → MergeInputError（再多不是运维动作，是数据事故）", () => {
    const many = Array.from({ length: MAX_MERGED_PARTIES + 1 }, (_, i) => BigInt(i + 10));
    expect(() => normalizeMergeInput(1n, many)).toThrow(MergeInputError);
  });
});

/* ───────────────── 加密与盲索引（B7 的存储层那一层） ───────────────── */

/**
 * 密钥在测试里**当场随机生成**：仓库里永不留值（`.env` 也 gitignore），
 * 所以离线跑 `pnpm verify` 时这两把钥匙本来就不存在 —— 在这里补上，
 * 顺便证明"缺密钥必须抛"那条（下面的 parseKeyMaterial 用例）。
 */
const AES_KEY = randomBytes(32).toString("base64url");
const HMAC_KEY = randomBytes(32).toString("base64url");

describe("field-crypto：字段加密与盲索引", () => {
  const beforeAes = process.env.MN_AES_KEY;
  const beforeHmac = process.env.MN_HMAC_KEY;
  beforeAll(() => {
    process.env.MN_AES_KEY = AES_KEY;
    process.env.MN_HMAC_KEY = HMAC_KEY;
  });
  afterAll(() => {
    if (beforeAes === undefined) delete process.env.MN_AES_KEY;
    else process.env.MN_AES_KEY = beforeAes;
    if (beforeHmac === undefined) delete process.env.MN_HMAC_KEY;
    else process.env.MN_HMAC_KEY = beforeHmac;
  });

  it("往返一致，且密文带 v1 信封（自描述版本，不另开列）", () => {
    const c = encryptField("91320100MA1X00001A");
    expect(c.startsWith("v1:")).toBe(true);
    expect(isEncrypted(c)).toBe(true);
    expect(decryptField(c)).toBe("91320100MA1X00001A");
  });

  it("**同一明文两次加密结果不同**（随机 IV）—— 这正是明文唯一索引必须换成盲索引的原因", () => {
    const a = encryptField("320102199001011234");
    const b = encryptField("320102199001011234");
    expect(a).not.toBe(b);
    expect(decryptField(a)).toBe(decryptField(b));
  });

  it("密文被改一个字节 → 抛（GCM 认证标签），**不返回乱码**", () => {
    const c = encryptField("320102199001011234");
    const tampered = `${c.slice(0, -2)}${c.endsWith("AA") ? "BB" : "AA"}`;
    expect(() => decryptField(tampered)).toThrow();
  });

  it("空值给 null（列可空），不是空串", () => {
    expect(decryptField(null)).toBeNull();
    expect(decryptField(undefined)).toBeNull();
    expect(decryptField("")).toBeNull();
  });

  it("**没有信封的值原样返回**：迁移 0009 之前的存量明文仍读得出来（过渡读法）", () => {
    expect(decryptField("91320100MA1X00001A")).toBe("91320100MA1X00001A");
    expect(isEncrypted("91320100MA1X00001A")).toBe(false);
  });

  it("盲索引确定、trim 后等价（同一证件号必须算出同一个哈希，否则查重失效）", () => {
    expect(blindIndex("91320100MA1X00001A")).toBe(blindIndex("  91320100MA1X00001A "));
    expect(blindIndex("91320100MA1X00001A")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("盲索引区分大小写（查重口径与迁移前的明文精确比较逐字不变）", () => {
    expect(blindIndex("91320100MA1X00001a")).not.toBe(blindIndex("91320100MA1X00001A"));
  });

  it("盲索引有域分隔：同一个值换一列就是另一个哈希", () => {
    expect(blindIndex("13800000000", "party.contact")).not.toBe(blindIndex("13800000000"));
  });

  it("parseKeyMaterial：缺值 / 长度不对都抛，且错误信息里带生成命令", () => {
    expect(() => parseKeyMaterial(undefined, "MN_AES_KEY", 32)).toThrow(/randomBytes\(32\)/);
    expect(() => parseKeyMaterial("short", "MN_AES_KEY", 32)).toThrow(/MN_AES_KEY/);
    // 44 字符 base64url（32 字节）与 64 字符 hex 都认
    expect(parseKeyMaterial(AES_KEY, "MN_AES_KEY", 32)).toHaveLength(32);
    expect(parseKeyMaterial(randomBytes(32).toString("hex"), "MN_AES_KEY", 32)).toHaveLength(32);
  });
});

/* ───────────────── 导出两档（IQ-12 的第三重防线） ───────────────── */

describe("导出：脱敏档与 CSV 文本", () => {
  it("脱敏只留尾四位；短值全遮（留两位等于没遮）", () => {
    expect(maskValue("91320100MA1X00001A")).toBe("****001A");
    expect(maskValue("13800001234")).toBe("****1234");
    expect(maskValue("1234")).toBe("****");
    expect(maskValue(null)).toBe("");
  });

  it("CSV：BOM 开头（Excel 中文表头不乱码）、表头是中文、逗号/引号/换行都被处理", () => {
    const csv = partiesCsv([
      {
        name: '南京"鼎泰", 房地产',
        type: "legal_person",
        idType: "unified_social_credit",
        idNumber: "****0002B",
        contact: null,
        remark: "第一行\n第二行",
        matterCount: 2,
        riskCount: 1,
        updatedAt: "2026-10-14T00:00:00.000Z",
      },
    ]);
    expect(csv.startsWith("\uFEFF名称,类型,证件类型")).toBe(true);
    expect(csv).toContain('"南京""鼎泰"", 房地产"');
    expect(csv).toContain("法人");
    expect(csv).toContain("统一社会信用代码");
    // 换行折成空格：Excel 里"一行一条记录"才对得上
    expect(csv).toContain("第一行 第二行");
    expect(csv.split("\r\n")).toHaveLength(2);
  });

  it("空结果只给表头（不返回 undefined/半行）", () => {
    const csv = partiesCsv([]);
    expect(csv.split("\r\n")).toHaveLength(1);
  });
});

/* ───────────────── 源码守卫（两条 AC 的机器可核部分） ───────────────── */

const read = (p: string) => readFileSync(p, "utf8");

/**
 * 剥掉注释再匹配。
 *
 * 这不是"为了让测试变绿"的补丁：两条守卫要拦的都是**代码里真的出现了那个东西**
 * （一个账号列、一个明文开关），而代码旁边的注释必然会**写**这些词来解释"为什么不许"
 * —— 词级匹配会把说明文字自己拦下来（`tools/lint-guard/check.mjs` 的副标题断言
 * 就是为同一件事只匹配 JSX 属性形态的）。这里选择剥注释，比"只匹配属性形态"更准。
 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/**
 * US-M3-3 / Q29=A：对手方是（前）员工时**不特殊化、不关联任何系统账号**，
 * 要区分用标签表达（F3-6）。
 *
 * 这条是**否定式**的裁定，靠读代码证明"没做"比靠 review 可靠：一旦有人给 `mn_party`
 * 加一列 `user_id`（或让当事人服务去 join 账号表），案件数据与人事身份就被打通了，
 * 而 M6 的权限模型兜不住它 —— 症状是"某个离职员工能看到自己的旧案卷"，
 * 上线后极难归因。所以这里把两件事钉死：表上没有账号列、服务层不碰账号表对象。
 */
describe("守卫：员工类对手方不关联系统账号（US-M3-3）", () => {
  const hosts = read("src/app/lib/server/db/schema/hosts.ts");
  const partyBlock = hosts.slice(
    hosts.indexOf("export const party = pgTable"),
    hosts.indexOf("/** 转案件关联"),
  );

  it("party 表块里没有账号列（user_id / app_user 都不许出现）", () => {
    expect(partyBlock.length).toBeGreaterThan(500); // 切片没落空（落空会让断言假通过）
    expect(stripComments(partyBlock)).not.toMatch(/user_id|userId|appUser/);
  });

  it("当事人服务层不引用账号表对象（`mn_app_user` 只允许以裸 SQL 取登记人姓名）", () => {
    for (const f of [
      "src/app/lib/server/services/parties.ts",
      "src/app/lib/server/services/party-merge.ts",
    ]) {
      const src = stripComments(read(f));
      expect(src, `${f} 引用了 appUser 表对象：当事人与系统账号不许建立关联`).not.toMatch(
        /\bappUser\b/,
      );
    }
  });
});

/**
 * IQ-12：**展示层全明文、无"显示明文"按钮**。
 *
 * 这条在源码层可核：一旦有人把"遮起来 + 点一下看明文"做回来，那就是把已作废的
 * `SENSITIVE_FIELD_READ` 逐次审计重新发明一遍（既没留痕、又给人一个假的安全感）。
 * 真正需要留痕的是导出两档，那条链路上有 `canReadPlain` 与 `EXPORT`。
 */
describe("守卫：展示层没有「显示明文」这类开关（IQ-12）", () => {
  it("当事人两个界面文件里没有明文开关的文案", () => {
    for (const f of [
      "src/app/(desk)/parties/parties-view.tsx",
      "src/app/(desk)/parties/[id]/party-detail.tsx",
    ]) {
      const src = stripComments(read(f));
      expect(src.length).toBeGreaterThan(500);
      expect(src, `${f} 出现了明文开关文案：展示层应当直接是明文`).not.toMatch(
        /显示明文|查看明文|明文查看|脱敏展示/,
      );
    }
  });
});

/**
 * 「查重 hash 不变」的机器可核部分：唯一性挂在**盲索引列**上。
 * 迁移是唯一事实（`database-guidelines.md`），所以断言读 SQL 而不是读 TS。
 */
describe("守卫：唯一索引挂在 id_number_hash 上（加密后明文不可索引）", () => {
  it("迁移 0009 把 uk_mn_party_identity 换成 (type, id_number_hash)", () => {
    const sql = read("src/app/lib/server/db/migrations/0009_party_identity_and_merge.sql");
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "uk_mn_party_identity" ON "mn_party" USING btree ("type","id_number_hash")',
    );
    expect(sql).toContain('DROP INDEX IF EXISTS "uk_mn_party_identity"');
  });
});
