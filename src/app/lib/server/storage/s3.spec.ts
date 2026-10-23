import { describe, expect, it } from "vitest";

import { loadStorageConfig, presignUrl, type StorageConfig } from "./s3";

/**
 * SigV4 预签名的**纯函数**测试（与真服务端的往返由 `pnpm storage:check` 负责）。
 *
 * 这里能守住的是"输入进 → URL 出"的确定性、编码与签名参数齐全；
 * 签名对不对**不能**由这些用例证明（它们只证明"没变"）。两者分工写在 `s3.ts` 头注里。
 */
const config: StorageConfig = {
  endpoint: "http://127.0.0.1:30090",
  bucket: "mn-attachments",
  accessKey: "AKIATEST",
  secretKey: "SECRETTEST",
  region: "us-east-1",
  getSeconds: 60,
};
const at = new Date("2026-10-22T08:15:00.000Z");

describe("presignUrl", () => {
  it("同一输入与同一时刻给出同一个 URL（纯函数）", () => {
    const a = presignUrl(config, {
      method: "PUT",
      key: "att/abc",
      expiresIn: 60,
      contentType: "application/pdf",
      now: at,
    });
    const b = presignUrl(config, {
      method: "PUT",
      key: "att/abc",
      expiresIn: 60,
      contentType: "application/pdf",
      now: at,
    });
    expect(a).toBe(b);
  });

  it("PUT：把 content-type 与 host 签进去", () => {
    const url = new URL(
      presignUrl(config, {
        method: "PUT",
        key: "att/abc",
        expiresIn: 900,
        contentType: "image/png",
        now: at,
      }),
    );
    expect(url.pathname).toBe("/mn-attachments/att/abc");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-type;host");
    expect(url.searchParams.get("X-Amz-Date")).toBe("20261022T081500Z");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("GET：下载一律 attachment，中文名走 RFC 5987 且括号转义", () => {
    const url = new URL(
      presignUrl(config, {
        method: "GET",
        key: "att/abc",
        expiresIn: 60,
        downloadName: "证据 (1).pdf",
        now: at,
      }),
    );
    const disposition = url.searchParams.get("response-content-disposition");
    expect(disposition).toBe("attachment; filename*=UTF-8''%E8%AF%81%E6%8D%AE%20%281%29.pdf");
    expect(url.searchParams.get("response-content-type")).toBe("application/octet-stream");
  });

  it("换方法 / 换过期时间都会换签名（参数真的进了规范串）", () => {
    const put = presignUrl(config, {
      method: "PUT",
      key: "att/abc",
      expiresIn: 60,
      contentType: "text/plain",
      now: at,
    });
    const del = presignUrl(config, { method: "DELETE", key: "att/abc", expiresIn: 60, now: at });
    const longer = presignUrl(config, {
      method: "PUT",
      key: "att/abc",
      expiresIn: 120,
      contentType: "text/plain",
      now: at,
    });
    const sig = (u: string) => new URL(u).searchParams.get("X-Amz-Signature");
    expect(sig(put)).not.toBe(sig(del));
    expect(sig(put)).not.toBe(sig(longer));
  });

  it("过期时间被夹到至少 1 秒（0 或负数会让 URL 立刻失效且难查）", () => {
    const url = new URL(
      presignUrl(config, { method: "GET", key: "att/abc", expiresIn: 0, now: at }),
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("1");
  });
});

describe("loadStorageConfig", () => {
  it("缺任何一个值都返回 null（不抛：'没开通'与'配错了'要分开）", () => {
    expect(loadStorageConfig({})).toBeNull();
    expect(
      loadStorageConfig({
        MINIO_ENDPOINT: "http://127.0.0.1:30090",
        MINIO_BUCKET: "b",
        MINIO_ACCESS_KEY: "",
        MINIO_SECRET_KEY: "s",
      }),
    ).toBeNull();
  });

  it("去掉 endpoint 的尾斜杠，并按默认值补齐 region / 下载有效期", () => {
    const c = loadStorageConfig({
      MINIO_ENDPOINT: "http://127.0.0.1:30090/",
      MINIO_BUCKET: "mn-attachments",
      MINIO_ACCESS_KEY: "a",
      MINIO_SECRET_KEY: "s",
    });
    expect(c?.endpoint).toBe("http://127.0.0.1:30090");
    expect(c?.region).toBe("us-east-1");
    expect(c?.getSeconds).toBe(60);
  });
});
