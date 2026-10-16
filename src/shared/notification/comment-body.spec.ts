import { describe, expect, it } from "vitest";
import { buildCommentParts, type MentionUser } from "./comment-body";

/**
 * 评论正文切段的回归锁（MATT-68 / T4b2）。
 *
 * 这里锁的是**三种状态、两种画法**（见 `comment-body.ts` 文件头）里最容易写错的那几处：
 * "正文里写了 `@张三` 但张三不在 `mention_ids` 里"必须**画成普通文字** ——
 * 那是"重解析"与"按事实渲染"唯一能被肉眼区分的地方，也是本票存在的理由。
 */
describe("评论正文切段（MATT-68 / T4b2）", () => {
  const zhang: MentionUser = { id: "1", displayName: "张三", active: true };
  const li: MentionUser = { id: "2", displayName: "李四", active: true };

  it("正文切成 文本 / 提及 / 文本 三段，字面名字原样带出", () => {
    expect(buildCommentParts("请 @李四 看一下", [li])).toEqual([
      { kind: "text", text: "请 " },
      { kind: "mention", name: "李四", ids: ["2"], status: "active" },
      { kind: "text", text: " 看一下" },
    ]);
  });

  it("没有任何提及时整条是纯文本（普通评论不产生提及段）", () => {
    expect(buildCommentParts("已核查，先发函催告", [zhang, li])).toEqual([
      { kind: "text", text: "已核查，先发函催告" },
    ]);
  });

  it("**正文写了 `@张三`、但 `mention_ids` 里没有他 ⇒ 画成普通文字**（本票要挡的重解析）", () => {
    // 只把"真被点名的人"传进来 —— 这里传空，等于这条评论没点名
    expect(buildCommentParts("请 @张三 看一下", [])).toEqual([
      { kind: "text", text: "请 @张三 看一下" },
    ]);
  });

  it("停用的被点名同事照样成段，只是 status=inactive（不抹成纯文本）", () => {
    const gone: MentionUser = { id: "1", displayName: "张三", active: false };
    expect(buildCommentParts("@张三 请接手", [gone])).toEqual([
      { kind: "mention", name: "张三", ids: ["1"], status: "inactive" },
      { kind: "text", text: " 请接手" },
    ]);
  });

  it("同名同事全在一段里；**只要有一个已停用就画降级态**", () => {
    const dup: MentionUser[] = [
      { id: "1", displayName: "张三", active: true },
      { id: "9", displayName: "张三", active: false },
    ];
    expect(buildCommentParts("@张三", dup)).toEqual([
      { kind: "mention", name: "张三", ids: ["1", "9"], status: "inactive" },
    ]);
  });

  it("提及在开头 / 结尾时不产生空文本段", () => {
    expect(buildCommentParts("@李四", [li])).toEqual([
      { kind: "mention", name: "李四", ids: ["2"], status: "active" },
    ]);
    expect(buildCommentParts("找 @李四", [li])).toEqual([
      { kind: "text", text: "找 " },
      { kind: "mention", name: "李四", ids: ["2"], status: "active" },
    ]);
  });

  it("一条评论里 @ 两个人时，每处各成一段", () => {
    expect(buildCommentParts("@张三 和 @李四", [zhang, li])).toEqual([
      { kind: "mention", name: "张三", ids: ["1"], status: "active" },
      { kind: "text", text: " 和 " },
      { kind: "mention", name: "李四", ids: ["2"], status: "active" },
    ]);
  });

  it("空正文返回空数组（调用方按空数组画即可）", () => {
    expect(buildCommentParts("", [zhang])).toEqual([]);
  });
});
