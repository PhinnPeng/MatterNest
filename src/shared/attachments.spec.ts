import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_ACCEPT_ATTR,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_COMMENT,
  ATTACHMENT_MIME_BY_EXT,
  extensionOf,
  mimeForFileName,
} from "./attachments";

/**
 * 附件规则的**单一来源**测试。
 *
 * 这些断言看着琐碎，挡的是同一类事故：前端按一份规则放行、服务端按另一份拒收。
 * 两边的规则现在都从这里 import，所以这组用例实际守的是"这份表本身对不对"。
 */
describe("attachment rules", () => {
  it("扩展名：取最后一段、小写、容忍整条路径", () => {
    expect(extensionOf("合同.PDF")).toBe("pdf");
    expect(extensionOf("C:\\Users\\a\\证据.jpeg")).toBe("jpeg");
    expect(extensionOf("/tmp/archive.tar.gz")).toBe("gz");
    expect(extensionOf("无扩展名")).toBe("");
    expect(extensionOf(".bashrc")).toBe("");
  });

  it("白名单按 §7.1 收，命中给服务端认定的 MIME", () => {
    for (const name of [
      "a.pdf",
      "b.doc",
      "c.docx",
      "d.xls",
      "e.xlsx",
      "f.png",
      "g.jpg",
      "h.jpeg",
      "i.zip",
    ]) {
      expect(mimeForFileName(name), name).toBe(ATTACHMENT_MIME_BY_EXT[extensionOf(name)]);
    }
  });

  it("白名单之外一律 null（包括把 html 改名的情形）", () => {
    for (const name of ["a.html", "a.exe", "a.svg", "a.txt", "a", "a.pdf.exe"]) {
      expect(mimeForFileName(name), name).toBeNull();
    }
  });

  it("accept 属性与白名单同源（加白名单不必再改一处 HTML）", () => {
    const accept = ATTACHMENT_ACCEPT_ATTR.split(",");
    expect(accept).toHaveLength(Object.keys(ATTACHMENT_MIME_BY_EXT).length);
    expect(accept).toContain(".pdf");
    expect(accept).toContain(".zip");
  });

  it("三个上限与 §7.1 一致", () => {
    expect(ATTACHMENT_MAX_BYTES).toBe(50 * 1024 * 1024);
    expect(ATTACHMENT_MAX_PER_COMMENT).toBe(10);
  });
});
