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
 * F2-26 三项校验码 → 中文（`docs/PRD-phase1-g-targets-b5-draft.md` 措辞设计说明第 4 条）。
 *
 * 这张映射住在 shared 而不是 `archive-readiness.ts`：那一侧给的是**校验结果**，
 * 这一侧要的是**给人读的缺项清单**，两者由同一个码集相连。少一处映射就会多一份口径。
 */
export const MISSING_ITEM_LABELS: Readonly<Record<string, string>> = {
  judgment_doc: "裁判文书附件",
  closing_date: "结案日期",
  pending_nodes: "待定节点未决",
};

/**
 * F2-26 三项校验的**判定键**（服务端 `services/archive-readiness.ts` 的 `ReadinessCheckKey`、
 * 客户端 `lib/client/archive-readiness.ts` 的 `ReadinessKey` 都是它）。
 *
 * ## 为什么这里要重声明一次，而不是从服务端 import
 *
 * 禁令①：`src/shared/**` 不得反向依赖 app 层。所以共享层只能**自己声明**这个联合，
 * 而"两份声明漂移"由断言堵：`services/archive-reminder.spec.ts` 拿服务端的
 * `READINESS_CHECKS` 逐键比对（服务端加第四项而这里没跟，当场红）。
 *
 * ## 为什么它必须存在（而不是直接拿字符串拼）
 *
 * 两个码集**不是同一套**：判定侧是 `judgment`/`closingDate`/`openNodes`，
 * 而 B5 的 `{missing}` 占位符吃的是 `judgment_doc`/`closing_date`/`pending_nodes`。
 * 直接把判定键塞进 payload 的后果是通知正文渲染成「缺：closingDate、openNodes」——
 * **中文界面里冒出两个英文驼峰词**，而它不会报错、不会有类型错误。
 * 规则 9（MATT-43）是第一个真的把判定结果送进通知的路径，所以这层映射在这里补齐。
 */
export const READINESS_CHECK_KEYS = ["judgment", "closingDate", "openNodes"] as const;
export type ReadinessCheckKey = (typeof READINESS_CHECK_KEYS)[number];

/** 判定键 → B5 的 payload 码（§措辞设计说明第 4 条的三对，逐字） */
export const MISSING_CODE_BY_CHECK: Readonly<Record<ReadinessCheckKey, string>> = {
  judgment: "judgment_doc",
  closingDate: "closing_date",
  openNodes: "pending_nodes",
};

/**
 * 判定键数组 → 通知 payload 的 `missing`（B5 码）。
 *
 * 未知键**原样透传**而不是丢掉：丢掉会让"服务端加了一项校验、通知里却不提它"
 * 变成静默的漏报；透传至少会在界面上露出一个生词，而这正是能被发现的形态。
 */
export function missingCodes(keys: readonly string[]): string[] {
  return keys.map((k) => MISSING_CODE_BY_CHECK[k as ReadinessCheckKey] ?? k);
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
