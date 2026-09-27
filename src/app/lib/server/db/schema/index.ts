/**
 * schema 真相的唯一入口（技术选型 §3.2b）。
 * `drizzle.config.ts` 只指这一个文件；新增表必须从这里 re-export，
 * 否则 `generate` 看不见它 —— 这类"文件写了但没挂进索引"的漂移，靠 §8 spike 抓到的
 * 那条一致性断言（库里有表不在 journal / journal 有表库里没有）兜。
 */
export { statusConfig } from "./status-config";
