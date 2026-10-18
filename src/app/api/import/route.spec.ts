import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import type { Actor } from "@/app/lib/server/auth/auth";
import type { ImportSummary } from "@/app/lib/server/services/import";

/**
 * `POST /api/import` 的**预检门**（MATT-102）。
 *
 * 服务层整体 mock：本门钉的是**路由层**的三件事 ——
 *   ① `?dryRun=1` 真的传到了服务层（`runImport` 的第三个参数）；
 *   ② 缺省 / 非 "1" 的取值都当**真导**（否则一次手滑的 `?dryRun=0` 会静默只预检）；
 *   ③ `dryRun` 不挤进 body —— body 仍是 `importRequestSchema` 的 `.strict()` 契约。
 *
 * ⚠ 「预检与真导走**同一个** `runImport`」这件结构事实**不在这一层测**：
 * 路由两条分支调的是同一个 import 到的函数，mock 拦不到"它俩是不是同一个"。
 * 那条断言在 `services/import.ts` 的实现里由构造保证（同一个函数体、只在写库处分支），
 * 由 `import.spec.ts` 的纯函数断言与父代理的真库冒烟（同文件先 dryRun 再真导、
 * 两个响应一致）共同兜住。
 */
const { runImport, readActor, ImportFileError } = vi.hoisted(() => {
  class ImportFileError extends Error {
    constructor(readonly problem: { code: string; message: string }) {
      super(problem.message);
    }
  }
  return { runImport: vi.fn(), readActor: vi.fn(), ImportFileError };
});

vi.mock("@/app/lib/server/services/import", () => ({ runImport, ImportFileError }));
vi.mock("@/app/lib/server/auth/auth", () => ({ readActor }));

const ACTOR: Actor = {
  userId: "9001",
  displayName: "冒烟账号",
  dataScope: "all",
  isAdmin: false,
  isSystemOwner: false,
  privileges: {
    canUnarchive: false,
    canReadPlain: false,
    canManageUser: false,
    canManageConfig: false,
  },
};

const SUMMARY: ImportSummary = {
  batchId: "7001",
  hostType: "risk_matter",
  fileName: "台账.csv",
  totalRows: 3,
  importedRows: 2,
  errorRows: 1,
  replayed: false,
  reportRef: "7001",
  issues: [],
  issueTotal: 0,
  truncatedIssues: false,
};

const BODY = { hostType: "risk_matter", fileName: "台账.csv", csv: "a,b\n1,2\n" };

const post = (qs = "", body: unknown = BODY) =>
  POST(
    new Request(`http://127.0.0.1/api/import${qs}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  readActor.mockResolvedValue(ACTOR);
  runImport.mockResolvedValue(SUMMARY);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("?dryRun=1：预检开关走查询串", () => {
  it("`?dryRun=1` 把 {dryRun:true} 传到服务层", async () => {
    await post("?dryRun=1");
    expect(runImport).toHaveBeenCalledTimes(1);
    const [, , opts] = runImport.mock.calls[0] as [unknown, unknown, { dryRun?: boolean }];
    expect(opts).toEqual({ dryRun: true });
  });

  it("没有查询串时是真导（dryRun:false），不是「忘了传」", async () => {
    await post();
    const [, , opts] = runImport.mock.calls[0] as [unknown, unknown, { dryRun?: boolean }];
    expect(opts).toEqual({ dryRun: false });
  });

  it("`?dryRun=0` 之类的取值**被拒**（400），而不是悄悄当真导", async () => {
    // 只有 "1" 是预检。写 `?dryRun=true` 想要预检却落到真导，是一次静默的数据写入 ——
    // 所以取值不认就当场说清（400），不猜。
    const res = await post("?dryRun=0");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "validation_failed" });
    expect(runImport).not.toHaveBeenCalled();
  });

  it("`?dryRun=` 空值省略 ⇒ 真导（query() 丢掉空串）", async () => {
    await post("?dryRun=");
    expect((runImport.mock.calls[0] as [unknown, unknown, { dryRun?: boolean }])[2]).toEqual({
      dryRun: false,
    });
  });

  it("响应体就是服务层返回的同一个 ImportSummary（形状不因预检而变）", async () => {
    const res = await post("?dryRun=1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      hostType: "risk_matter",
      totalRows: 3,
      importedRows: 2,
      errorRows: 1,
    });
  });
});

describe("body 契约不受 dryRun 影响", () => {
  it("body 仍是 {hostType,fileName,csv} 三键（dryRun 不挤进去）", async () => {
    await post("?dryRun=1");
    expect((runImport.mock.calls[0] as [unknown, unknown, unknown])[1]).toEqual(BODY);
  });

  it("文件级错误照旧 400（预检不把解析错误吞成 200）", async () => {
    runImport.mockRejectedValueOnce(
      new ImportFileError({ code: "bad_header", message: "表头里有本模板不认识的列" }),
    );
    const res = await post("?dryRun=1");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_header" });
  });
});
