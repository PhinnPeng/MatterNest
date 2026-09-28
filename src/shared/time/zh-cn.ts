/**
 * 全项目**唯一**的中文日期口径出口（禁令⑧：日期库全项目只允许一个）。
 *
 * 为什么只剩 pattern 而没有 locale 对象：换到 antd 之后日期库必须是 **dayjs**
 * （antd 的 `DatePicker`/`ConfigProvider` 只认 dayjs），而 dayjs 的语言靠 `dayjs.locale("zh-cn")`
 * 全局设，不需要把 locale 对象当 prop 传——上一版在 date-fns 那边必须传 `locale`，
 * 还因此产生过"`Locale` 含函数，不能在 Server Component 里当 prop 传"的硬约束。
 * **两处 provider 之外的地方都不许出现日期库**：格式串只有这一份。
 *
 * ⚠ **pattern 字面量必须重写，不是照抄**：date-fns 认 `yyyy`/`dd`，
 * dayjs 只认 `YYYY`/`DD`——直接照抄会输出 `yyyy年9月0日`（实测撞到的就是这条，
 * 而且是**测试**先撞到的：断言钉的是产出串 `2026年9月27日`，换库时它替我们把雷踩了出来）。
 * 口径保持与 date-fns 时期完全一致（`2026年9月27日`），
 * 因为 `zh-cn.spec.ts` 钉的就是产出串；换库不该改口径。
 */

/** 列表/详情里的日期展示口径：`2026年9月27日` */
export const DATE_DISPLAY_PATTERN = "YYYY年M月D日";

/** 表格等紧凑场景：`2026-09-27`（与 ISO 一致，便于排序与肉眼比对） */
export const DATE_COMPACT_PATTERN = "YYYY-MM-DD";

/** 期限倒计时文案（修订稿 §12.2：刚性期限不容时区偏差，计算走 UTC，展示走业务时区） */
export const DEADLINE_COUNTDOWN_PATTERN = "YYYY年M月D日 HH:mm";

/**
 * ⚠ 这里**不提供**星期 pattern。
 * 实测 dayjs 核心不认 `EEE`（要 weekday 得装 AdvancedFormat 插件），
 * `format("EEE")` 会原样吐出字符串 `"EEE"`——留着就是一颗"看着能用其实输出乱码"的雷。
 * 星期文案交给 antd 的 Calendar / DatePicker 自己渲染（它们内部已经处理）。
 */
