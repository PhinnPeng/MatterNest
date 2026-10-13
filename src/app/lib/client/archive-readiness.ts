/**
 * 「归档就绪」的**展示层**（F2-26）。判定在服务端（`services/archive-readiness.ts`），
 * 这里只有三件事：把 key 翻成中文、把三种状态翻成颜色、把缺项拼成一句人话。
 *
 * ## 为什么中文名与状态色不放在服务层
 *
 * 服务层不认颜色、不认中文（那条纪律在 `format.ts` 与 `audit.ts` 上都有先例）。
 * 但**三个 key 的顺序与含义**必须与服务端同源——所以 `READINESS_LABELS` 的键集合
 * 由类型钉住（`Record<ReadinessKey, string>`）：服务端加一项而这里忘了翻，
 * 是**编译错**，不是界面上少一行。
 */

export type ReadinessKey = "judgment" | "closingDate" | "openNodes";
export type CheckState = "ok" | "missing" | "unavailable";

export type ReadinessCheck = {
  key: ReadinessKey;
  state: CheckState;
  reason?: "attachment_not_built";
  count?: number;
};

export type Readiness = {
  checks: ReadinessCheck[];
  missing: ReadinessKey[];
  unavailable: ReadinessKey[];
  ready: boolean;
};

export const READINESS_LABELS: Record<ReadinessKey, string> = {
  judgment: "裁判文书已归档",
  closingDate: "结案日期已填",
  openNodes: "无未决工作节点",
};

/** 点这一项该去哪一页签补录（AC：点击跳到对应页签） */
export const READINESS_TAB: Record<ReadinessKey, string> = {
  judgment: "people", // 附件一期未建；先落到"参与人"页签，等附件页签出现再改这里
  closingDate: "basic",
  openNodes: "nodes",
};

export const STATE_LABEL: Record<CheckState, string> = {
  ok: "已具备",
  missing: "缺",
  unavailable: "暂不可判",
};

export const STATE_COLOR: Record<CheckState, string> = {
  ok: "green",
  missing: "red",
  // 灰不是"没检查"，是"没有数据源"——它不能画成绿（假齐备）也不能画成红（假缺项）
  unavailable: "default",
};

/** 缺项拼成一句人话（归档弹窗与详情卡共用，不各拼一遍） */
export function readinessMissingText(r: Readiness): string {
  if (r.missing.length === 0) return "三项都齐备";
  return r.missing.map((k) => READINESS_LABELS[k]).join("、");
}

/** 未判项的说明（只对附件那一项有话说） */
export const UNAVAILABLE_HINT: Record<string, string> = {
  attachment_not_built: "附件功能尚未上线（存储服务未开通），这一项暂时无法判定",
};
