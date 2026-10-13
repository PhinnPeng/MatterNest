/**
 * 通知正文的**读取时渲染**（权限草案 §7.1 / master F4-7）。
 *
 * ## 唯一一条实质分歧，写在这里免得被"优化"掉
 *
 * §7.1 原文：「通知只存 `event_id` + 白名单摘要，正文读取时按当前权限实时渲染，
 * **不落渲染快照**（快照会把敏感内容永久留在已失权者的收件箱里）。这是与常见通知系统
 * 做法的唯一实质分歧。」
 *
 * 所以：`mn_notification_event.title` / `body` 两列**保留但不写**（列在 §7.2 的表结构里，
 * 删了是迁移债），文案由本文件在**每次读取时**从 `template + payload` 现算。
 * 后果是"某条通知的标题会随模板改文案而变"——这是特性不是 bug：
 * 模板改的是"这件事该怎么被描述"，而快照会把旧描述永久留在收件箱里。
 *
 * ## 为什么渲染变量要在这里做映射，而不是把展示串存进 payload
 *
 * payload 存的是**事实**（`deadline_time` 是 ISO 瞬时、`missing` 是校验码），
 * 展示串（`2026-10-15 06:30`、`裁判文书附件`）是**读法**。
 * 把读法存进 payload 就等于把"上海时区"和"中文枚举"冻在那一次写入里，
 * 之后改文案或改时区口径都追不回来——而通知恰好是会被翻旧账的东西。
 */
import { formatBusinessTime } from "@/shared/time/zh-cn";

/** 收件人已不可见时的占位标题（权限草案 §7.1：保留占位行，不隐藏整行） */
export const INVISIBLE_NOTIFICATION_TITLE = "无权查看的记录";

/** 取不到值时统一落这个，而不是空串——空串会渲染出"计划 。"这种看着像坏了的句子 */
const EMPTY = "—";

/**
 * F2-26 三项校验的**接缝表**（MATT-70）：判定键 / B5 码 / 中文缺项用词，**各写一次**。
 *
 * ## 同一件事实有两套词汇，两套各自在自己的边界内都是对的
 *
 * | 词汇 | 值 | 用在哪 |
 * |---|---|---|
 * | **判定键** | `judgment` / `closingDate` / `openNodes` | 服务端 `services/archive-readiness.ts` 的 `READINESS_CHECKS`、`ARCHIVED.payload.missing_at_archive[]`（G4 唯一数据源）、`smoke-archive` |
 * | **B5 `{missing}` 码** | `judgment_doc` / `closing_date` / `pending_nodes` | 通知 `payload.missing` 与正文（`docs/PRD-phase1-g-targets-b5-draft.md` 措辞设计说明第 4 条） |
 *
 * ## 为什么这次**不**统一到一套词汇（MATT-70 的取舍，票面要求先写清再动手）
 *
 * 因为**两套码都已经写进 jsonb 里的历史行了**：归档时 `missing_at_archive[]` 落的是判定键
 * （`services/matters.ts`），MATT-43 落进 `archive_incomplete` 事件的 `payload.missing` 是 B5 码。
 * 统一口径必然要求回填历史行——那是**改写审计里已经成立的事实**，票面边界明确禁止顺带做掉。
 * 而任选一套当新口径，都会让同一列里从此并存两套词（G4 指标与事后对账都要为此写兼容分支），
 * 比今天的"一张翻译表"更贵。
 *
 * 所以保留两套，代价是这张表必须**单一来源 + 可逆**——下面就是它。
 *
 * ## 为什么它原来是四张手抄的表
 *
 * 旧形态：`READINESS_CHECK_KEYS`（判定键）+ `MISSING_CODE_BY_CHECK`（键→码）+
 * `MISSING_ITEM_LABELS`（码→中文）三处各抄一遍；判定键本身还有第四处独立声明
 * （服务端 `ReadinessCheckKey` 与客户端 `ReadinessKey` 两个联合）。
 * 加一项校验要改三处，而**漏改不报错、不类型错、测试也绿**——
 * 只是通知正文里多冒出一个英文驼峰词（`closingDate`）或下划线词（`closing_date`）。
 * 本仓纪律是"手抄的清单就是漂移点"，所以这里收敛成一张：其余全是推导。
 *
 * ## 推导出来的三张索引为什么仍然声明成 `Record<string, …>`
 *
 * 因为声明成 `Record<ReadinessCheckKey, …>` 会让**类型替我们担保键齐了**，
 * 而 `Object.fromEntries` 在类型上恰恰证明不了这一点（它的返回值就是 `Record<string, string>`）。
 * `Record<string, …>` 配上 `noUncheckedIndexedAccess` 才是诚实的：查一个不存在的键得到
 * `string | undefined`，调用点的 `?? 兜底` 才真的是兜底而不是摆设。
 * **齐不齐由断言回答**（`services/archive-reminder.spec.ts` 拿服务端那份**独立**声明逐键比对），
 * 不由类型回答——这也正是"删掉一个键要红成断言、不是红成编译错"的原因。
 */
export const READINESS_SEAM = {
  judgment: { code: "judgment_doc", itemLabel: "裁判文书附件" },
  closingDate: { code: "closing_date", itemLabel: "结案日期" },
  openNodes: { code: "pending_nodes", itemLabel: "待定节点未决" },
} as const;

/**
 * F2-26 三项校验的**判定键**。
 *
 * ## 为什么 shared 这里还要有一份声明，而不是从服务端 import
 *
 * 禁令①：`src/shared/**` 不得反向依赖 app 层，所以共享层只能自己声明这个联合。
 * 现在它是从接缝表推出来的（不是手抄的），而服务端那份 `ReadinessCheckKey`
 * 仍是**刻意保留的独立第二处声明**——两份漂移由 `archive-reminder.spec.ts` 逐键比对堵住。
 *
 * ⚠ 别把服务端也改成从这张表推导：两侧一旦同源，"服务端加了第四项而接缝表没跟"就
 * 永远不会发生，那条比对断言也就退化成永真、什么也钉不住。独立才有比对的意义。
 */
export type ReadinessCheckKey = keyof typeof READINESS_SEAM;

/**
 * 接缝表的键序（= 三项的固定顺序）。由 `Object.keys` 取得，插入序即书写序，
 * 所以"三项一起渲染"的通知正文顺序与 `archive-readiness.ts` 的 `READINESS_CHECKS` 一致。
 */
export const READINESS_CHECK_KEYS = Object.keys(READINESS_SEAM) as readonly ReadinessCheckKey[];

/** 判定键 → B5 的 payload 码（§措辞设计说明第 4 条的三对，逐字） */
export const MISSING_CODE_BY_CHECK: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(READINESS_SEAM).map(([key, seam]) => [key, seam.code]),
);

/**
 * B5 码 → 判定键（**反向**索引）。
 *
 * 它是"映射可逆"的兑现处（MATT-70 票面要求）：审计里的 `missing_at_archive[]` 存判定键、
 * 通知 `payload.missing` 存 B5 码，没有这张表就只能人对着接缝表逐个念，
 * 事后拿"用户当时看到的话"对"当时到底缺了什么"就对不齐。
 */
export const MISSING_CHECK_BY_CODE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(READINESS_SEAM).map(([key, seam]) => [seam.code, key]),
);

/** B5 码 → 通知正文里的中文缺项用词（同一张接缝表推出来的，不再手抄第二遍） */
export const MISSING_ITEM_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(READINESS_SEAM).map(([, seam]) => [seam.code, seam.itemLabel]),
);

/**
 * 判定键数组 → 通知 payload 的 `missing`（B5 码）。
 *
 * 未知键**原样透传**而不是丢掉：丢掉会让"服务端加了一项校验、通知里却不提它"
 * 变成静默的漏报；透传至少会在界面上露出一个生词，而这正是能被发现的形态。
 *
 * ⚠ 查表是**运行时**查的（入参是 `string`，不是判定键联合）——所以漏配一个键不会类型报错，
 * 只会把 `closingDate` 原样送进正文。抓住那个形态的是 `archive-reminder.spec.ts` 里
 * "渲染结果不得含拉丁字母/下划线"那条断言，不是这里的类型。
 */
export function missingCodes(keys: readonly string[]): string[] {
  return keys.map((k) => MISSING_CODE_BY_CHECK[k] ?? k);
}

/** `{占位符}` 的形态。只认小写字母与下划线，避免把正文里的 `{}`（JSON 片段）吃掉 */
const PLACEHOLDER = /\{([a-z_]+)\}/g;

/**
 * 模板替换。未知占位符**原样保留**（`{foo}` 留在串里）而不是抹成空：
 * 模板里写错一个变量名，抹掉之后得到的是"这句话读起来通顺但少了一段"，
 * 而原样保留会在界面上一眼看见。缺值走 `—`（见 `EMPTY`）。
 */
export function renderTemplate(
  template: string,
  vars: Readonly<Record<string, string | number | null | undefined>>,
): string {
  return template.replace(PLACEHOLDER, (whole, key: string) => {
    if (!(key in vars)) return whole;
    const v = vars[key];
    if (v === null || v === undefined || v === "") return EMPTY;
    return String(v);
  });
}

/**
 * payload（事实）→ 模板变量（读法）。
 *
 * 键名与 B5 定稿的占位符一一对应：`{code} {name} {from} {to} {node} {time}
 * {actor} {quoted} {last} {days} {missing}`。**时间类的两个键在这里过 `formatBusinessTime`**，
 * 这是"通知文案时间一律 Asia/Shanghai"的落点——payload 里存的是 UTC 瞬时。
 */
export function notificationVars(
  payload: Readonly<Record<string, unknown>> | null | undefined,
): Record<string, string> {
  const p = payload ?? {};
  const str = (k: string): string => {
    const v = p[k];
    return v === null || v === undefined ? "" : String(v);
  };
  const missing = Array.isArray(p["missing"]) ? (p["missing"] as unknown[]).map(String) : [];
  return {
    code: str("code"),
    name: str("name"),
    from: str("from"),
    to: str("to"),
    node: str("node"),
    actor: str("actor"),
    quoted: str("quoted"),
    days: str("days"),
    // ⚠ 这两行就是时区的落点：会话钉 UTC，直接格式化会差 8 小时
    time: formatBusinessTime(str("deadline_time")),
    last: formatBusinessTime(str("last_progress_at")),
    missing: missing.map((m) => MISSING_ITEM_LABELS[m] ?? m).join("、"),
  };
}

/** 一条渲染好的通知（服务端算好给接口，前端不重算） */
export type RenderedNotification = {
  title: string;
  body: string;
};

/** 模板行的最小形状。只收渲染要用的两列，避免把 DB 类型拖进 shared */
export type TemplateRow = {
  titleTpl: string;
  bodyTpl: string;
};

/**
 * 渲染一条通知。模板缺失时返回 `null` 而不是抛：
 *
 * 抛会把整个通知中心变成 500，而"某个 event_type 没有模板"只该让**那一条**说不出来。
 * 调用方拿到 null 后落一句可读的降级文案（而不是空白行）。
 */
export function renderNotification(
  template: TemplateRow | undefined,
  payload: Readonly<Record<string, unknown>> | null | undefined,
): RenderedNotification | null {
  if (!template) return null;
  const vars = notificationVars(payload);
  return {
    title: renderTemplate(template.titleTpl, vars),
    body: renderTemplate(template.bodyTpl, vars),
  };
}
