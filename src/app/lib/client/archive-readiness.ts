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

/** 点这一项该去哪一页签补录（AC：点击跳到对应页签）
 *
 * ⚠ `judgment` 是 `null`：附件页签**不存在**（`mn_attachment` 一期未建），
 * 而"裁判文书已归档 · 暂不可判"这一项**点进去也无处补录**——跳到"参与人"页签是错的
 * （那里加不了附件）。所以它不挂跳转，等 MATT-15 打通附件、页签真出现时再补上。
 */
export const READINESS_TAB: Record<ReadinessKey, string | null> = {
  judgment: null,
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

/**
 * 「已判项齐备」的统一说法。
 *
 * ⚠ 不说"三项齐备"：附件那项没有数据源（`unavailable`），说了就是假齐备。
 * 详情卡与归档弹窗**共用这一句**——它们是同一个判定的两个显示面，
 * 各写一句就会出现"卡片说缺项、弹窗说齐备"（检查子代理抓到过这个矛盾）。
 */
export const READY_TEXT = "已判的两项齐备";
export const NOT_READY_TEXT = "已判的项里有缺口";

/** 缺项拼成一句人话（归档弹窗与详情卡共用，不各拼一遍） */
export function readinessMissingText(r: Readiness): string {
  if (r.missing.length === 0) return READY_TEXT;
  return r.missing.map((k) => READINESS_LABELS[k]).join("、");
}

/** 弹窗里那句"还缺：…"的前缀，与 `readinessMissingText` 配套 */
export const READINESS_MISSING_PREFIX = "还缺：";

/**
 * 未判项的说明（只对附件那一项有话说）。
 *
 * 键类型按 `reason` 的字面量联合收窄（不是 `Record<string, string>`）：
 * 拼错键名要在**编译期**红，而不是运行时渲染成空白——同一个文件对 `READINESS_LABELS`
 * 就是这么做的，这里不该例外。
 */
export const UNAVAILABLE_HINT: Record<NonNullable<ReadinessCheck["reason"]>, string> = {
  attachment_not_built: "附件功能尚未上线（存储服务未开通），这一项暂时无法判定",
};

/** 读不到就绪数据时的统一说法（`isError` 与 `readiness === null` 共用同一句） */
export const READINESS_UNREADABLE = "核对不了归档材料（这不影响归档，但缺项清单这次给不出来）";
