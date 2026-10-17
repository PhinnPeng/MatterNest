import { describe, expect, it } from "vitest";

import {
  DEFAULT_IMPORT_VARIANT,
  buildImportPayload,
  checkImportPayload,
  fileSizeLabel,
  importCounts,
  importPayloadError,
  isImportDenied,
  variantOf,
} from "./import-ui";
import { ApiFailure } from "./api";

/**
 * 导入页（P14 / MATT-67）**纯逻辑**那一半的守卫。
 *
 * 为什么这些值得离线测（而不是只靠真浏览器探针）：
 *   · 真浏览器探针要真库、真上传、真 81 秒导入，跑一次很贵；而"两个数怎么算出来的"
 *     "403 怎么识别""提交前那道校验说什么"全是**没有 DOM 也成立**的判断，
 *     放在这里能在毫秒级把口径钉住。
 *   · 探针断的是"页面上的两个数与接口返回一致"（票面第 7 条），
 *     而"页面上的两个数不低于接口返回"这条**恒等式**在这里是逐条钉的 ——
 *     两者是同一条 AC 的两层，缺一层就会漏。
 */

describe("importCounts：已导入 / 未导入 两个数", () => {
  it("逐字取服务端的两个数，不自己相减", () => {
    const c = importCounts({ totalRows: 853, importedRows: 812, errorRows: 41 });
    expect(c.total).toBe(853);
    expect(c.imported).toBe(812);
    expect(c.error).toBe(41);
    expect(c.okPercent).toBe(95);
  });

  it("全成功时分母不为零、占比 100", () => {
    expect(importCounts({ totalRows: 10, importedRows: 10, errorRows: 0 }).okPercent).toBe(100);
  });

  it("零行文件不产生 NaN（分母为 0 时占比取 0，而不是 Infinity）", () => {
    expect(importCounts({ totalRows: 0, importedRows: 0, errorRows: 0 }).okPercent).toBe(0);
  });

  it("**计数不自洽就当场抛**，而不是画出一个骗人的进度条", () => {
    // total ≠ imported + error：宁可页面报错，也不要在界面上把三个数并排摆出来
    expect(() => importCounts({ totalRows: 10, importedRows: 3, errorRows: 4 })).toThrow(/不自洽/);
  });
});

describe("buildImportPayload / checkImportPayload", () => {
  it("载荷是 {hostType, fileName, csv} 三键（服务端要的就是这三个）", () => {
    expect(buildImportPayload("risk_matter", "台账.csv", "a,b\n1,2\n")).toEqual({
      hostType: "risk_matter",
      fileName: "台账.csv",
      csv: "a,b\n1,2\n",
    });
  });

  it("合法载荷通过（规则来自 shared 的 importRequestSchema，不是第二份手写校验）", () => {
    expect(checkImportPayload(buildImportPayload("matter", "a.csv", "x\n1\n")).ok).toBe(true);
  });

  it("空文件被拦（用的是 schema 里那句中文，不是前端另写的一句）", () => {
    const r = checkImportPayload(buildImportPayload("matter", "a.csv", ""));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(importPayloadError(r.issues)).toBe("文件是空的");
  });

  it("超大文件被拦，说的是 schema 里的「拆成多次导入」", () => {
    const r = checkImportPayload(buildImportPayload("matter", "a.csv", "x".repeat(2_000_001)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(importPayloadError(r.issues)).toContain("拆成多次导入");
  });

  it("文件名超长（> 200）**不把 zod 的英文默认串漏到界面上**", () => {
    const r = checkImportPayload(buildImportPayload("matter", "长".repeat(201), "x\n1\n"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const msg = importPayloadError(r.issues);
      expect(msg).toBe("文件名太长");
      // zod 的 max_length 默认文案是英文的（schema 里这一处没写 message），
      // 直接透传会让用户看到 "Too big: expected string to have <=200 characters"
      expect(msg).not.toMatch(/expected|characters/);
    }
  });
});

describe("isImportDenied：403 的 UI 面", () => {
  it("403 才是「你没有导入权」，而不是「页面坏了」", () => {
    expect(isImportDenied(new ApiFailure(403, { error: "import_forbidden", message: "…" }))).toBe(
      true,
    );
  });

  it("500 不算拒绝 —— 那是服务端坏了，该走错误态而不是权限文案", () => {
    expect(isImportDenied(new ApiFailure(500, { error: "boom", message: "…" }))).toBe(false);
  });

  it("非 ApiFailure（网络异常）也不算", () => {
    expect(isImportDenied(new Error("fetch failed"))).toBe(false);
    expect(isImportDenied(undefined)).toBe(false);
  });
});

describe("variantOf：三变体排列的入口（**未定稿**，只是可切换的外壳）", () => {
  it("缺省是 C（父代理建议值），但这不是「已定稿」——用户选定前一直可切", () => {
    expect(DEFAULT_IMPORT_VARIANT).toBe("C");
    expect(variantOf(undefined)).toBe("C");
    expect(variantOf(null)).toBe("C");
  });

  it("认 A/B/C（大小写不敏感）", () => {
    expect(variantOf("A")).toBe("A");
    expect(variantOf("b")).toBe("B");
    expect(variantOf("c")).toBe("C");
  });

  it("不认识的取值退回缺省，而不是渲染出一个空页", () => {
    expect(variantOf("Z")).toBe("C");
    expect(variantOf("")).toBe("C");
  });
});

describe("fileSizeLabel", () => {
  it("按量级换单位，不给用户看 274432 这种字节数", () => {
    expect(fileSizeLabel(512)).toBe("512 B");
    expect(fileSizeLabel(268 * 1024)).toBe("268 KB");
    expect(fileSizeLabel(1024 * 1024)).toBe("1.0 MB");
    expect(fileSizeLabel(1536 * 1024)).toBe("1.5 MB");
  });
});
