/**
 * schema 真相的唯一入口（技术选型 §3.2b）。
 *
 * `drizzle.config.ts` 只指这一个文件 ⇒ **新增表必须从这里 re-export**，
 * 否则 `generate` 看不见它，会出现"代码里有表、库里没有"的静默漂移。
 * 反向也有兜底：`enum-check.spec.ts` 会把迁移里的值域约束逐条认领，`db:check` 会比对库与 journal。
 */
export * from "./status-config";
export * from "./identity";
export * from "./config";
export * from "./hosts";
export * from "./collab";
