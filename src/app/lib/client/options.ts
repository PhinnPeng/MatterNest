/**
 * 下拉的"全部/未选"哨兵。
 *
 * 为什么不用空串：radix 的 `Select` 明确保留 `value=""` 给"未选"语义，
 * 传空串当选项会在每次渲染时告警，而且 `onValueChange("")` 与"用户清了选择"分不开。
 * 所以下拉一律用这个串表示"全部"，**出网前再转回 undefined**（见各 view 的 onStatus）。
 */
export const ALL = "__all__";

/** 表单里"未选"的同一个角色（与 `components/form/fields.tsx` 的 UNSET 同义，共用一个字面量避免两串） */
export { UNSET } from "@/app/components/form/fields";
