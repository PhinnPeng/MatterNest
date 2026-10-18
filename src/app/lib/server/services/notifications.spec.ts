import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { immediateDedupeKey } from "@/shared/notification/dedupe";
import type { NotifyReceiver } from "@/shared/enums/automation";
import { applyRuleGate, intentsOfOutboxRow, outboxRuleKeysOf } from "./notifications";

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
 * **投递侧不是 N+1**（MATT-76）。
 *
 * ## 为什么用源码守卫而不是墙钟
 *
 * 票面要的判据是「批量消费 K 行耗时的增长**不是线性 K 倍**」，而墙钟在本仓
 * 恰好是最不可信的形态：共享 dev 库、并发跑、机器负载都会让它抖，
 * 而本仓对"假绿"有真实戒心（票面自己就记着 `revred-notifications` 的并行假红教训）。
 *
 * 这里钉的是**往返次数**：它比墙钟更强也更稳。`insertNotificationEvent` 里
 * 每次 `await` 都是一次数据库往返，而"往返数不随收件人个数增长"正是
 * "耗时不是线性"的**充分条件**；剩下那半（单次往返的成本）与环境有关，
 * 由 `agent-work/probe-outbox-n1.mjs` 的真库测量回答。
 *
 * ## 三条各钉什么
 *
 * ① 收件人循环里**不得**出现逐人的可见性查询 —— 它一回来，6+2N 就回来了，
 *    而这个函数是**全项目唯一**写事件+投递的地方，所以每一条通知都要付。
 * ② 内存形态的调用必须在（否则守卫只证明"删掉了旧写法"，不证明"换上了新写法"）。
 * ③ 宿主 ACL 必须在**循环外**取（挪进循环 = 换个名字继续 N+1）。
 */
describe("源码守卫：投递侧的可见性判定不是 N+1（MATT-76）", () => {
  const src = () =>
    stripComments(readFileSync("src/app/lib/server/services/notifications.ts", "utf8"));

  it("① 收件人循环里没有逐人的可见性查询", () => {
    // 旧形态的特征是 `await canSeeHost(`；内存形态 `canSeeHostFrom(` 不含 await 查询。
    // 用词级匹配会误伤后者，所以钉的是"不回退到逐人查询"这件事本身。
    expect(src()).not.toMatch(/await\s+canSeeHost\(/);
  });

  it("② 内存形态的判定必须在（删掉旧写法 ≠ 换上新写法）", () => {
    expect(src()).toContain("canSeeHostFrom(");
  });

  it("③ 宿主 ACL 在收件人循环**之前**取（挪进循环 = 换个名字继续 N+1）", () => {
    const s = src();
    const aclAt = s.indexOf("await loadHostAcl(");
    expect(aclAt, "找不到 loadHostAcl —— 守卫的锚点失效了").toBeGreaterThan(0);
    const loopAt = s.indexOf("for (const userId of intent.recipients)");
    expect(loopAt, "找不到收件人循环 —— 守卫的锚点失效了").toBeGreaterThan(0);
    expect(loopAt).toBeGreaterThan(aclAt);
  });

  it("④ 投递行**一次插完**（逐条插入 = 把 N 次往返又带回来）", () => {
    const s = src();
    // `insert(notificationDelivery)` 全项目只应出现一次，且用的是攒好的数组
    const inserts = s.split("insert(notificationDelivery)").length - 1;
    expect(inserts, "投递行插入点应恰好 1 处").toBe(1);
    expect(s).toContain("values(deliveryRows)");
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

/**
 * `applyRuleGate` 的**行为测试**与**调用点守卫**（2026-10-18）。
 *
 * ## 为什么这两档必须一起在
 *
 * `agent-work/probe-rule-executors.mjs` 量出过本仓最典型的一种失败：
 * 规则 2/5/6/7/8 的收件人取自**常量**、通路上零处查 `is_enabled` ——
 * 配置页上勾得动、勾了不改变行为。修完之后有两个**半档**会各自静默复发：
 *
 *   · 判定函数写好了但**没人调用**（死代码）⇒ 行为测试照绿；
 *   · 调用点写了但**传错 key**（判定表按 `new_comment` 索引、调用点传 `comment_added`）
 *     ⇒ 行为测试照绿，而线上表现为"这条规则停用无效"。
 *
 * 所以：行为测试钉"判得对不对"，调用点守卫钉"真的接了、键对得上"。
 * 只留一半，就会退回到"看着像做了"。
 */
describe("applyRuleGate：规则停用 ⇒ 该意图整条丢掉", () => {
  const commentRow = {
    id: 1n,
    eventType: "comment_added",
    batchId: "44444444-4444-4444-4444-444444444444",
    payload: {
      host_type: "matter",
      host_id: "900",
      author_name: "张三",
      quoted: "已核查",
      mention_ids: [],
    },
  };
  const fire = (receivers: NotifyReceiver[]) => ({ fire: true as const, receivers, ruleId: 9n });
  const stop = { fire: false as const, why: "rule_disabled" as const, ruleId: 9n };

  it("**停用 ⇒ `new_comment` 不再产出**（规则 8 的开关落点）", () => {
    const gated = applyRuleGate(intentsOfOutboxRow(commentRow), new Map([["new_comment", stop]]));
    expect(gated).toEqual([]);
  });

  it("启用 ⇒ 收件人换成**规则行里配的那一份**，不是常量", () => {
    const gated = applyRuleGate(
      intentsOfOutboxRow(commentRow),
      new Map([["new_comment", fire(["owner"])]]),
    );
    expect(gated).toHaveLength(1);
    expect(gated[0]!.receivers).toEqual(["owner"]);
  });

  it("**`mention` 不归规则管** —— 停用规则 8 不该把 @提及 一起关掉", () => {
    // §2.3 末段：「mention 不经规则引擎，由评论服务直接发事件」
    const row = { ...commentRow, payload: { ...commentRow.payload, mention_ids: ["7"] } };
    const gated = applyRuleGate(intentsOfOutboxRow(row), new Map([["new_comment", stop]]));
    expect(gated.map((i) => i.eventType)).toEqual(["mention"]);
  });

  it("**没给判定 = 调用方漏查 ⇒ 丢掉**（不照发）：照发会让'忘了查开关'装成'停用无效'", () => {
    const gated = applyRuleGate(intentsOfOutboxRow(commentRow), new Map());
    expect(gated).toEqual([]);
  });

  it("**`excludeUserIds` 原样穿过**：换档位不等于那个人该收两份（§7.2 合并规则 1）", () => {
    const row = { ...commentRow, payload: { ...commentRow.payload, mention_ids: ["7"] } };
    const gated = applyRuleGate(
      intentsOfOutboxRow(row),
      new Map([["new_comment", fire(["owner", "follower"])]]),
    );
    const broadcast = gated.find((i) => i.eventType === "new_comment");
    expect(broadcast?.receivers).toEqual(["owner", "follower"]);
    expect(broadcast?.excludeUserIds).toEqual(["7"]);
  });

  it("转案件（规则 7）同样受开关约束", () => {
    const row = {
      id: 2n,
      eventType: "risk_converted",
      batchId: "55555555-5555-5555-5555-555555555555",
      payload: { risk_matter_id: "900", case_ids: ["1"], actor_name: "张三" },
    };
    expect(applyRuleGate(intentsOfOutboxRow(row), new Map([["risk_converted", stop]]))).toEqual([]);
    const on = applyRuleGate(
      intentsOfOutboxRow(row),
      new Map([["risk_converted", fire(["owner", "follower", "creator"])]]),
    );
    expect(on).toHaveLength(1);
  });

  it("判定表按**事件类型**索引，不是规则号（两边键不一致就是静默失效）", () => {
    // 表里放一个规则号做 key ⇒ 一次也不该命中；这正是"传错 key"那个半档的探针
    const gated = applyRuleGate(intentsOfOutboxRow(commentRow), new Map([["8", stop]]));
    expect(gated).toEqual([]);
  });
});

describe("源码守卫：闸门真的接在四条链路上（不是死代码）", () => {
  const src = readFileSync("src/app/lib/server/services/notifications.ts", "utf8");

  it("`notifyStatusChanged`（规则 2）走 `decideNotifyRule` 且早退", () => {
    const at = src.indexOf("export async function notifyStatusChanged");
    expect(at, "锚点失效：找不到 notifyStatusChanged").toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("\nexport ", at + 10));
    expect(body).toContain("decideNotifyRule");
    expect(body).toContain("if (!decision.fire) return");
    // 常量退化为兜底：它必须在，但**不再**直接当 receivers 用
    expect(body).not.toContain("receivers: RULE_STATUS_CHANGED_NOTIFY.receivers");
  });

  it("`consumeOutbox`（规则 7/8）把 `expand` 的结果过了闸门", () => {
    const at = src.indexOf("export async function consumeOutbox");
    expect(at, "锚点失效：找不到 consumeOutbox").toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("\nexport ", at + 10));
    expect(body).toContain("applyRuleGate(");
    expect(body).toContain("loadOutboxRuleDecisions(");
    // 整批查一次，不在行循环里查（循环里查是 N 次往返）
    expect(body.indexOf("loadOutboxRuleDecisions(")).toBeLessThan(
      body.indexOf("for (const row of pending)"),
    );
  });

  it("`scanDueNodes`（规则 5/6）两档各自查行、各自早退", () => {
    const at = src.indexOf("export async function scanDueNodes");
    expect(at, "锚点失效：找不到 scanDueNodes").toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("\nexport ", at + 10));
    expect(body).toContain("presetRule(5).code");
    expect(body).toContain("presetRule(6).code");
    expect(body).toContain("if (!decision.fire) continue;");
    expect(body).not.toContain("rule.receivers");
  });

  it("**意图** → 规则号的映射里没有 `mention`，且 outbox 层也不列它（它不经规则引擎）", () => {
    const at = src.indexOf("const INTENT_EVENT_RULE_NO");
    expect(at, "锚点失效：找不到 INTENT_EVENT_RULE_NO").toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("};", at));
    expect(body).toContain("new_comment: 8");
    expect(body).toContain("risk_converted: 7");
    expect(body).not.toContain("mention");

    // outbox 那一层的映射也不许把 mention 列进来（它根本不作为 outbox 行的事件名存在）
    const at2 = src.indexOf("const OUTBOX_EVENT_INTENTS");
    expect(at2, "锚点失效：找不到 OUTBOX_EVENT_INTENTS").toBeGreaterThan(0);
    expect(src.slice(at2, src.indexOf("};", at2))).not.toContain("mention");
  });
});

/**
 * **两套事件名的翻译**（2026-10-18 实测回归的护栏）。
 *
 * ## 它挡的是什么
 *
 * 消费侧有两个不同的"事件类型"，名字长得很像：
 *   · **outbox 行**（E32 写入事件）：`comment_added` / `risk_converted`；
 *   · **通知意图**（E29 通知事件）：`new_comment` / `mention` / `risk_converted`。
 *
 * `loadOutboxRuleDecisions` 的入参是前者的类型，而 `applyRuleGate` 按后者的类型取判定。
 * 初版把入参**直接**当 key 用 ⇒ 映射全部落空 ⇒ `applyRuleGate` 按它"漏查开关要丢掉"
 * 的分支把所有评论广播**静默丢掉**。`mention` 因不归规则管而原样穿过，
 * 所以症状是"@的人收得到、没被@的关注人收不到" —— 与"规则 8 被关掉"完全同形，
 * 而开关其实是开着的。
 *
 * ⚠ 这条缺陷**单测当时全绿**：本 spec 里所有 `applyRuleGate` 用例都是手工构造判定表，
 * 没人验过"真实调用链传进来的 key 对不对"。抓到它的是 `smoke-notifications.mjs` 的三条
 * 业务断言。所以下面这组断言钉的是**翻译函数**，而不是某条业务路径。
 */
describe("outboxRuleKeysOf：outbox 类型 → 意图类型的翻译", () => {
  it("**`comment_added` 必须翻成 `new_comment`**（不是原样返回）", () => {
    // 初版就是少了这一步，于是规则 8 的广播全被丢掉
    expect(outboxRuleKeysOf(["comment_added"])).toEqual(["new_comment"]);
  });

  it("`risk_converted` 两边同名，但仍走翻译（别假设所有事件都同名）", () => {
    expect(outboxRuleKeysOf(["risk_converted"])).toEqual(["risk_converted"]);
  });

  it("**`mention` 不出现在结果里**：它不经规则引擎，没有开关可查", () => {
    for (const keys of [outboxRuleKeysOf(["comment_added"]), outboxRuleKeysOf([])]) {
      expect(keys).not.toContain("mention");
    }
  });

  it("未知事件类型返回空（一条坏行不该让整批查判定时抛错）", () => {
    expect(outboxRuleKeysOf(["no_such_event"])).toEqual([]);
  });

  it("多个 outbox 类型去重合并（`comment_added` ×2 只查一次）", () => {
    expect(outboxRuleKeysOf(["comment_added", "comment_added"]).sort()).toEqual(["new_comment"]);
    expect(outboxRuleKeysOf(["comment_added", "risk_converted"]).sort()).toEqual([
      "new_comment",
      "risk_converted",
    ]);
  });
});
