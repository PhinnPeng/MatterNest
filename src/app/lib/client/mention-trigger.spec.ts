import { describe, expect, it } from "vitest";

import { mentionTriggerAt } from "./mention-trigger";

/**
 * 「按 `@` 弹出的这一刻算不算选人」的三种边界。
 *
 * 为什么值得单测：这三条都不是"看起来对不对"能验的 —— 邮箱要等到有人贴地址才发现，
 * 空格收尾要等到有人打完一整个句子才发现。失败形态又都不报错（面板要么多弹、要么不弹）。
 */
describe("mentionTriggerAt", () => {
  it("行首的 @ 就是一次空查询", () => {
    expect(mentionTriggerAt("@", 1)).toEqual({ start: 0, query: "" });
  });

  it("取 @ 与光标之间的字，而不是整段话", () => {
    // 光标停在「系」与「统」之间：查询串只有已经打出来的那一个「系」
    expect(mentionTriggerAt("请 @系统管理员 看一下", 4)).toEqual({ start: 2, query: "系" });
  });

  it("中文句子紧跟 @（不留空格）也要触发", () => {
    // 中文没有词边界，写入口径也不要求；这里若要求空格，最常见的写法就选不了人
    expect(mentionTriggerAt("请@张三", 4)).toEqual({ start: 1, query: "张三" });
  });

  it("邮箱里的 @ 不触发", () => {
    expect(mentionTriggerAt("发到 a@", 5)).toBeNull();
    expect(mentionTriggerAt("发到 ops.team+x@", 15)).toBeNull();
  });

  it("查询串出现空格 / 换行即收尾", () => {
    expect(mentionTriggerAt("@小明 请", 5)).toBeNull();
    expect(mentionTriggerAt("@小明\n下一行", 7)).toBeNull();
  });

  it("下一个 @ 作废上一个", () => {
    expect(mentionTriggerAt("@张三@李", 5)).toEqual({ start: 3, query: "李" });
  });

  it("没有 @ 时返回 null", () => {
    expect(mentionTriggerAt("普通评论", 4)).toBeNull();
    expect(mentionTriggerAt("", 0)).toBeNull();
  });

  it("光标越界时按文本长度处理", () => {
    expect(mentionTriggerAt("@张", 99)).toEqual({ start: 0, query: "张" });
    expect(mentionTriggerAt("@张", -1)).toBeNull();
  });
});
