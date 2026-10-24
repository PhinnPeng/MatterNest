import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 状态变更对话框的**端点来源**（2026-10-24 修的一处真缺陷）。
 *
 * ## 缺陷是什么
 *
 * 组件把 `/api/matters/...` 写死，而事项详情也复用了它 ⇒ 在事项上点「变更状态」，
 * 请求带着一个**事项 id** 打到**案件**端点。雪花 id 跨表唯一，所以拿到 404。
 * 服务端那条路一直是好的（`agent-work/smoke-risk.mjs:144` 打的就是它），
 * 坏的只有入口 —— 而没有任何测试覆盖这个位置。
 *
 * ## 为什么是源码断言
 *
 * 本仓没有组件测试栈（`vitest` 只跑 node 环境）。这条断言抓的是一类具体形状：
 * **硬编码宿主前缀**。它能抓的与不能抓的必须写清：
 *
 *   · 抓得到：有人把 URL 改回 `/api/matters/...`、或新增一处绕过 `base` 的请求；
 *   · 抓不到：`base` 的映射本身写反（`"matters"` / `"risk-matters"` 互换）。
 *     那个由真库冒烟把关 —— 两侧各有一条 `POST /{host}/{id}/status` 的断言。
 *
 * `StatusTarget.host` 是**必填**字段，所以"调用方忘了传宿主"是编译错误，不靠这条断言。
 */
const src = readFileSync("src/app/components/status-dialog.tsx", "utf8");

/**
 * 剥掉注释再断言。**必须剥**：文件头那段注释为了说清缺陷，
 * 正好写着 `/api/matters/...` —— 不剥的话这条断言会红在解释文字上，
 * 而不是红在代码上（与本仓 `enum-check.spec.ts` 剥注释同一条理由）。
 */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/\s\/\/.*$/gm, "");

describe("状态变更对话框：端点由宿主决定，不写死", () => {
  it("基址按 target.host 拼（与 export-file-button 同一写法）", () => {
    expect(code).toContain('const base = target?.host === "matter" ? "matters" : "risk-matters";');
  });

  it("没有任何写死的宿主前缀 —— 那是本次缺陷的形状", () => {
    expect(code, "对话框里又出现写死的案件端点：事项详情会再次打到 404").not.toMatch(
      /\/api\/matters\//,
    );
    expect(code, "对话框里出现了写死的事项端点：案件侧同样会打到 404").not.toMatch(
      /\/api\/risk-matters\//,
    );
  });

  it("提交与归档就绪都走 base", () => {
    expect(code).toContain("`/api/${base}/${target.id}/status`");
    expect(code).toContain("`/api/${base}/${target?.id}/archive-readiness`");
  });

  it("归档就绪只对案件侧查（事项没有那三项的数据源）", () => {
    expect(code).toContain('const hasReadiness = target?.host === "matter";');
    expect(code).toContain("enabled: open && archiving && hasReadiness && !!target?.id");
    // 那块提示也要一起关掉：不发查询却画一块"读不到就绪"的告警，比不画更糟
    expect(code).toContain("{archiving && hasReadiness ? (");
  });

  it("解析器没空转：剥注释之后请求与宿主字段都还在", () => {
    // 先证明剥离没把真代码一起吃掉 —— 否则上面几条"不包含"可以恒真
    expect(code).toContain("export type StatusTarget = {");
    expect(code).toContain("host: HostKind;");
    expect(code).toContain("api.post(");
    expect(code).toContain("api.get<{ readiness: Readiness | null }>(");
  });
});
