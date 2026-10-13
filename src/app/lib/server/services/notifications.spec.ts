import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 通知管线的**源码守卫**（MATT-41 / T4）。
 *
 * 为什么单独一个文件、为什么住在服务层而不是 `src/shared/`：
 * 这些断言要读源码文件，而禁令① 不允许 `src/shared/**` 依赖 Node API（`node:fs`）——
 * 初版把它们写在 `shared/notification/notification.spec.ts` 里，eslint 当场拦下。
 * 这不是"换个地方放"，而是**依赖方向本来就不对**：被守卫的是服务层，
 * 守卫就该住在服务层（与 `db/enum-check.spec.ts` 读迁移 SQL 同一姿态）。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("源码守卫：通知管线不写 user_watch", () => {
  /**
   * 这是本票最容易被"顺手补上"破坏的一条：上报人能看到回音之后，
   * 「那干脆给他建一条关注行吧」是极自然的下一步——而它恰好是 IQ-13-V5 推翻的落法。
   * 行为断言（冒烟里查 `mn_user_watch` 无行）只能证明**这次没写**，
   * 源码守卫证明的是**没有写它的代码路径**。两条都要。
   *
   * **先剥注释再断言**，与 `tools/lint-guard` 的富文本白名单同一条哲学：
   * 注释里会**写**这个词来解释"为什么不写它"（`resolveRecipients` 的注释就引了
   * `mn_user_watch`），词级匹配会把说明文字自己拦下来。
   */
  it("services/notifications.ts 的**代码**里不出现 userWatch / mn_user_watch", () => {
    const src = stripComments(readFileSync("src/app/lib/server/services/notifications.ts", "utf8"));
    expect(src).not.toContain("userWatch");
    expect(src).not.toContain("user_watch");
  });

  it("schema 里那张表存在（否则「不写它」这句话没有对照物）", () => {
    const schema = readFileSync("src/app/lib/server/db/schema/notifications.ts", "utf8");
    expect(schema).toContain("mn_user_watch");
    expect(schema).toContain("export const userWatch");
  });

  /**
   * 状态变更与评论这两条生产点都必须**留在业务事务里**。
   *
   * 事后再补会丢：状态已经变了、事务已经提交，而"该通知谁"要在同一时刻读
   * `*_staff` 与 `created_by` 才准。断言写成"这两个调用出现在事务回调内"太脆，
   * 所以只钉住更硬的那半：**评论路径不许直接写 `mn_notification_event`**——
   * 它必须只落 outbox，由消费侧展开（这正是"投递走 outbox 不直发"）。
   */
  it("评论路径只落 outbox：enqueueCommentIntent 里不出现 insertNotificationEvent", () => {
    const src = readFileSync("src/app/lib/server/services/notifications.ts", "utf8");
    const at = src.indexOf("export async function enqueueCommentIntent");
    expect(at, "找不到 enqueueCommentIntent —— 守卫的锚点失效了").toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("\nexport ", at + 10));
    expect(body).toContain("insert(eventOutbox)");
    expect(body).not.toContain("insertNotificationEvent");
  });
});
