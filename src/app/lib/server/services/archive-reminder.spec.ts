import { describe, expect, it } from "vitest";
import {
  MISSING_CHECK_BY_CODE,
  MISSING_CODE_BY_CHECK,
  MISSING_ITEM_LABELS,
  READINESS_CHECK_KEYS,
  missingCodes,
  notificationVars,
} from "@/shared/notification/template";
import {
  archiveReminderMissingText,
  archiveReminderPayload,
  judgeArchiveReminder,
  type ArchiveReminderConfig,
  type ArchiveReminderFacts,
} from "@/shared/notification/archive-reminder";
import { READINESS_CHECKS } from "./archive-readiness";

/**
 * 规则 9 的判定 + 它到通知文案的那一段接线（MATT-43 / T5b）。
 *
 * ## 为什么这一组断言必须存在
 *
 * 这条链路上每一处失效都是**静默**的：
 *   · 时钟算错 ⇒ "该发的没发"（库里没有行，与"扫描器没跑"长得一样）；
 *   · 冷却期算错 ⇒ 重复发（用户收到两条一模一样的提醒）；
 *   · 缺项码没转 ⇒ 通知正文里出现 `closingDate` 这种英文驼峰词（不报错、不类型错）；
 *   · 服务端加了第四项校验而 shared 的映射没跟 ⇒ 通知里少说一项。
 * 所以这里逐条钉住，并且**用真实的判定键**（不是手写的字符串）去跑映射。
 */

/** 一个"该发"的基线事实：已结案、结案日期 20 天前、有缺项、从未提醒过 */
const DUE_FACTS: ArchiveReminderFacts = {
  status: "closed",
  isArchived: false,
  isDeleted: false,
  closingDate: "2026-10-01",
  lastProgressAt: "2026-10-01T03:00:00.000Z",
  updatedAt: "2026-10-01T03:00:00.000Z",
  missing: ["openNodes"],
  lastNotifiedAt: null,
};

const CONFIG: ArchiveReminderConfig = {
  days: 14,
  statusCode: "closed",
  oncePerTarget: true,
  cooldownDays: 14,
};

/** 固定"现在"，让所有日期断言与机器时钟无关（2026-10-21 = 结案后第 20 天） */
const NOW = "2026-10-21T02:00:00.000Z";

describe("规则 9 的判定（纯函数）", () => {
  it("基线：结案满 14 天 + 有缺项 ⇒ due", () => {
    const d = judgeArchiveReminder(DUE_FACTS, CONFIG, NOW);
    expect(d.due).toBe(true);
    expect(d.reason).toBe("due");
    expect(d.daysClosed).toBe(20);
  });

  it("**差一天不发**（13 天 ⇒ too_early）：14 天是日界判定，不是「大概两周」", () => {
    const d = judgeArchiveReminder({ ...DUE_FACTS, closingDate: "2026-10-08" }, CONFIG, NOW);
    expect(d.due).toBe(false);
    expect(d.reason).toBe("too_early");
    expect(d.daysClosed).toBe(13);
  });

  it("正好第 14 天就发（边界取 `>=`，不是 `>`）", () => {
    const d = judgeArchiveReminder({ ...DUE_FACTS, closingDate: "2026-10-07" }, CONFIG, NOW);
    expect(d.daysClosed).toBe(14);
    expect(d.due).toBe(true);
  });

  it("材料齐备不发（`no_missing`）——这是本规则最该少发的方向", () => {
    const d = judgeArchiveReminder({ ...DUE_FACTS, missing: [] }, CONFIG, NOW);
    expect(d.due).toBe(false);
    expect(d.reason).toBe("no_missing");
  });

  it("未结案不发；已归档不发；已删除不发（三道状态闸门各自可辨）", () => {
    expect(judgeArchiveReminder({ ...DUE_FACTS, status: "in_progress" }, CONFIG, NOW).reason).toBe(
      "not_closed",
    );
    expect(judgeArchiveReminder({ ...DUE_FACTS, isArchived: true }, CONFIG, NOW).reason).toBe(
      "archived",
    );
    expect(judgeArchiveReminder({ ...DUE_FACTS, isDeleted: true }, CONFIG, NOW).reason).toBe(
      "deleted",
    );
  });

  it("**冷却期**：1 天前发过 ⇒ 不发（cooldown）；15 天前发过 ⇒ 再发", () => {
    const cooled = judgeArchiveReminder(
      { ...DUE_FACTS, lastNotifiedAt: "2026-10-20T02:00:00.000Z" },
      CONFIG,
      NOW,
    );
    expect(cooled.due).toBe(false);
    expect(cooled.reason).toBe("cooldown");
    expect(cooled.daysSinceLastNotify).toBe(1);

    const expired = judgeArchiveReminder(
      { ...DUE_FACTS, lastNotifiedAt: "2026-10-06T02:00:00.000Z" },
      CONFIG,
      NOW,
    );
    expect(expired.due).toBe(true);
    expect(expired.daysSinceLastNotify).toBe(15);
  });

  it("`once_per_target=false` 时冷却期不参与（§4.3：cooldown_days 只对 once 有意义）", () => {
    const d = judgeArchiveReminder(
      { ...DUE_FACTS, lastNotifiedAt: "2026-10-20T02:00:00.000Z" },
      { ...CONFIG, oncePerTarget: false },
      NOW,
    );
    expect(d.due).toBe(true);
  });

  it("`closing_date` 为空时回落到 `last_progress_at`（存量行不会成为静默死区）", () => {
    const d = judgeArchiveReminder(
      { ...DUE_FACTS, closingDate: null, lastProgressAt: "2026-10-01T03:00:00.000Z" },
      CONFIG,
      NOW,
    );
    expect(d.due).toBe(true);
    expect(d.daysClosed).toBe(20);
  });

  it("结案后有人评论（`last_progress_at` 被刷新）**不推迟**提醒（时钟锚在结案日期）", () => {
    const d = judgeArchiveReminder(
      { ...DUE_FACTS, lastProgressAt: "2026-10-20T03:00:00.000Z" },
      CONFIG,
      NOW,
    );
    expect(d.due, "材料不会因为有人评论就出现").toBe(true);
    expect(d.daysClosed).toBe(20);
  });

  it("时钟三档都取不到（closingDate 与 lastProgressAt 皆空）时用 updatedAt，不静默漏发", () => {
    const d = judgeArchiveReminder(
      {
        ...DUE_FACTS,
        closingDate: null,
        lastProgressAt: null,
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
      CONFIG,
      NOW,
    );
    expect(d.due).toBe(true);
  });
});

describe("缺项码：判定键 → B5 码 → 中文（两套码不许混用，且必须可逆）", () => {
  /**
   * **服务端那份 `READINESS_CHECKS` 是这一组的唯一"真源"**：接缝表
   * （`READINESS_SEAM`）与它一样是手写的，两边都改才会漂。断言拿服务端逐键比，
   * 而不是拿 shared 自己比——后者是永真。
   */
  const SERVER_CHECK_KEYS = READINESS_CHECKS.map((c) => c.key);

  it("**shared 的判定键集合与服务端 `READINESS_CHECKS` 逐字相同**（服务端加第四项而接缝表没跟，当场红）", () => {
    expect(READINESS_CHECK_KEYS.slice().sort()).toEqual(SERVER_CHECK_KEYS.slice().sort());
  });

  it("**遍历服务端全部判定键**：每个都有 B5 码，且那个码在 `MISSING_ITEM_LABELS` 里有中文名", () => {
    for (const key of SERVER_CHECK_KEYS) {
      const code = MISSING_CODE_BY_CHECK[key];
      expect(code, `${key} 没有 B5 码（漏配 ⇒ 正文里渲染出判定键本身）`).toBeTruthy();
      expect(MISSING_ITEM_LABELS[code ?? ""], `${code} 没有中文名`).toBeTruthy();
    }
  });

  it("**映射可逆**：码 → 判定键原路返回（否则审计里的 `missing_at_archive[]` 与通知对不上账）", () => {
    for (const key of SERVER_CHECK_KEYS) {
      const code = MISSING_CODE_BY_CHECK[key] ?? "";
      expect(MISSING_CHECK_BY_CODE[code], `${code} 反查不回 ${key}（两套码不是一一对应）`).toBe(
        key,
      );
    }
  });

  it("正向与反向都没有多余项：多余的码/标签 = 在描述一项不存在的校验", () => {
    expect(Object.keys(MISSING_CODE_BY_CHECK).sort()).toEqual([...READINESS_CHECK_KEYS].sort());
    expect(Object.keys(MISSING_CHECK_BY_CODE).sort()).toEqual(
      Object.values(MISSING_CODE_BY_CHECK).sort(),
    );
    expect(Object.keys(MISSING_ITEM_LABELS).sort()).toEqual(
      Object.keys(MISSING_CHECK_BY_CODE).sort(),
    );
  });

  it("**每个判定键渲染成中文，且渲染结果里一个拉丁字母/下划线都没有**——漏一个键时正文里会冒出 `closingDate`", () => {
    for (const key of SERVER_CHECK_KEYS) {
      const text = archiveReminderMissingText([key]);
      expect(text, `${key} 没有渲染成中文（得到 ${JSON.stringify(text)}）`).not.toMatch(
        /[A-Za-z_]/,
      );
    }
    // 三项一起（通知正文"缺：A、B"的真实形态）也不许漏
    expect(archiveReminderMissingText(SERVER_CHECK_KEYS)).not.toMatch(/[A-Za-z_]/);
  });

  it("用**真实判定键**跑一遍：`openNodes` 渲染成「待定节点未决」，不是 `openNodes`", () => {
    const text = archiveReminderMissingText(["openNodes"]);
    expect(text).toBe("待定节点未决");
    expect(text).not.toContain("openNodes");
    // 三项一起时的顺序与入参一致（通知正文里"缺：A、B"的读法）
    expect(archiveReminderMissingText(["judgment", "closingDate", "openNodes"])).toBe(
      "裁判文书附件、结案日期、待定节点未决",
    );
  });

  it("payload 里存 B5 码、原始键另存一份（排障不必反查映射表）", () => {
    const payload = archiveReminderPayload({
      code: "AJ-20261021-001",
      name: "冒烟案件",
      missing: ["closingDate", "openNodes"],
      daysClosed: 20,
    });
    expect(payload["missing"]).toEqual(["closing_date", "pending_nodes"]);
    expect(payload["missing_keys"]).toEqual(["closingDate", "openNodes"]);
    expect(payload["days_closed"]).toBe(20);
  });

  it("端到端：payload 过模板渲染，正文里出现中文缺项清单", () => {
    const payload = archiveReminderPayload({
      code: "AJ-20261021-001",
      name: "冒烟案件",
      missing: ["openNodes"],
      daysClosed: 20,
    });
    const vars = notificationVars(payload);
    expect(vars["missing"]).toBe("待定节点未决");
    // B5 定稿第 8 条的正文原样（模板 seed 里那份）
    const body = `「{name}」缺：{missing}（结案后 14 天未补齐）。请补录后归档；确无法补齐的，归档时写明原因。`;
    const rendered = body
      .replace("{name}", vars["name"] ?? "")
      .replace("{missing}", vars["missing"] ?? "");
    expect(rendered).toContain("缺：待定节点未决（结案后 14 天未补齐）");
  });

  it("未知键原样透传（宁可露出一个生词，也不要静默漏报一项）", () => {
    expect(missingCodes(["somethingNew"])).toEqual(["somethingNew"]);
  });
});
