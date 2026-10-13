import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NOTIFY_RECEIVERS,
  TRIGGER_CONFIG_KEYS,
  TRIGGER_CONFIG_OPTIONAL_KEYS,
  TRIGGER_TARGET_TYPES,
  TRIGGER_TYPES,
  RULE_HOST_TYPES,
} from "@/shared/enums/automation";
import { NOTIFICATION_EVENT_TYPES, NOTIFICATION_TEMPLATE_BY_EVENT } from "@/shared/enums/notify";
import {
  PRESET_RULES,
  notifyConfigOf,
  scopeKeyOf,
  type PresetRule,
} from "@/shared/automation/preset-rules";
import { SCOPE_KEY_LENGTH } from "@/shared/enums/automation";

/**
 * **seed ↔ 规则目录 ↔ 文档计数** 三向对拉（MATT-43 / T5b 的新门禁）。
 *
 * ## 它防的是什么（每一条都是"静默失败"）
 *
 * 1. **`scope_key` 手抄错一位。** 唯一约束不会报错，它只会**不再挡住**任何东西——
 *    而"同域同动作只能启用一条"这句话就此作废。这里用 `scopeKeyOf()` 现算复核。
 * 2. **seed 与目录漂移。** 目录是取值源、seed 是字面量投影；两者只靠"人抄得准"联系时，
 *    改一处忘另一处不会红。逐字段对拉把它变成编译期之外的机器检查。
 * 3. **规则 3/4 的宿主被改回 `all`**（IQ-9/Q37 的收窄）。这是产品裁定，
 *    回退不会报错，只会让事项侧重新收到噪音提醒。
 * 4. **计数口径（9 / 8）在文档里过期。** 票面 AC 明写"规则与模板计数口径同步"，
 *    而"文档说 8 条、库里 9 条"这种不一致只能靠读文档发现——所以把它变成断言。
 *
 * ## 为什么解析 SQL 而不是起一个库
 *
 * `pnpm verify` 必须离线可跑（`db:check` 就是因此被排除在 verify 之外的）。
 * 与 `enum-check.spec.ts` 同一条理由：**迁移/seed 文件是唯一事实**，
 * 比 TS 只能证明"两份 TS 互相抄对了"。
 *
 * ## 解析器必须有"没空转"的探针
 *
 * 校验类脚本最典型的空转形态是"正则没命中 ⇒ 零条 ⇒ 看起来和全部一致一样绿"。
 * 所以下面先断言行数与探针字段（`describe("解析器没空转")`）。
 */

/* ────────────────────────────────────────────────────────────────────────────
 * 一、一个够用的 SQL VALUES 解析器（只认本仓 seed 的写法）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 把 `VALUES` 与 `ON CONFLICT` 之间的部分切成一个个括号元组。
 *
 * 三件事必须同时处理，否则会切错而且**切错的方式很隐蔽**（少一行 = 少一条断言）：
 *   · 单引号串里的逗号与括号（`'{"days":14,"status_code":"closed"}'`）；
 *   · SQL 的 `''` 转义；
 *   · `::jsonb` 转型与行末逗号。
 */
function splitTuples(region: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inQuote = false;
  for (let i = 0; i < region.length; i++) {
    const c = region[i];
    if (inQuote) {
      if (c === "'") {
        if (region[i + 1] === "'")
          i++; // `''` 是一个字面单引号
        else inQuote = false;
      }
      continue;
    }
    if (c === "'") inQuote = true;
    else if (c === "(") {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0 && start >= 0) out.push(region.slice(start, i));
    }
  }
  return out;
}

/** 元组内按顶层逗号切字段（引号内的逗号不算分隔符） */
function splitFields(tuple: string): string[] {
  const out: string[] = [];
  let inQuote = false;
  let cur = "";
  for (let i = 0; i < tuple.length; i++) {
    const c = tuple[i];
    if (inQuote) {
      cur += c;
      if (c === "'") {
        if (tuple[i + 1] === "'") {
          cur += "'";
          i++;
        } else inQuote = false;
      }
      continue;
    }
    if (c === "'") {
      inQuote = true;
      cur += c;
      continue;
    }
    if (c === ",") {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

const unquote = (s: string): string => s.replace(/^'/, "").replace(/'$/, "").replace(/''/g, "'");
/** `'{"days":14}'::jsonb` → 对象。**先剥 `::jsonb` 再剥引号**（顺序反了会留下引号让 JSON.parse 抛） */
const asJson = (s: string): unknown => JSON.parse(unquote(s.replace(/::jsonb\s*$/, "").trim()));
const asBool = (s: string): boolean => s.trim() === "true";
const asNum = (s: string): number => Number(s.trim());

/**
 * 取 `VALUES … ON CONFLICT` 之间的那段。
 *
 * ⚠ **必须用 `lastIndexOf`，不能用 `indexOf`**：seed 的文件头注释里就写着
 * 「`ON CONFLICT ("code") DO NOTHING` 而不是 DO UPDATE」——`indexOf` 会命中那句注释，
 * 于是区间变成"起点在终点之后" ⇒ 切出空串 ⇒ **零行**，
 * 而零行的样子与"全部一致"一样绿（本文件开头警告的就是这个空转形态；
 * 第一次跑就是这么红的，`解析器没空转` 那两条断言把它当场抓住了）。
 */
function valuesRegion(raw: string): string {
  const start = raw.lastIndexOf("VALUES");
  const end = raw.lastIndexOf("ON CONFLICT");
  if (start < 0 || end <= start) {
    throw new Error(`seed 里找不到 VALUES … ON CONFLICT 区间（start=${start} end=${end}）`);
  }
  return raw.slice(start + "VALUES".length, end);
}

type SeedRule = {
  id: number;
  code: string;
  name: string;
  hostType: string;
  triggerType: string;
  triggerTargetType: string;
  triggerConfig: Record<string, unknown>;
  actionType: string;
  actionConfig: Record<string, unknown>;
  scopeKey: string;
  priority: number;
  isSystem: boolean;
  isEnabled: boolean;
  createdBy: number;
};

const RULE_SEED = "src/app/lib/server/db/seed/0006_automation_rules.sql";
const TEMPLATE_SEED = "src/app/lib/server/db/seed/0005_notification_templates.sql";

function parseRules(): SeedRule[] {
  const raw = readFileSync(RULE_SEED, "utf8");
  const region = valuesRegion(raw);
  return splitTuples(region).map((t) => {
    const f = splitFields(t);
    return {
      id: asNum(f[0] ?? ""),
      code: unquote(f[1] ?? ""),
      name: unquote(f[2] ?? ""),
      hostType: unquote(f[3] ?? ""),
      triggerType: unquote(f[4] ?? ""),
      triggerTargetType: unquote(f[5] ?? ""),
      triggerConfig: asJson(f[6] ?? "{}") as Record<string, unknown>,
      actionType: unquote(f[7] ?? ""),
      actionConfig: asJson(f[8] ?? "{}") as Record<string, unknown>,
      scopeKey: unquote(f[9] ?? ""),
      priority: asNum(f[10] ?? ""),
      isSystem: asBool(f[11] ?? ""),
      isEnabled: asBool(f[12] ?? ""),
      createdBy: asNum(f[13] ?? ""),
    };
  });
}

/** 模板 seed 的 code 列（第 2 个字段）。只取 code 与 event_type 就够本文件用 */
function parseTemplates(): { code: string; eventType: string }[] {
  const raw = readFileSync(TEMPLATE_SEED, "utf8");
  const region = valuesRegion(raw);
  return splitTuples(region).map((t) => {
    const f = splitFields(t);
    return { code: unquote(f[1] ?? ""), eventType: unquote(f[2] ?? "") };
  });
}

const seededRules = parseRules();
const seededTemplates = parseTemplates();

/** 目录里的规则 → seed 行（按 `code` 认领；没有 `rule_no` 列，code 就是那条链） */
const rowOf = (rule: PresetRule): SeedRule | undefined =>
  seededRules.find((r) => r.code === rule.code);

describe("解析器没空转（seed 的 VALUES 真被读到了）", () => {
  it("规则 seed 解析出 9 行，模板 seed 解析出 8 行", () => {
    expect(seededRules.length).toBe(9);
    expect(seededTemplates.length).toBe(8);
  });

  it("探针：第 9 条规则的字段是逐字读出来的（不是空值/空串）", () => {
    const r = seededRules.find((x) => x.code === "preset_09_archive_incomplete_notify");
    expect(r?.name).toBe("结案后材料不全提醒");
    expect(r?.triggerConfig).toEqual({ days: 14, status_code: "closed" });
    expect(r?.actionConfig).toEqual({
      receivers: ["owner"],
      template_code: "archive_incomplete",
      once_per_target: true,
      cooldown_days: 14,
    });
    expect(r?.scopeKey).toBe("9hviq69mu3cd");
  });

  it("探针：模板 seed 的 code 列读到了（`{code}` 那种花括号不会把切分带偏）", () => {
    expect(seededTemplates.map((t) => t.code)).toContain("archive_incomplete");
    expect(seededTemplates.find((t) => t.code === "archive_incomplete")?.eventType).toBe(
      "archive_incomplete",
    );
  });
});

describe("seed ↔ 规则目录逐字段对拉", () => {
  it("code 集合两向相等（目录多一条 / seed 多一条都要红）", () => {
    expect([...seededRules.map((r) => r.code)].sort()).toEqual(
      PRESET_RULES.map((r) => r.code).sort(),
    );
  });

  it.each(PRESET_RULES.map((r) => [r.ruleNo, r.code] as const))(
    "规则 %i（%s）的每个字段都与目录一致",
    (ruleNo, code) => {
      const rule = PRESET_RULES.find((r) => r.ruleNo === ruleNo);
      expect(rule, `目录里没有第 ${ruleNo} 条`).toBeTruthy();
      const row = rowOf(rule as PresetRule);
      expect(row, `seed 里找不到 ${code}`).toBeTruthy();
      if (!rule || !row) return;
      expect(row.name).toBe(rule.name);
      expect(row.hostType).toBe(rule.hostType);
      expect(row.triggerType).toBe(rule.triggerType);
      expect(row.triggerTargetType).toBe(rule.triggerTargetType);
      expect(row.triggerConfig).toEqual(rule.triggerConfig);
      expect(row.actionType).toBe(rule.actionType);
      expect(row.actionConfig).toEqual(rule.actionConfig);
      expect(row.priority).toBe(rule.priority);
      expect(row.isEnabled).toBe(rule.enabledByDefault);
      // 预置规则一律 is_system=true（可停用、可调参，不可删）
      expect(row.isSystem).toBe(true);
      expect(row.createdBy).toBe(101);
    },
  );

  it("`code` 里编码了规则号（表里没有 rule_no 列，这条是唯一的机器化链接）", () => {
    for (const r of PRESET_RULES) {
      expect(r.code, `规则 ${r.ruleNo} 的 code 与规则号不符`).toMatch(
        new RegExp(`^preset_${String(r.ruleNo).padStart(2, "0")}_`),
      );
    }
  });

  it("id 落在 8xxx 低号段（seed 要跨环境逐字重放，不许用雪花值）", () => {
    for (const r of seededRules) {
      expect(r.id, `${r.code} 的 id`).toBeGreaterThanOrEqual(8000);
      expect(r.id).toBeLessThan(8100);
    }
    expect(new Set(seededRules.map((r) => r.id)).size).toBe(9);
  });

  it("**规则 3/4 的宿主收窄为仅案件**（IQ-9/Q37：事项无预设节点、观察型事项不催）", () => {
    for (const no of [3, 4]) {
      const row = seededRules.find((r) => r.code.startsWith(`preset_0${no}_`));
      expect(row, `seed 里没有规则 ${no}`).toBeTruthy();
      expect(row?.hostType, `规则 ${no} 的 host_type`).toBe("matter");
      expect(row?.triggerTargetType, `规则 ${no} 的触发实体`).toBe("matter");
    }
  });
});

describe("触发域唯一性（唯一约束在数据侧的前提）", () => {
  it("`scope_key` 逐条等于 `computeScopeKey()` 现算值（手抄错一位在这里红）", () => {
    for (const rule of PRESET_RULES) {
      const row = rowOf(rule);
      expect(row?.scopeKey, `规则 ${rule.ruleNo} 的 scope_key`).toBe(scopeKeyOf(rule));
    }
  });

  it("`scope_key` 形态：12 位 base32hex 小写", () => {
    for (const r of seededRules) {
      expect(r.scopeKey, r.code).toHaveLength(SCOPE_KEY_LENGTH);
      expect(r.scopeKey, r.code).toMatch(/^[0-9a-v]{12}$/);
    }
  });

  it("**9 条的 `(scope_key, action_type)` 两两不重复**（可同时启用）", () => {
    const pairs = seededRules.map((r) => `${r.scopeKey}|${r.actionType}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("规则 4 与规则 9 同触发类型但不同域（双档是刻意接受的，不是漏了归一化）", () => {
    const r4 = seededRules.find((r) => r.code.startsWith("preset_04_"));
    const r9 = seededRules.find((r) => r.code.startsWith("preset_09_"));
    expect(r4?.triggerType).toBe("time_no_progress");
    expect(r9?.triggerType).toBe("time_no_progress");
    expect(r4?.scopeKey).not.toBe(r9?.scopeKey);
    expect(r4?.actionType).toBe(r9?.actionType);
  });
});

describe("seed 的值域与 §4.1/§4.3 的 schema 一致", () => {
  it("每行的四个值域列都在登记表内", () => {
    for (const r of seededRules) {
      expect(RULE_HOST_TYPES, `${r.code} host_type`).toContain(r.hostType);
      expect(TRIGGER_TYPES, `${r.code} trigger_type`).toContain(r.triggerType);
      expect(TRIGGER_TARGET_TYPES, `${r.code} trigger_target_type`).toContain(r.triggerTargetType);
    }
  });

  it("`trigger_config` 的键在该 trigger_type 的白名单内，必填键一个不缺", () => {
    for (const r of seededRules) {
      const allowed = TRIGGER_CONFIG_KEYS[r.triggerType as keyof typeof TRIGGER_CONFIG_KEYS] ?? [];
      const optional =
        TRIGGER_CONFIG_OPTIONAL_KEYS[r.triggerType as keyof typeof TRIGGER_CONFIG_OPTIONAL_KEYS] ??
        [];
      const keys = Object.keys(r.triggerConfig);
      for (const k of keys) expect(allowed, `${r.code} 的未知键 ${k}`).toContain(k);
      for (const k of allowed) {
        if (optional.includes(k)) continue;
        expect(keys, `${r.code} 缺必填键 ${k}`).toContain(k);
      }
    }
  });

  it("notify 规则的 `receivers` 在 E04 内，且 `custom` 不带 `custom_user_ids` 时不许出现", () => {
    for (const rule of PRESET_RULES.filter((r) => r.actionType === "notify")) {
      const cfg = notifyConfigOf(rule);
      for (const recv of cfg.receivers) expect(NOTIFY_RECEIVERS, rule.code).toContain(recv);
      if (cfg.receivers.includes("custom")) expect(cfg.custom_user_ids ?? []).not.toHaveLength(0);
      else expect(cfg.custom_user_ids ?? []).toHaveLength(0);
    }
  });

  it("`once_per_target=true` 时 `cooldown_days >= 1`（§4.3 末行的校验）", () => {
    for (const rule of PRESET_RULES.filter((r) => r.actionType === "notify")) {
      const cfg = notifyConfigOf(rule);
      if (cfg.once_per_target) expect(cfg.cooldown_days ?? 0, rule.code).toBeGreaterThanOrEqual(1);
    }
  });

  it("规则 9 的收件人**只有经办人**（关注人是被动 star 进来的，推给他们是噪音）", () => {
    const r9 = PRESET_RULES.find((r) => r.ruleNo === 9);
    expect(r9 && notifyConfigOf(r9).receivers).toEqual(["owner"]);
  });
});

describe("计数口径（9 / 8）与文档同步", () => {
  const MASTER = readFileSync("docs/PRD-phase1-master.md", "utf8");
  const ALIGN_M5 = readFileSync("docs/PRD-phase1-alignment-m5.md", "utf8");
  const TECH = readFileSync("docs/tech-stack-decision.md", "utf8");

  it("规则 9 条、模板 8 条（seed 侧的事实）", () => {
    expect(seededRules.length).toBe(9);
    expect(seededTemplates.length).toBe(8);
  });

  it("每条 notify 规则的 `template_code` 都能在模板 seed 里找到", () => {
    const codes = new Set(seededTemplates.map((t) => t.code));
    for (const rule of PRESET_RULES.filter((r) => r.actionType === "notify")) {
      expect(codes, `${rule.code} 的模板`).toContain(notifyConfigOf(rule).template_code);
    }
  });

  it("E29 的 8 个事件都有模板落点（B5 定稿的 8 条）", () => {
    const codes = new Set(seededTemplates.map((t) => t.code));
    for (const ev of NOTIFICATION_EVENT_TYPES) {
      expect(codes, `事件 ${ev} 的模板`).toContain(NOTIFICATION_TEMPLATE_BY_EVENT[ev]);
    }
    expect(new Set(Object.values(NOTIFICATION_TEMPLATE_BY_EVENT)).size).toBe(8);
  });

  it("master §8 的配置 seed 行写着 9 条预置规则 / 8 个通知模板", () => {
    expect(MASTER).toContain("**9 条预置规则**");
    expect(MASTER).toContain("**8 个通知模板**");
  });

  it("M5 对齐件与选型件里的计数已同步（这两处曾是 8 / 7）", () => {
    expect(ALIGN_M5).toContain("9 条预置规则");
    expect(ALIGN_M5).not.toContain("我看到 8 条预置规则");
    expect(TECH).toContain("9 条预置规则");
    expect(TECH).toContain("8 通知模板");
  });
});
