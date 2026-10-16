import dayjs from "dayjs";
import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_TEMPLATE_BY_EVENT,
  NOTIFICATION_EVENT_TYPES,
  PHASE1_NOTIFY_CHANNEL,
} from "@/shared/enums/notify";
import { businessDateKey, formatBusinessTime } from "@/shared/time/zh-cn";
import {
  DEDUPE_KEY_MAX_LENGTH,
  immediateDedupeKey,
  recipientsDigest,
  scheduledDedupeKey,
} from "./dedupe";
import {
  INVISIBLE_NOTIFICATION_TITLE,
  MISSING_ITEM_LABELS,
  notificationVars,
  renderNotification,
  renderTemplate,
} from "./template";
import { pickDueReminders, scanDueDateKey, SCANNABLE_NODE_STATUSES } from "./scan";
import {
  CREATOR_ECHO_RULES,
  PRESET_NOTIFY_RULES,
  RULE_COMMENT_ADDED_NOTIFY,
  RULE_STATUS_CHANGED_NOTIFY,
} from "./preset-rules";

/**
 * 通知管线的**纯逻辑**回归锁。
 *
 * 这里不碰数据库，所以它盯的都是"能编译、能跑通、只是口径错了"那类缺陷：
 * 去重键少了收件人、时区差 8 小时、扫描把未确认时间的节点也拉进来、
 * 上报人回音那条线被谁顺手摘掉。
 */

describe("dedupe_key（§7.2 合并规则 4：靠唯一键去重）", () => {
  it("收件人顺序不影响 key（同一批里两次解析顺序不同不能各出一条）", () => {
    const a = immediateDedupeKey({
      eventType: "new_comment",
      targetId: 100n,
      batchId: "b1",
      recipients: [1n, 2n, 3n],
    });
    const b = immediateDedupeKey({
      eventType: "new_comment",
      targetId: 100n,
      batchId: "b1",
      recipients: [3n, 1n, 2n],
    });
    expect(a).toBe(b);
  });

  it("重复收件人先去重再算摘要（一人多角色只该算一个人）", () => {
    expect(recipientsDigest([1n, 1n, 2n])).toBe(recipientsDigest([2n, 1n]));
  });

  it("批次不同 ⇒ key 不同（否则两次独立操作会被合并成一条）", () => {
    const a = immediateDedupeKey({
      eventType: "status_changed",
      targetId: 1n,
      batchId: "b1",
      recipients: [1n],
    });
    const b = immediateDedupeKey({
      eventType: "status_changed",
      targetId: 1n,
      batchId: "b2",
      recipients: [1n],
    });
    expect(a).not.toBe(b);
  });

  it("收件人集合不同 ⇒ key 不同（不能把「给 A 的」和「给 A、B 的」合成一条）", () => {
    const a = immediateDedupeKey({
      eventType: "new_comment",
      targetId: 1n,
      batchId: "b",
      recipients: [1n],
    });
    const b = immediateDedupeKey({
      eventType: "new_comment",
      targetId: 1n,
      batchId: "b",
      recipients: [1n, 2n],
    });
    expect(a).not.toBe(b);
  });

  it("定时类不含收件人：同目标同 dateKey 只有一条（人员变动不该在同一条提醒内再发一次）", () => {
    const a = scheduledDedupeKey({
      eventType: "node_due_end",
      targetId: 7n,
      dateKey: "2026-10-14",
    });
    const b = scheduledDedupeKey({
      eventType: "node_due_end",
      targetId: 7n,
      dateKey: "2026-10-14",
    });
    expect(a).toBe(b);
    expect(a).not.toBe(
      scheduledDedupeKey({ eventType: "node_due_end", targetId: 7n, dateKey: "2026-10-15" }),
    );
  });

  it("key 不超列宽 varchar(120)——超长会在用户点保存时才被 PG 拒", () => {
    const key = immediateDedupeKey({
      eventType: "archive_incomplete",
      targetId: 9223372036854775807n,
      batchId: "01234567-89ab-cdef-0123-456789abcdef",
      recipients: Array.from({ length: 30 }, (_, i) => BigInt(i + 1)),
    });
    expect(key.length).toBeLessThanOrEqual(DEDUPE_KEY_MAX_LENGTH);
  });
});

describe("模板渲染（权限草案 §7.1：读取时渲染，不落快照）", () => {
  it("占位符替换、缺值落 —", () => {
    expect(renderTemplate("「{name}」缺：{missing}", { name: "甲案", missing: "结案日期" })).toBe(
      "「甲案」缺：结案日期",
    );
    expect(renderTemplate("{node}", { node: "" })).toBe("—");
  });

  it("未知占位符原样保留：模板写错变量名要看得见，不能抹成通顺但少一段的句子", () => {
    expect(renderTemplate("计划 {deadline}", { time: "2026-01-01" })).toBe("计划 {deadline}");
  });

  it("**时区**：UTC 瞬时进，上海墙上时间出（会话钉 UTC，直接格式化差 8 小时）", () => {
    const vars = notificationVars({ deadline_time: "2026-10-14T22:30:00.000Z" });
    // 22:30Z 是上海的次日 06:30。写成 2026-10-14 22:30 就是那个差 8 小时的缺陷
    expect(vars["time"]).toBe("2026-10-15 06:30");
  });

  /**
   * **这条用例才是时区口径的真守卫** —— 上面那条在本机是**空转**的。
   *
   * 开发机的进程时区恰好是 `Asia/Shanghai`，所以 `dayjs(iso).format(...)`
   * （也就是"忘了写 `.tz()`"）在本机输出与正确结果**一模一样**。
   * 换句话说：只靠"上海时间对不对"是证伪不了漏写时区的——
   * 那条缺陷的真暴露面是生产容器（Docker 默认 UTC）。
   *
   * 所以这里把 `process.env.TZ` **临时改成 UTC**（Node 在运行时重读它），
   * 让两种写法当场分开，并且**先断言"直接格式化确实会错"**：
   * 少了前半句，这条用例在"TZ 没生效"时也会绿——那是另一种空转。
   */
  it("进程时区为 UTC 时仍给上海墙上时间（漏写 .tz() 会在这里红）", () => {
    const saved = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const iso = "2026-10-14T22:30:00.000Z";
      // 前半句是"探针"：证明这个条件下两种写法真的分开了，否则后半句是空转
      expect(dayjs(iso).format("YYYY-MM-DD HH:mm"), "TZ=UTC 没生效？这条用例会变成空转").toBe(
        "2026-10-14 22:30",
      );
      expect(formatBusinessTime(iso)).toBe("2026-10-15 06:30");
    } finally {
      process.env.TZ = saved;
    }
  });

  it("缺项校验码翻成中文（B5 措辞设计说明第 4 条）", () => {
    const vars = notificationVars({ missing: ["judgment_doc", "closing_date"] });
    expect(vars["missing"]).toBe("裁判文书附件、结案日期");
    expect(MISSING_ITEM_LABELS["pending_nodes"]).toBe("待定节点未决");
  });

  it("模板缺席时返回 null（让那一条说不出来，而不是把整页变成 500）", () => {
    expect(renderNotification(undefined, {})).toBeNull();
    expect(renderNotification({ titleTpl: "T{code}", bodyTpl: "B" }, { code: "AJ-1" })).toEqual({
      title: "TAJ-1",
      body: "B",
    });
  });

  it("占位行标题是「无权查看的记录」（权限草案 §7.1 逐字）", () => {
    expect(INVISIBLE_NOTIFICATION_TITLE).toBe("无权查看的记录");
  });

  it("E29 的 8 个事件都有模板落点，且模板 code 都在 B5 的 8 条之内", () => {
    const codes = new Set(Object.values(NOTIFICATION_TEMPLATE_BY_EVENT));
    expect(codes.size).toBe(8);
    expect(NOTIFICATION_EVENT_TYPES.every((e) => NOTIFICATION_TEMPLATE_BY_EVENT[e])).toBe(true);
    // risk_converted 复用 case_archived 是 §2.4 明写的多对一，其余必须一一对应
    expect(NOTIFICATION_TEMPLATE_BY_EVENT["risk_converted"]).toBe("case_archived");
  });
});

describe("节点到期扫描（只走带 is_time_confirmed 的 partial index 那一路）", () => {
  const base = {
    timeType: "point",
    deadlineTime: "2026-10-17T02:00:00.000Z", // 上海 10-17 10:00
    remindDays: [3, 1],
    isTimeConfirmed: true,
    status: "not_started",
  };
  const now = "2026-10-14T03:00:00.000Z"; // 上海 10-14 11:00 ⇒ 还有 3 天

  it("命中提前 3 天：时间点节点给 node_due_start", () => {
    expect(pickDueReminders(base, now)).toEqual([{ eventType: "node_due_start", daysLeft: 3 }]);
  });

  it("时间段节点给 node_due_end（期限是结束时间）", () => {
    expect(pickDueReminders({ ...base, timeType: "range" }, now)).toEqual([
      { eventType: "node_due_end", daysLeft: 3 },
    ]);
  });

  it("**is_time_confirmed=false 一律不提醒**（4.2 原型「判决 待定」就是这一档）", () => {
    expect(pickDueReminders({ ...base, isTimeConfirmed: false }, now)).toEqual([]);
  });

  it("已完成/已取消的节点不提醒（索引谓词的第二个条件）", () => {
    for (const status of ["completed", "cancelled"]) {
      expect(pickDueReminders({ ...base, status }, now)).toEqual([]);
    }
    // 两个可扫状态各命中一次，证明闸门用的是同一份值域而不是写死的字符串
    for (const status of SCANNABLE_NODE_STATUSES) {
      expect(pickDueReminders({ ...base, status }, now)).toHaveLength(1);
    }
  });

  it("remind_days 里的重复值只出一条（{7,3,1,3} 是手滑，不是两条通知）", () => {
    expect(pickDueReminders({ ...base, remindDays: [3, 3, 1] }, now)).toEqual([
      { eventType: "node_due_start", daysLeft: 3 },
    ]);
  });

  it("不在提前天数上的节点一条都不出", () => {
    expect(pickDueReminders({ ...base, remindDays: [7, 1] }, now)).toEqual([]);
  });

  /**
   * **MATT-78 的窗口用例**：等值判定改**区间**判定（`SCAN_CATCHUP_DAYS = 3`，产品裁定）。
   *
   * 上面那条 `[7,1]` 是"窗口的**上**沿"（比档位还早的日子不该发），这条是"当天没跑到"
   * 这个事故：等值判定下 `daysLeft = d-1` 一条都不出 ⇒ 那一档永久丢失。
   * ⚠ 两个方向合起来才是区间：往 `daysLeft` **更小**的一侧扩 K 天（补发），
   * 往更大的一侧**一天都不扩**——`[d, d+K)` 那个方向补不回任何东西
   * （停机跨过档位后恢复时 `daysLeft` 已经小于 d），见 `scan.ts` 的常量注释。
   */
  it("**跨过档位当天补跑仍能命中**，且只补 K=3 天（窗外与更早那侧都不发）", () => {
    // 上海 10-24 截止 + remind_days=[7] ⇒ 7 天档的窗口是 daysLeft ∈ {5,6,7}
    const node = { ...base, deadlineTime: "2026-10-24T02:00:00.000Z", remindDays: [7] };
    const hit = [{ eventType: "node_due_start" as const, daysLeft: 7 }];
    // daysLeft = d+1：比档位还早的那一天，**不许**命中（窗口只朝小的一侧扩）
    expect(pickDueReminders(node, "2026-10-16T03:00:00.000Z")).toEqual([]);
    expect(pickDueReminders(node, "2026-10-17T03:00:00.000Z")).toEqual(hit); // 档位当天
    expect(pickDueReminders(node, "2026-10-18T03:00:00.000Z")).toEqual(hit); // 停机跨过一天
    expect(pickDueReminders(node, "2026-10-19T03:00:00.000Z")).toEqual(hit); // 窗口最后一天 = d-K+1
    // daysLeft = d-K：窗外，超期就不再补（否则"还有 7 天"会在只剩 3 天时还往外发）
    expect(pickDueReminders(node, "2026-10-20T03:00:00.000Z")).toEqual([]);
  });

  it("长停机后 `daysLeft` 落进两个窗的交叠区 ⇒ 一次出两条里程碑（不是连发）", () => {
    // 上海 10-17 截止、remind_days=[7,3,1]、daysLeft=1：3 天档还在窗口里（1 > 3-3），1 天档也到点
    expect(
      pickDueReminders({ ...base, remindDays: [7, 3, 1] }, "2026-10-16T03:00:00.000Z"),
    ).toEqual([
      { eventType: "node_due_start", daysLeft: 1 },
      { eventType: "node_due_start", daysLeft: 3 },
    ]);
  });

  it("时间未填 / 已软删的节点不提醒", () => {
    expect(pickDueReminders({ ...base, deadlineTime: null }, now)).toEqual([]);
    expect(pickDueReminders({ ...base, isDeleted: true }, now)).toEqual([]);
  });
});

/**
 * **去重键的档位稳定性**（MATT-78：区间判定上线后必须配套的那一半）。
 *
 * 判定区间化之后同一档位会在 `d, d-1, d-2` 三天都命中，而 `dedupe_key` 是
 * `UNIQUE` + `ON CONFLICT DO NOTHING` 的**唯一**去重手段（§7.2 合并规则 4：
 * 去重靠数据库唯一键，不靠应用层判重）⇒ 键还按**扫描日**算就会连发三条。
 * 这里复刻 `services/notifications.ts` 那一处的构造，钉住"同节点同档位只一条"。
 */
describe("节点提醒的 scheduled dateKey（档位稳定，不是扫描日）", () => {
  const NODE_ID = 7n;
  const deadline = "2026-10-24T02:00:00.000Z"; // 上海 10-24
  const node = {
    timeType: "point",
    deadlineTime: deadline,
    remindDays: [7],
    isTimeConfirmed: true,
    status: "not_started",
  };
  /** 复刻服务层的两步：先判定命中哪一档（`pickDueReminders`），再按「截止日 + 档位」算 key */
  const keyOfScanDay = (now: string): string | null => {
    const [due] = pickDueReminders(node, now);
    return due
      ? scheduledDedupeKey({
          eventType: due.eventType,
          targetId: NODE_ID,
          dateKey: scanDueDateKey(deadline, due.daysLeft),
        })
      : null;
  };
  const scanDays = [
    "2026-10-17T03:00:00.000Z",
    "2026-10-18T03:00:00.000Z",
    "2026-10-19T03:00:00.000Z",
  ];

  it("**同一节点同一档位只发一次**：补发窗口内不同扫描日得到同一个 key", () => {
    const onTime = keyOfScanDay(scanDays[0] ?? "");
    const catchUp1 = keyOfScanDay(scanDays[1] ?? "");
    const catchUp2 = keyOfScanDay(scanDays[2] ?? "");
    expect(onTime, "档位当天的 key 没算出来，下面两条比较就是空转").toBeTruthy();
    expect(catchUp1).toBe(onTime);
    expect(catchUp2).toBe(onTime);
    // 探针：这三天的**扫描日**互不相同 ⇒ 旧口径（`businessDateKey(now)`）会算出 3 个 key。
    // 少了这半句，"换成扫描日"这个缺陷与"补发窗口没生效"会同时被这条用例放过。
    expect(new Set(scanDays.map((d) => businessDateKey(d))).size).toBe(3);
  });

  it("不同档位得到不同 key：交叠区那次扫描的两条里程碑不会被合成一条", () => {
    expect(scanDueDateKey(deadline, 7)).not.toBe(scanDueDateKey(deadline, 3));
    // daysLeft=1 时 3 天档与 1 天档都命中 ⇒ 两个事件（两条不同的里程碑，不是重复）
    const keys = pickDueReminders(
      { ...node, remindDays: [7, 3, 1] },
      "2026-10-23T03:00:00.000Z",
    ).map((d) =>
      scheduledDedupeKey({
        eventType: d.eventType,
        targetId: NODE_ID,
        dateKey: scanDueDateKey(deadline, d.daysLeft),
      }),
    );
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("截止日改了 ⇒ 新 key（改期会重新提醒，旧截止日那条不会把它吸收掉）", () => {
    expect(scanDueDateKey("2026-11-01T02:00:00.000Z", 7)).not.toBe(scanDueDateKey(deadline, 7));
  });

  it("key 的 dateKey 精确等于「截止业务日#档位」（截止日而不是扫描日）", () => {
    expect(scanDueDateKey(deadline, 7)).toBe(`${businessDateKey(deadline)}#7`);
  });
});

describe("上报人回音（IQ-13-V5：走 receivers 加 creator，不入关注列表）", () => {
  it("规则 2 与规则 8 的收件人都含 creator", () => {
    for (const rule of CREATOR_ECHO_RULES) {
      expect(rule.receivers, `规则 ${rule.ruleNo} 少了 creator`).toContain("creator");
      expect(rule.receivers).toContain("follower");
    }
    expect(RULE_STATUS_CHANGED_NOTIFY.ruleNo).toBe(2);
    expect(RULE_COMMENT_ADDED_NOTIFY.ruleNo).toBe(8);
  });

  it("节点提醒不含 creator（上报人收到「你的事项有个节点到期」没有可执行动作）", () => {
    for (const rule of PRESET_NOTIFY_RULES) {
      if (rule.ruleNo === 5 || rule.ruleNo === 6) expect(rule.receivers).not.toContain("creator");
    }
  });

  it("规则的 template_code 与事件→模板映射一致（两份口径不许漂移）", () => {
    expect(NOTIFICATION_TEMPLATE_BY_EVENT["status_changed"]).toBe(
      RULE_STATUS_CHANGED_NOTIFY.templateCode,
    );
    expect(NOTIFICATION_TEMPLATE_BY_EVENT["new_comment"]).toBe(
      RULE_COMMENT_ADDED_NOTIFY.templateCode,
    );
    expect(NOTIFICATION_TEMPLATE_BY_EVENT["risk_converted"]).toBe(
      PRESET_NOTIFY_RULES.find((r) => r.ruleNo === 7)?.templateCode,
    );
  });

  it("一期唯一渠道是 in_app（email 撤出一期，IQ-8）", () => {
    expect(PHASE1_NOTIFY_CHANNEL).toBe("in_app");
  });
});

/**
 * **源码守卫**（不在这里）：通知管线不许写 `mn_user_watch` 那条断言住在
 * `src/app/lib/server/services/notifications.spec.ts` —— 它要读源码，
 * 而禁令① 不允许 `src/shared/**` 碰 Node API（`node:fs`）。
 * 放在 shared 里会被 eslint 当场拦下（这条注释就是那次拦截留下的）。
 */

/**
 * **@提及解析的锁也不在这里**：`mention.spec.ts` 单独一个文件。
 * 理由是实测出来的——并行票改坏 `notification/preset-rules.ts` 时本文件在 import
 * 阶段就炸，一条断言都跑不到；零依赖的纯函数不该被通知管线的加载失败连坐。
 */
