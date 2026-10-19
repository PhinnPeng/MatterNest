import dayjs from "dayjs";

import {
  DATE_COMPACT_PATTERN,
  DATE_DISPLAY_PATTERN,
  DEADLINE_COUNTDOWN_PATTERN,
} from "@/shared/time/zh-cn";

/**
 * 展示层格式化。**只在客户端组件里用**，服务端不格式化——
 * 两边各格式一份，列表与详情就会出现"同一条记录两个日期写法"。
 *
 * 日期库换成了 dayjs：这不是风格选择，是**约束**——antd 的 `DatePicker`/`ConfigProvider`
 * 只认 dayjs。仓库里同时留 date-fns 与 dayjs 会让"月份显示成 September"这类事故无法归因，
 * 所以 `date-fns` 已随本次迁移从依赖里移除（守卫：`zod-rules.spec.ts` 同级的 `format.spec.ts`
 * 断言产出串，见下）。pattern 一律引 `@/shared/time/zh-cn`，不在这里重复字面量。
 */

export function dateTime(value: string | null | undefined): string {
  return value ? dayjs(value).format(DEADLINE_COUNTDOWN_PATTERN) : "—";
}

/** 相对时间：列表里"3 天前"比"2026年9月24日 14:02"更适合扫读 */
export function fromNow(value: string | null | undefined): string {
  if (!value) return "—";
  const diffMin = Math.round((Date.now() - dayjs(value).valueOf()) / 60_000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const hr = Math.round(diffMin / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.round(hr / 24);
  if (day < 31) return `${day} 天前`;
  return dayjs(value).format(DATE_DISPLAY_PATTERN);
}

/**
 * 日历日期（`date` 列，无时刻）。
 *
 * ⚠ 刻意不经过 `dayjs(...)`：驱动回来的是 `'YYYY-MM-DD'` 字符串，
 * 交给 Date/dayjs 解析会按本地时区解释，在负时区上会**漂一天**。
 * 立案日与发现日属于"纸面上的那天"，不是某个瞬间——这条与修订稿 §12.2 同源。
 */
export function calDate(value: string | null | undefined): string {
  if (!value) return "—";
  const [y, m, d] = value.slice(0, 10).split("-");
  if (!y || !m || !d) return value;
  return `${y}年${Number(m)}月${Number(d)}日`;
}

/** 表单 `<input type=date>` / antd DatePicker 的回填值（同样是纯日期串） */
export const isoDate = (value: string | null | undefined): string =>
  value ? value.slice(0, 10) : "";

/** 标的额：`numeric(18,2)` 从驱动回来的就是字符串，绝不 Number() 参与运算（修订稿 §12.2） */
export function money(value: string | null | undefined): string {
  if (!value) return "—";
  const [int, frac] = value.split(".");
  const grouped = (int ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${grouped}${frac ? `.${frac}` : ""}`;
}

/**
 * 审计记录的**动作主体**怎么显示（活动时间线两处共用）。
 *
 * ## 为什么必须有这个函数，而不是各处写 `a.operator ?? "…"`
 *
 * `operator` 为 `null` 表示**系统自动动作**（迁移 0016 放开了 `operator_id` 的 NOT NULL）。
 * 两处消费点（案件详情的时间线、总览的近期活动）各写一遍兜底串，就是两个字面量，
 * 改一处漏一处 —— 而这里改的正是"系统动作长什么样"这种会被人记住的展示口径。
 *
 * ## 为什么是「系统自动」而不是空串 / 破折号
 *
 * 空串与 `—` 已经是**别的意思**：前者像"数据缺了"，后者在本仓是"该字段没有值"
 * （见上面几个函数的兜底）。而这里的事实是"**这一次动作本来就没有人**"，
 * 是三种含义里唯一需要**说出来**的那种 —— 说不出来就等于把它和人做的动作混在一起，
 * 而那正是 OWASP NHI Top 10 / NHI10:2025 列为风险的那件事
 * （"Indistinguishable activity between humans and automation"）。
 *
 * 文案口径：`AGENTS.md`「UI 文案与结构」要求一句话要么是事实、要么是动作 ——
 * 这是个事实（谁做的：系统），不是旁白。
 */
export function actorName(operator: string | null | undefined): string {
  return operator ?? "系统自动";
}

/**
 * ⚠ 这里原先还有一个 `moneyCompact()`，**已删除**（2026-10-13）。
 *
 * 它长这样：
 *
 *     export function moneyCompact(value) {
 *       const n = typeof value === "number" ? value : Number(value ?? 0);   // ← 精度在这里丢
 *       if (n >= 1_0000_0000) return `${(n / 1_0000_0000).toFixed(2)} 亿`;
 *       if (n >= 1_0000) return `${(n / 1_0000).toFixed(1)} 万`;
 *       return String(n);
 *     }
 *
 * 删它的三个理由，任一条都够：
 *
 * ① **它是死的**：全仓零调用（工作台上根本没有金额渲染，费用合计行用的是上面的 `money()`）。
 * ② **它的注释是假的**：原注释写"工作台卡片与合计行用" —— 而这两处都没用它。
 *    本仓对"声明了但没有实现"很敏感（`SEMANTICS_RULES.closed.effect` 栽过一次）。
 * ③ **它是「禁 float」的现成地雷**：`Number()` + `toFixed()` 一进来，`numeric(18,2)` 的
 *    精度就没了（`"12345678901234.86"` → `12345678901234.86` → 科学计数/截断）。
 *    而它**长得像**一个可以随便用在金额上的函数 —— 下一个做合计卡片的人一定会伸手拿它，
 *    那一刻起金额就开始静默算错（不报错，这正是本仓最怕的那一类）。
 *
 * 处置方式与本仓对死代码的既有裁定一致（`mn_app_user.revoked_at`、`is_deleted` 那两次
 * 都是"要么补守卫、要么弃用并记一句"）。这里选择**删掉并留档**，因为"补一条守卫"只能防住
 * 记得去查守卫的人，而删掉之后**没有任何人能误用它**。
 *
 * 真要"1.2 万"这种压缩显示时：**在 SQL 里算**（像费用合计那样 `::numeric(18,2)::text` 出来），
 * 前端仍然只做字符串处理 —— 这条边界不破。
 */
export const DATE_COMPACT = DATE_COMPACT_PATTERN;
