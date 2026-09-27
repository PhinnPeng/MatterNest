import { zhCN } from "date-fns/locale";

/**
 * 全项目**唯一**的中文 locale 出口（禁令⑧：日期库全项目只允许一个）。
 *
 * 为什么放 `src/shared/`：`date-fns` 是纯 TS 库，不碰 `next/*`、`react`、Node API，
 * 所以这里符合禁令①；而日历展示与后端期限计算必须用同一份口径，不能客户端一份、服务端一份。
 *
 * N1 实测（`research-nextjs-stack.md` §6.4）：`zhCN` 下 `LLLL yyyy` → "九月 2026"、`EEE` → "周日"；
 * ⚠ 但 `P`（date-fns 的短日期预设）→ **"26-09-27"**，不是我们要的中文习惯，
 * 所以**展示一律用本文件的 `DATE_DISPLAY_PATTERN`，不要用预设 `P`**。
 */
export const APP_LOCALE = zhCN;

/** 列表/详情里的日期展示口径：`2026年9月27日` */
export const DATE_DISPLAY_PATTERN = "yyyy年M月d日";

/** 表格等紧凑场景：`2026-09-27`（与 ISO 一致，便于排序与肉眼比对） */
export const DATE_COMPACT_PATTERN = "yyyy-MM-dd";

/** 期限倒计时文案（修订稿 §12.2：刚性期限不容时区偏差，计算走 UTC，展示走业务时区） */
export const DEADLINE_COUNTDOWN_PATTERN = "yyyy年M月d日 HH:mm";
