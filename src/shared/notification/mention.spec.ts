import { describe, expect, it } from "vitest";
import { parseMentionIds, type MentionCandidate } from "./mention";

/**
 * `@` 提及解析的回归锁（MATT-58 / T4b）。
 *
 * ## 为什么单独一个文件，而不是塞进 `notification.spec.ts`
 *
 * 这一层是**零依赖的纯函数**（`mention.ts` 不 import 任何东西），
 * 所以它的测试不该跟着通知管线一起被别人的模块加载失败连坐 ——
 * 本票开发期间实测过一次：并行票改坏了 `notification/preset-rules.ts`，
 * `notification.spec.ts` 整个文件在 import 阶段就炸，一条断言都跑不到。
 * 纯函数的锁要能在那种时候照样给出"解析口径是对的"这个证据。
 */
describe("评论里的 @提及解析（MATT-58 / T4b）", () => {
  const people: MentionCandidate[] = [
    { id: "1", displayName: "张三" },
    { id: "2", displayName: "李四" },
    { id: "3", displayName: "张三丰" },
    { id: "4", displayName: "王五" },
  ];

  it("`@` + 显示名命中，返回按出现顺序", () => {
    expect(parseMentionIds("请 @李四 和 @张三 看一下", people)).toEqual(["2", "1"]);
  });

  it("**长名优先**：`@张三丰` 命中张三丰，不是张三", () => {
    expect(parseMentionIds("@张三丰 请核", people)).toEqual(["3"]);
  });

  it("**不要求词边界**：中文没有空格，`@张三，请看一下` 必须命中", () => {
    expect(parseMentionIds("@张三，请看一下", people)).toEqual(["1"]);
  });

  it("同一条评论里 @ 同一个人两次只算一次", () => {
    expect(parseMentionIds("@张三 @张三", people)).toEqual(["1"]);
  });

  it("连续两个 `@` 各算一个（命中后跳过整个名字再扫）", () => {
    expect(parseMentionIds("@张三@李四", people)).toEqual(["1", "2"]);
  });

  it("`@` 后面不是同事的名字就跳过它继续找（邮箱 / @所有人 / 随手打的符号）", () => {
    expect(parseMentionIds("发到 a@b.com，另请 @所有人 知悉，最后 @王五", people)).toEqual(["4"]);
  });

  it("显示名里带空格也照样命中（冒烟账号的名字就是「冒烟临时账号 abc123」）", () => {
    const withSpace: MentionCandidate[] = [{ id: "9", displayName: "冒烟临时账号 abc123" }];
    expect(parseMentionIds("@冒烟临时账号 abc123 请看", withSpace)).toEqual(["9"]);
  });

  it("没有任何 @ 时返回空数组（普通评论不产生提及）", () => {
    expect(parseMentionIds("已核查，先发函催告", people)).toEqual([]);
  });

  it("候选为空时不做任何事（不会把 `@张三` 猜成谁）", () => {
    expect(parseMentionIds("@张三", [])).toEqual([]);
  });

  it("空正文返回空数组", () => {
    expect(parseMentionIds("", people)).toEqual([]);
  });

  /**
   * 同名同事（`display_name` 无唯一约束，只有 `username` 有）**全部命中**。
   * 这是刻意的：本票要挡的失败形态是"@ 了人但通知没发出去"这种**静默**，
   * 宁可多喊一个同事，也不要让点名落空。
   */
  it("同名同事全部命中，且结果顺序稳定（不随候选输入顺序漂移）", () => {
    const dup: MentionCandidate[] = [
      { id: "9", displayName: "张三" },
      { id: "1", displayName: "张三" },
      { id: "5", displayName: "李四" },
    ];
    expect(parseMentionIds("@张三", dup)).toEqual(["1", "9"]);
    expect(parseMentionIds("@张三", [...dup].reverse())).toEqual(["1", "9"]);
  });

  it("空显示名不参与匹配（否则每个 `@` 都会命中一个空名字的账号）", () => {
    expect(parseMentionIds("@张三", [{ id: "7", displayName: "" }, ...people])).toEqual(["1"]);
  });
});
