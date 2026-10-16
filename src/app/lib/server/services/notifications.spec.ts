import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { immediateDedupeKey } from "@/shared/notification/dedupe";
import { intentsOfOutboxRow } from "./notifications";

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

/**
 * **MATT-78：节点提醒的 scheduled `dateKey` 必须是"档位稳定"的**（`scanDueDateKey`：
 * 截止业务日 + 档位），不能退回**扫描日**口径。
 *
 * 为什么这一条只能用源码守卫：`notification.spec.ts` 的「同一节点同一档位只发一次」
 * 复刻了这里的构造，所以它盯得住 `scanDueDateKey` 自己的契约，**盯不住这一行被换回
 * `businessDateKey(now)`**——而判定自 MATT-78 起是**区间**的（补发窗口 K 天），
 * 换回去就是同一条「还有 3 天」在 `d, d-1, d-2` 连发三条。
 * 行为断言要真库才看得到这一处（节点扫描挂在不打 DB 的用例之外）；
 * 源码守卫看得到"这一行是这么写的"，与上面那组同一姿态。
 */
describe("源码守卫：节点提醒的 dateKey 是档位稳定的（MATT-78）", () => {
  it("扫描处传 scanDueDateKey（截止日 + 档位），不是扫描日 businessDateKey(now)", () => {
    const src = stripComments(readFileSync("src/app/lib/server/services/notifications.ts", "utf8"));
    expect(src).toContain("dateKey: scanDueDateKey(deadlineTime, d.daysLeft),");
    expect(src).not.toContain("businessDateKey(now)");
  });
});

/**
 * outbox 行的展开口径（MATT-58 / T4b 补）。
 *
 * 这一层不碰数据库，所以它盯的是"**能跑通、只是口径错了**"那类缺陷：
 * 一条评论只展开出 `new_comment`（@ 的人收不到）、
 * 一条评论里的多个 @ 各出一条事件（同一批被拆开）、
 * 被 @ 的人被塞进 `new_comment` 的收件人里（规则 8 的口径被改）。
 *
 * 最后一条今天换了个面孔：**同一个人既关注又被 @** 时不能收两条（§7.2 合并规则 1）。
 * 所以这里既钉"档位没变"，也钉"减法名单 = 被 @ 的那几个人"——两句都要，
 * 少一句就会有人把减法写进 `receivers`（那才是真的改了规则 8）。
 */
describe("outbox 展开：comment_added → new_comment + mention", () => {
  const commentRow = (payload: Record<string, unknown>) => ({
    id: 1n,
    eventType: "comment_added",
    batchId: "11111111-1111-1111-1111-111111111111",
    payload: {
      host_type: "risk_matter",
      host_id: "900",
      comment_id: "901",
      author_name: "张三",
      quoted: "已核查，先发函催告",
      ...payload,
    },
  });

  it("没有 @ 时只出 new_comment（普通评论不该多出一条通知）", () => {
    const intents = intentsOfOutboxRow(commentRow({ mention_ids: [] }));
    expect(intents.map((i) => i.eventType)).toEqual(["new_comment"]);
  });

  it("有 @ 时出两条：new_comment 与 mention", () => {
    const intents = intentsOfOutboxRow(commentRow({ mention_ids: ["7"] }));
    expect(intents.map((i) => i.eventType)).toEqual(["new_comment", "mention"]);
  });

  it("**收件人是被 @ 的那几个人**：mention 走 `custom` 档，不掺 follower/creator", () => {
    const mention = intentsOfOutboxRow(commentRow({ mention_ids: ["7", "8"] })).find(
      (i) => i.eventType === "mention",
    );
    expect(mention?.receivers).toEqual(["custom"]);
    expect(mention?.customUserIds).toEqual(["7", "8"]);
  });

  it("**§7.2 合并规则 1**：new_comment 的档位仍是 follower ∪ creator，但**减掉被 @ 的人**", () => {
    const comment = intentsOfOutboxRow(commentRow({ mention_ids: ["7"] })).find(
      (i) => i.eventType === "new_comment",
    );
    // 档位（规则的输入）没被改：规则 8 仍是 follower ∪ creator
    expect(comment?.receivers).toEqual(["follower", "creator"]);
    expect(comment?.customUserIds).toBeUndefined();
    // 减的是"本批里已经收过 mention 的那几个人"——他不是收不到广播，是**不重复收**
    expect(comment?.excludeUserIds).toEqual(["7"]);
  });

  it("没被 @ 的人不在减法名单里（规则 8 的广播照发）", () => {
    const comment = intentsOfOutboxRow(commentRow({ mention_ids: [] })).find(
      (i) => i.eventType === "new_comment",
    );
    expect(comment?.excludeUserIds).toEqual([]);
  });

  it("**被 @ 的人看不到宿主时走占位**（只有 mention 这一档开这个口子）", () => {
    const intents = intentsOfOutboxRow(commentRow({ mention_ids: ["7"] }));
    expect(intents.find((i) => i.eventType === "mention")?.invisibleAsPlaceholder).toBe(true);
    expect(intents.find((i) => i.eventType === "new_comment")?.invisibleAsPlaceholder).toBeFalsy();
  });

  it("`{quoted}` 随 outbox payload 一路带到两种事件（模板占位符有真实来源）", () => {
    for (const intent of intentsOfOutboxRow(commentRow({ mention_ids: ["7"] }))) {
      expect(intent.payloads[0]?.["quoted"]).toBe("已核查，先发函催告");
    }
  });

  it("**同一批的多个 @ 合成一条事件**：收件人集合进 dedupe_key，不是一人一条", () => {
    const row = commentRow({ mention_ids: ["7", "8", "9"] });
    const mention = intentsOfOutboxRow(row).find((i) => i.eventType === "mention");
    expect(mention?.payloads).toHaveLength(1);
    const key = immediateDedupeKey({
      eventType: "mention",
      targetId: mention!.hostId,
      batchId: row.batchId,
      recipients: mention!.customUserIds!,
    });
    // 重放同一条 outbox 行（至少一次语义）必须算出**同一个** key，否则会出第二条通知
    const replay = intentsOfOutboxRow(row).find((i) => i.eventType === "mention");
    expect(
      immediateDedupeKey({
        eventType: "mention",
        targetId: replay!.hostId,
        batchId: row.batchId,
        recipients: replay!.customUserIds!,
      }),
    ).toBe(key);
    // 而换一条评论（新的 batch_id）就该是另一条通知
    expect(
      immediateDedupeKey({
        eventType: "mention",
        targetId: mention!.hostId,
        batchId: "22222222-2222-2222-2222-222222222222",
        recipients: mention!.customUserIds!,
      }),
    ).not.toBe(key);
  });

  it("mention 与 new_comment 共用 batch_id 但 key 不同（event_type 是 key 的第一段）", () => {
    const row = commentRow({ mention_ids: ["7"] });
    const [comment] = intentsOfOutboxRow(row);
    expect(comment!.payloads).toHaveLength(1);
    const keyOf = (eventType: string, recipients: readonly string[]) =>
      immediateDedupeKey({
        eventType,
        targetId: comment!.hostId,
        batchId: row.batchId,
        recipients,
      });
    expect(keyOf("mention", ["7"])).not.toBe(keyOf("new_comment", ["7"]));
  });

  it("E32 的未知事件名返回空数组，不抛（一条坏行不该卡死整批消费）", () => {
    expect(intentsOfOutboxRow({ ...commentRow({}), eventType: "no_such_event" })).toEqual([]);
  });

  it("转案件仍是**一行 → 多个 payload**（合并规则 1 的聚合形态不能被这次改动弄丢）", () => {
    const intents = intentsOfOutboxRow({
      id: 2n,
      eventType: "risk_converted",
      batchId: "33333333-3333-3333-3333-333333333333",
      payload: { risk_matter_id: "900", case_ids: ["1", "2"], actor_name: "张三" },
    });
    expect(intents).toHaveLength(1);
    expect(intents[0]!.payloads).toHaveLength(2);
  });
});
