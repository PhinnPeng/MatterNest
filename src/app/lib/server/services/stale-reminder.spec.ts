import { describe, expect, it } from "vitest";
import {
  judgeStale30d,
  stale30dPayload,
  stale30dWindowDate,
  type Stale30dConfig,
  type Stale30dFacts,
} from "@/shared/notification/stale-30d";
import { notificationVars, renderNotification } from "@/shared/notification/template";

/**
 * 规则 4「长期未更新提醒」的判定门（MATT-61 / T4e）。
 *
 * 与 `archive-reminder.spec.ts`（规则 9）互为对照，但**不共用**判定：
 * 两条规则的时钟锚点不同（结案 vs 上次投入），合并实现会让任何一条的口径改动
 * 动到另一条，而它们的语义分歧是刻意的（见 `stale-30d.ts` 文件头）。
 */

const NOW = "2026-10-15T04:00:00.000Z"; // 上海 12:00

/** 规则目录里的实际取值（`preset-rules.ts` 规则 4 + seed 0006） */
const CONFIG: Stale30dConfig = { days: 30, oncePerTarget: true, cooldownDays: 30 };

/** 31 天没动过的案件：刚好越过 30 天线 */
const STALE: Stale30dFacts = {
  isArchived: false,
  isDeleted: false,
  lastProgressAt: "2026-09-14T04:00:00.000Z",
  updatedAt: "2026-09-14T04:00:00.000Z",
  lastNotifiedAt: null,
};

/** 刚更新过的案件（AC 里"反向的那一半"） */
const FRESH: Stale30dFacts = { ...STALE, lastProgressAt: NOW, updatedAt: NOW };

describe("闸门顺序（由便宜到贵）", () => {
  it("已软删 ⇒ deleted，且不去看时间与冷却", () => {
    const d = judgeStale30d({ ...STALE, isDeleted: true }, CONFIG, NOW);
    expect(d.due).toBe(false);
    expect(d.reason).toBe("deleted");
    expect(d.daysStale).toBeNull();
  });

  it("**已归档 ⇒ archived**（AC：归档记录不触发）—— 归档是终态，再提醒等于让人去改只读记录", () => {
    const d = judgeStale30d({ ...STALE, isArchived: true }, CONFIG, NOW);
    expect(d.due).toBe(false);
    expect(d.reason).toBe("archived");
  });

  it("**刚更新过的 ⇒ too_early**（假阳性方向的护栏，比正向更重要）", () => {
    const d = judgeStale30d(FRESH, CONFIG, NOW);
    expect(d.due).toBe(false);
    expect(d.reason).toBe("too_early");
    expect(d.daysStale).toBe(0);
  });

  it("恰好差一天（29 天）⇒ too_early，第 30 天 ⇒ due（日界判定，不是秒差）", () => {
    const at29 = { ...STALE, lastProgressAt: "2026-09-16T04:00:00.000Z" };
    expect(judgeStale30d(at29, CONFIG, NOW).reason).toBe("too_early");
    const at30 = { ...STALE, lastProgressAt: "2026-09-15T04:00:00.000Z" };
    expect(judgeStale30d(at30, CONFIG, NOW).reason).toBe("due");
  });

  it("31 天 ⇒ due，且 `daysStale` 报的是真实天数（排障口径，不是日志装饰）", () => {
    const d = judgeStale30d(STALE, CONFIG, NOW);
    expect(d.due).toBe(true);
    expect(d.reason).toBe("due");
    expect(d.daysStale).toBe(31);
  });

  it("**不受状态闸门约束**：已结案未归档且 30 天没动，照样 due（与规则 9 显式不同）", () => {
    // 目录里那句「closed 案件 14 天补材料、30 天无进展」是刻意接受的双档；
    // 加状态闸门就会让"结案后没人管"这一档静默沉默 —— 而它正是本规则要响的场景。
    const d = judgeStale30d({ ...STALE }, CONFIG, NOW);
    expect(d.due).toBe(true);
  });
});

describe("时钟锚点：`last_progress_at` 本身，兜底 `updatedAt`", () => {
  it("`last_progress_at` 为空 ⇒ 退到 `updated_at`（存量行不至于永久沉默）", () => {
    const d = judgeStale30d(
      { ...STALE, lastProgressAt: null, updatedAt: "2026-09-14T04:00:00.000Z" },
      CONFIG,
      NOW,
    );
    expect(d.due).toBe(true);
    expect(d.anchorAt).toBe("2026-09-14T04:00:00.000Z");
  });

  it("**`last_progress_at` 优先于 `updated_at`**：两者不一致时按前者（后者会被系统动作刷新）", () => {
    const d = judgeStale30d(
      { ...STALE, lastProgressAt: "2026-09-14T04:00:00.000Z", updatedAt: NOW },
      CONFIG,
      NOW,
    );
    expect(d.anchorAt).toBe("2026-09-14T04:00:00.000Z");
    expect(d.due).toBe(true);
    // 反过来：若误用 updated_at 当锚点，这一条会读成"刚动过"
    expect(d.daysStale).toBe(31);
  });
});

describe("冷却期 = `once_per_target` 的兑现方式", () => {
  it("**第 30 天发第一条、之后 30 天内静默**（不是「只发一次、永远沉默」）", () => {
    // 上一条是 10 天前发的 ⇒ 距上次提醒 10 < 30 ⇒ cooldown
    const d = judgeStale30d({ ...STALE, lastNotifiedAt: "2026-10-05T04:00:00.000Z" }, CONFIG, NOW);
    expect(d.due).toBe(false);
    expect(d.reason).toBe("cooldown");
    expect(d.daysSinceLastNotify).toBe(10);
  });

  it("**满 30 天之后再来一条**（仍然没人管时）—— 与「永远沉默」是不同产品行为", () => {
    const d = judgeStale30d({ ...STALE, lastNotifiedAt: "2026-09-14T04:00:00.000Z" }, CONFIG, NOW);
    expect(d.daysSinceLastNotify).toBe(31);
    expect(d.due).toBe(true);
  });

  it("`once_per_target=false` 时冷却期不参与（§4.3）", () => {
    const d = judgeStale30d(
      { ...STALE, lastNotifiedAt: "2026-10-14T04:00:00.000Z" },
      { ...CONFIG, oncePerTarget: false },
      NOW,
    );
    expect(d.due).toBe(true);
  });

  it("从未发过（`lastNotifiedAt=null`）⇒ 不受冷却期影响", () => {
    expect(judgeStale30d(STALE, CONFIG, NOW).due).toBe(true);
  });
});

describe("payload 与模板渲染", () => {
  it("**锚点存在 `last_progress_at` 这个键上** —— `{last}` 只认它（`template.ts:176`）", () => {
    const p = stale30dPayload({
      code: "AJ-2026-001",
      name: "某某建设工程施工合同纠纷",
      anchorAt: "2026-09-14T04:00:00.000Z",
      daysStale: 31,
    });
    expect(p["last_progress_at"]).toBe("2026-09-14T04:00:00.000Z");
    // 写成别的键名不会报错，只会把正文渲染成「自 — 后无任何人工更新」——
    // 一个读起来通顺、却把事实抹掉的句子。这条断言就是那个形态的守卫。
    expect(p).not.toHaveProperty("last");
    expect(notificationVars(p)["last"]).not.toBe("");
  });

  it("渲染出的正文里**不留未替换的占位符**，也不出现 —（缺值兜底）", () => {
    const p = stale30dPayload({
      code: "AJ-2026-001",
      name: "某某建设工程施工合同纠纷",
      anchorAt: "2026-09-14T04:00:00.000Z",
      daysStale: 31,
    });
    const r = renderNotification(
      {
        titleTpl: "【MatterNest】案件 {code} 已 30 天无进展",
        bodyTpl: "「{name}」自 {last} 后无任何人工更新。",
      },
      p,
    );
    expect(r?.body).toContain("2026-09-14");
    expect(r?.body).not.toContain("{");
    expect(r?.body).not.toContain("—");
  });
});

describe("窗口日期（只用于日志与断言，不参与判定）", () => {
  it("`now - days` 落在上海业务日上", () => {
    expect(stale30dWindowDate(NOW, 30)).toBe("2026-09-15");
  });
});
