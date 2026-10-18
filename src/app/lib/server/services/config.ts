import { and, asc, eq, ne } from "drizzle-orm";
import { ASSIGNABLE_SEMANTICS, SEMANTICS_RULES, type StatusSemantics } from "@/shared/enums/status";
import type { HostType } from "@/shared/enums/targets";
import { nextId } from "@/shared/ids/snowflake";
import type { ConfigItem, WritableConfigKind } from "@/shared/schema/config";

import { getDb } from "../db/client";
import {
  automationRule,
  expenseItemConfig,
  riskLevelConfig,
  statusConfig,
  tag,
} from "../db/schema";

/**
 * 功能配置的写出口（MATT-101）。
 *
 * ## 为什么单独一个服务文件，而不是塞进 `statuses.ts` / `expenses.ts`
 *
 * 那两个文件是**各自域内的读出口**（`statuses.ts` 给"取初始态 + 宿主状态字典"，
 * `expenses.ts` 给费用与费用项目清单）。本文件是**统一的可写配置出口**：5 个细项
 * 共用一套新增/改字段/启停的判定，差别只在表与列。塞进任一个域文件都会让
 * "配置写"这件事看起来只属于那个域，而它实际横跨五张表。
 *
 * ## 三条硬约束落在哪一层（`status-config.ts` 头注点名"要在服务层先判"）
 *
 * 三条约束（每宿主**恰好一个初始态 / 恰好一个归档态 / 至多一个结案态**）在 DB 层是
 * 三个 partial unique index（`ux_status_initial` / `ux_status_archived` / `ux_status_closed`）。
 * DB 那层兜底，但它报的是 **23505**（`duplicate key value violates unique constraint`）——
 * 用户看到的是"服务器错误"，看不出"这个宿主已经有一个结案态了"。所以本层**先判**，
 * 给可读的理由；DB 的索引仍然是最后一道（判完再写，写完 DB 再验一次）。
 *
 * 三条约束对应三个判定点：
 *   ① **改语义**（`semantics` 在更新入参里）→ `semanticsSlotConflict()` 按 `SEMANTICS_RULES`
 *      判"目标语义在这个宿主的槽位是否已被别人占着"（`exactly-one` / `at-most-one` 才有上界）；
 *   ② **停用初始态 / 归档态** → 停工常量（`is_initial_status` / `semantics='archived'`）：
 *      "恰好一个"要求它必须**可用**，停用它会让"恰好"只剩索引上的一个死槽；
 *   ③ **新增** → 新状态**只能给 `custom`**（`ASSIGNABLE_SEMANTICS`），所以新增永远撞不到
 *      ①② 的槽位约束；新增要判的是 **code 重复**（避开 `ux_status_code` 的 23505）。
 *
 * ## 停用一个被规则引用的状态 —— 明确拒绝（票面点名）
 *
 * `mn_automation_rule.trigger_config->>'status_code'` 引用状态 code（规则 1/3/9 引
 * `closed` / `in_progress`）。停用一个被启用规则引用的状态，会让规则的触发条件永远不满足，
 * 而**没有任何报错**——扫描器只是再也不命中它。所以本层把这条引用关系摆到明面上拒绝。
 */

/** 写路径的拒绝理由（路由层按 `why` 翻译成状态码与文案） */
export type ConfigWriteRejection =
  | { ok: false; why: "not_found" }
  | { ok: false; why: "duplicate_code"; code: string }
  | { ok: false; why: "duplicate_name"; name: string }
  | { ok: false; why: "semantics_taken"; semantics: string }
  | { ok: false; why: "rule_referenced"; statusCode: string; ruleCodes: string[] }
  | { ok: false; why: "initial_status" }
  | { ok: false; why: "archived_status" };

export type ConfigWriteOk = { ok: true; id: string };

/* ───────────────────────── 纯判定（离线可测） ───────────────────────── */

/**
 * 目标语义在这个宿主是否已被**别的行**占着槽位。
 *
 * 只判有上界的语义（`SEMANTICS_RULES` 的 `exactly-one` / `at-most-one`）：
 * `in_progress` 是 `at-least-one`（下界，多条并存是合法的）、`custom` 是 `any`。
 * 复用共享层的 `SEMANTICS_RULES`，不在路由或服务里再抄一份 1/1/1 —— 那份表就是
 * seed 与"新增状态校验"共用的判定（`status.ts` 头注写明）。
 */
export function semanticsSlotConflict(
  semantics: StatusSemantics,
  otherSemanticsInHost: readonly string[],
): boolean {
  const bound = SEMANTICS_RULES[semantics].perHost;
  if (bound !== "exactly-one" && bound !== "at-most-one") return false;
  return otherSemanticsInHost.includes(semantics);
}

/** 一条规则允许的触发状态码（`trigger_config.status_code`，缺键返回 null） */
export type RuleRef = { code: string; hostType: string; statusCode: string | null };

/**
 * 哪些**启用中的规则**引用了这个状态码。
 *
 * 宿主口径：规则 `host_type` 是 `all` / `matter` / `risk_matter`（比 E08/E10 多一个 `all`，
 * `enums/automation.ts` 的注）。`all` 的规则作用于两类宿主，所以它对任何宿主的状态都算引用。
 */
export function referencingRules(
  statusCode: string,
  host: HostType,
  rules: readonly RuleRef[],
): string[] {
  return rules
    .filter((r) => r.statusCode === statusCode && (r.hostType === "all" || r.hostType === host))
    .map((r) => r.code);
}

/* ───────────────────────── 读 ───────────────────────── */

/**
 * 一个细项的全部行（**含停用**）。
 *
 * 含停用是刻意的：细项页要能看见停用行并恢复它（票面"每页至少一行停用"）。
 * 选择器那一侧（`/api/meta`）另走 `hostStatusRows()` 的 `isEnabled` 过滤 ——
 * 两个用途读同一张表、两种过滤，判定只有一份数据。
 */
export async function listConfigItems(kind: WritableConfigKind): Promise<ConfigItem[]> {
  const db = await getDb();
  if (kind === "case_status" || kind === "item_status") {
    const host = kind === "case_status" ? "matter" : "risk_matter";
    const rows = await db
      .select({
        id: statusConfig.id,
        code: statusConfig.code,
        name: statusConfig.name,
        color: statusConfig.color,
        sortOrder: statusConfig.sortOrder,
        isEnabled: statusConfig.isEnabled,
        semantics: statusConfig.semantics,
        isInitialStatus: statusConfig.isInitialStatus,
        isSystem: statusConfig.isSystem,
      })
      .from(statusConfig)
      .where(eq(statusConfig.hostType, host))
      .orderBy(asc(statusConfig.sortOrder), asc(statusConfig.id));
    return rows.map((r) => ({
      ...r,
      id: String(r.id),
      hostType: null,
    }));
  }
  if (kind === "risk_level") {
    const rows = await db
      .select()
      .from(riskLevelConfig)
      .orderBy(asc(riskLevelConfig.sortOrder), asc(riskLevelConfig.id));
    return rows.map((r) => ({
      id: String(r.id),
      code: r.code,
      name: r.name,
      color: "",
      sortOrder: r.sortOrder,
      isEnabled: r.isEnabled,
      semantics: null,
      isInitialStatus: false,
      isSystem: r.isSystem,
      hostType: null,
    }));
  }
  if (kind === "expense_item") {
    const rows = await db
      .select()
      .from(expenseItemConfig)
      .orderBy(asc(expenseItemConfig.sortOrder), asc(expenseItemConfig.id));
    return rows.map((r) => ({
      id: String(r.id),
      code: r.code,
      name: r.name,
      color: "",
      sortOrder: r.sortOrder,
      isEnabled: r.isEnabled,
      semantics: null,
      isInitialStatus: false,
      isSystem: r.isSystem,
      hostType: null,
    }));
  }
  const rows = await db.select().from(tag).orderBy(asc(tag.sortOrder), asc(tag.id));
  return rows.map((r) => ({
    id: String(r.id),
    code: null,
    name: r.name,
    color: r.color,
    sortOrder: r.sortOrder,
    isEnabled: r.isEnabled,
    semantics: null,
    isInitialStatus: false,
    isSystem: r.isSystem,
    hostType: r.hostType,
  }));
}

/** 一个宿主下所有行的语义（判槽位冲突用） */
async function semanticsOfHost(host: HostType, exceptId?: bigint): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({ semantics: statusConfig.semantics })
    .from(statusConfig)
    .where(
      exceptId === undefined
        ? eq(statusConfig.hostType, host)
        : and(eq(statusConfig.hostType, host), ne(statusConfig.id, exceptId)),
    );
  return rows.map((r) => r.semantics);
}

/** 启用中规则的触发状态码引用（规则表只有个位数行，整体取回后按宿主+code 判） */
async function enabledRuleRefs(): Promise<RuleRef[]> {
  const db = await getDb();
  const rows = await db
    .select({
      code: automationRule.code,
      hostType: automationRule.hostType,
      triggerConfig: automationRule.triggerConfig,
    })
    .from(automationRule)
    .where(eq(automationRule.isEnabled, true));
  return rows.map((r) => {
    const raw = (r.triggerConfig ?? {}) as Record<string, unknown>;
    const statusCode = raw["status_code"];
    return {
      code: r.code,
      hostType: r.hostType,
      statusCode: typeof statusCode === "string" && statusCode !== "" ? statusCode : null,
    };
  });
}

/* ───────────────────────── 写 ───────────────────────── */

/** 新增入参（`configCreateSchema(kind)` 的解析结果） */
export type ConfigCreateData = Record<string, unknown>;
/** 编辑入参（`configUpdateSchema(kind)` 的解析结果 + `id`） */
export type ConfigUpdateData = Record<string, unknown> & { id: string };

type Str = string | undefined;

const str = (v: unknown): Str => (typeof v === "string" ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/**
 * 新增一行。
 *
 * 状态类（`case_status` / `item_status`）：`semantics` **固定 `custom`**（`ASSIGNABLE_SEMANTICS`
 * 的唯一值），`is_initial_status` 固定 false，`is_archive_status` 是生成列**绝不写**。
 * 所以新增永远撞不到三条约束 —— 那三条是"恰好一个初始/归档态、至多一个结案态"，
 * 而新增只能落 `custom`。
 */
export async function createConfigItem(
  kind: WritableConfigKind,
  input: ConfigCreateData,
): Promise<ConfigWriteOk | ConfigWriteRejection> {
  const db = await getDb();
  const name = str(input.name)!;
  const sortOrder = num(input.sortOrder) ?? 0;
  const isEnabled = bool(input.isEnabled) ?? true;
  const id = BigInt(nextId());

  if (kind === "case_status" || kind === "item_status") {
    const host = kind === "case_status" ? "matter" : "risk_matter";
    const code = str(input.code)!;
    const dup = await findStatusByCode(host, code);
    if (dup) return { ok: false, why: "duplicate_code", code };
    await db.insert(statusConfig).values({
      id,
      code,
      name,
      color: str(input.color) ?? "",
      hostType: host,
      // 新建只能给 custom（E09）；不写 is_initial_status 与生成列 is_archive_status
      semantics: ASSIGNABLE_SEMANTICS[0],
      sortOrder,
      isEnabled,
    });
    return { ok: true, id: String(id) };
  }

  if (kind === "risk_level") {
    const code = str(input.code)!;
    if (await codeTaken(riskLevelConfig, code, undefined)) {
      return { ok: false, why: "duplicate_code", code };
    }
    await db.insert(riskLevelConfig).values({ id, code, name, sortOrder, isEnabled });
    return { ok: true, id: String(id) };
  }

  if (kind === "expense_item") {
    const code = str(input.code)!;
    if (await codeTaken(expenseItemConfig, code, undefined)) {
      return { ok: false, why: "duplicate_code", code };
    }
    await db.insert(expenseItemConfig).values({ id, code, name, sortOrder, isEnabled });
    return { ok: true, id: String(id) };
  }

  // tag：唯一键是（宿主 + 名称），没有 code 列
  const hostType = str(input.hostType)! as HostType;
  if (await tagNameTaken(hostType, name, undefined)) {
    return { ok: false, why: "duplicate_name", name };
  }
  await db.insert(tag).values({
    id,
    name,
    hostType,
    color: str(input.color) ?? "",
    sortOrder,
    isEnabled,
  });
  return { ok: true, id: String(id) };
}

/**
 * 改一行。`code` 不可改（它是引用键），所以入参里没有它。
 *
 * 状态类要额外判两件事：
 *   · **改语义**（`semantics`）→ 按 `SEMANTICS_RULES` 判目标槽位是否被别的行占着（避开 23505）；
 *   · **停用**（`isEnabled: false`）→ 若这一行是初始态 / 归档态 → 拒；
 *     若这个 code 被启用中的规则引用 → 拒（票面点名）。
 */
export async function updateConfigItem(
  kind: WritableConfigKind,
  input: ConfigUpdateData,
): Promise<ConfigWriteOk | ConfigWriteRejection> {
  const db = await getDb();
  const id = BigInt(input.id);
  const name = str(input.name);
  const color = str(input.color);
  const sortOrder = num(input.sortOrder);
  const isEnabled = bool(input.isEnabled);

  if (kind === "case_status" || kind === "item_status") {
    const host = kind === "case_status" ? "matter" : "risk_matter";
    const [cur] = await db
      .select()
      .from(statusConfig)
      .where(and(eq(statusConfig.id, id), eq(statusConfig.hostType, host)))
      .limit(1);
    if (!cur) return { ok: false, why: "not_found" };

    // 改语义：目标槽位在这个宿主是否已被别人占着
    const nextSemantics = str(input.semantics);
    if (nextSemantics !== undefined && nextSemantics !== cur.semantics) {
      const others = await semanticsOfHost(host, id);
      if (semanticsSlotConflict(nextSemantics as StatusSemantics, others)) {
        return { ok: false, why: "semantics_taken", semantics: nextSemantics };
      }
    }

    // 停用：三处护栏
    if (isEnabled === false && cur.isEnabled) {
      if (cur.isInitialStatus) return { ok: false, why: "initial_status" };
      if (cur.semantics === "archived") return { ok: false, why: "archived_status" };
      const refs = referencingRules(cur.code, host, await enabledRuleRefs());
      if (refs.length > 0) {
        return { ok: false, why: "rule_referenced", statusCode: cur.code, ruleCodes: refs };
      }
    }

    const patch: Record<string, unknown> = {};
    if (name !== undefined) patch.name = name;
    if (color !== undefined) patch.color = color;
    if (sortOrder !== undefined) patch.sortOrder = sortOrder;
    if (isEnabled !== undefined) patch.isEnabled = isEnabled;
    if (nextSemantics !== undefined) patch.semantics = nextSemantics;
    if (Object.keys(patch).length > 0) {
      await db.update(statusConfig).set(patch).where(eq(statusConfig.id, id));
    }
    return { ok: true, id: String(id) };
  }

  if (kind === "risk_level") {
    const [cur] = await db
      .select()
      .from(riskLevelConfig)
      .where(eq(riskLevelConfig.id, id))
      .limit(1);
    if (!cur) return { ok: false, why: "not_found" };
    const patch: Record<string, unknown> = {};
    if (name !== undefined) patch.name = name;
    if (sortOrder !== undefined) patch.sortOrder = sortOrder;
    if (isEnabled !== undefined) patch.isEnabled = isEnabled;
    if (Object.keys(patch).length > 0) {
      await db.update(riskLevelConfig).set(patch).where(eq(riskLevelConfig.id, id));
    }
    return { ok: true, id: String(id) };
  }

  if (kind === "expense_item") {
    const [cur] = await db
      .select()
      .from(expenseItemConfig)
      .where(eq(expenseItemConfig.id, id))
      .limit(1);
    if (!cur) return { ok: false, why: "not_found" };
    const patch: Record<string, unknown> = {};
    if (name !== undefined) patch.name = name;
    if (sortOrder !== undefined) patch.sortOrder = sortOrder;
    if (isEnabled !== undefined) patch.isEnabled = isEnabled;
    if (Object.keys(patch).length > 0) {
      await db.update(expenseItemConfig).set(patch).where(eq(expenseItemConfig.id, id));
    }
    return { ok: true, id: String(id) };
  }

  // tag
  const [cur] = await db.select().from(tag).where(eq(tag.id, id)).limit(1);
  if (!cur) return { ok: false, why: "not_found" };
  const nextHost = (str(input.hostType) ?? cur.hostType) as HostType;
  const nextName = name ?? cur.name;
  if (nextHost !== cur.hostType || nextName !== cur.name) {
    if (await tagNameTaken(nextHost, nextName, id)) {
      return { ok: false, why: "duplicate_name", name: nextName };
    }
  }
  const patch: Record<string, unknown> = {};
  if (name !== undefined) patch.name = name;
  if (color !== undefined) patch.color = color;
  if (sortOrder !== undefined) patch.sortOrder = sortOrder;
  if (isEnabled !== undefined) patch.isEnabled = isEnabled;
  if (str(input.hostType) !== undefined) patch.hostType = nextHost;
  if (Object.keys(patch).length > 0) {
    await db.update(tag).set(patch).where(eq(tag.id, id));
  }
  return { ok: true, id: String(id) };
}

/* ───────────────────── 重复判定（避开 DB 的 23505） ───────────────────── */

async function findStatusByCode(host: HostType, code: string) {
  const db = await getDb();
  const [row] = await db
    .select({ id: statusConfig.id })
    .from(statusConfig)
    .where(and(eq(statusConfig.hostType, host), eq(statusConfig.code, code)))
    .limit(1);
  return row ?? null;
}

async function codeTaken(
  table: typeof riskLevelConfig | typeof expenseItemConfig,
  code: string,
  exceptId: bigint | undefined,
): Promise<boolean> {
  const db = await getDb();
  const [row] = await db
    .select({ id: table.id })
    .from(table)
    .where(
      exceptId === undefined
        ? eq(table.code, code)
        : and(eq(table.code, code), ne(table.id, exceptId)),
    )
    .limit(1);
  return row !== undefined;
}

async function tagNameTaken(
  host: HostType,
  name: string,
  exceptId: bigint | undefined,
): Promise<boolean> {
  const db = await getDb();
  const [row] = await db
    .select({ id: tag.id })
    .from(tag)
    .where(
      exceptId === undefined
        ? and(eq(tag.hostType, host), eq(tag.name, name))
        : and(eq(tag.hostType, host), eq(tag.name, name), ne(tag.id, exceptId)),
    )
    .limit(1);
  return row !== undefined;
}
