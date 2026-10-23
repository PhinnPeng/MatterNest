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
  openNodes: "无未决时间节点",
};

/** 点这一项该去哪一页签补录（AC：点击跳到对应页签）
 *
 * ⚠ `judgment` 是 `null`：附件页签**不存在**（`mn_attachment` 有了，但详情页还没有附件页签），
 * 而"裁判文书已归档 · 暂不可判"这一项**点进去也无处补录**——跳到"参与人"页签是错的
 * （那里加不了附件）。所以它不挂跳转，等附件页签真出现时再补上。
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

/**
 * 三种状态 → canon 药丸档（`.pill` 的修饰类，与 `StatusMark` / `DeadlineMark` 同一套记号）。
 *
 * ⚠ 灰不是"没检查"，是"没有数据源"——它不能画成绿（假齐备）也不能画成红（假缺项），
 * 所以 `unavailable` 走中性的 `.pill gray` 而不是借用缺口色。
 *
 * 2026-10-21 从 `STATE_COLOR`（antd `Tag` 的色名）换过来：详情页的「归档就绪」按原型
 * `matter-detail.html` 改成 `.tb` 表格后，状态格与全站其余状态读法统一成"点 + 词"，
 * 不再是一枚有底色的 Tag。键类型仍是 `Record<CheckState, string>`——服务端加一档而这里
 * 没跟上，是编译错。
 */
export const STATE_PILL: Record<CheckState, string> = {
  ok: "pill ok",
  missing: "pill over",
  unavailable: "pill gray",
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
  attachment_not_built: "附件已能上传，但还没有给附件分类的入口，这一项暂时无法判定",
};

/**
 * 「归档就绪」表格**说明列**的一句话（详情页 `.tb` 的第三列）。
 *
 * 三种来源，按"这条现在能不能动手、动了去哪"挑，不按状态硬编码文案：
 *   · 没有数据源 → 说清为什么判不了（这条是事实，不是旁白：它回答"这格为什么是灰的"）；
 *   · 有缺口 → 「还有 N 个未决节点」＋「点此去补录」，后者只在**真有页签可去**时出现；
 *   · 已具备 → `—`。**已具备的行绝不写"点此去补录"**——那是在叫用户做一件不需要做的事
 *     （2026-10-21 第一版就踩了：三行里两行"已具备"却都挂着补录引导）。
 */
export function readinessNote(c: ReadinessCheck, jump: string | null): string {
  if (c.reason) return UNAVAILABLE_HINT[c.reason];
  if (c.state === "missing") {
    const note = [c.count ? `还有 ${c.count} 个未决节点` : null, jump ? "点此去补录" : null]
      .filter(Boolean)
      .join(" · ");
    // 缺项但没有可去的页签：状态格已经说了"缺"，说明格不重复也不留空格子
    return note || "—";
  }
  return "—";
}

/** 读不到就绪数据时的统一说法（`isError` 与 `readiness === null` 共用同一句） */
export const READINESS_UNREADABLE = "核对不了归档材料（这不影响归档，但缺项清单这次给不出来）";
