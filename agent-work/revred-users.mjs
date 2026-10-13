/**
 * 反向红工具（MATT-10 用户管理）：拆掉两条关键守卫，确认对应断言会红。
 *
 * 用法：node agent-work/revred-users.mjs <owner-gate|owner-protect> [restore]
 *
 *  · `owner-gate`    —— 摘掉 `setUserCredential` 的 `isSystemOwner` 判定。
 *    期望红：`持 canManageUser 但非所有者 → 403 system_owner_required`。
 *    为什么必须红这条：F6-9 的全部安全性就在这一行。没有它，"有 canManageUser 就能设任何人的口令"
 *    ——那等于给每个系统管理员发了一把能冒充任何人的钥匙，而界面上看不出来。
 *  · `owner-protect` —— 摘掉"系统所有者不可被停用"。
 *    期望红：`停用系统所有者 → 403 system_owner_protected`。
 *    为什么必须红这条：这是 MATT-53 明确移交过来的守卫（当时 /api/users 还不存在，
 *    给不存在的路径写守卫是死代码）。停掉所有者 = 系统再也无法设置凭据 = 无法恢复。
 *
 *  · `handover-order` —— 把移交的两条 UPDATE 顺序写反（先授新、再清旧）。
 *    期望红：`受让人启用时可移交 → status=500`（partial unique index 当场拦住），
 *    以及**同一功能内的因果链**（移交没发生 ⇒ 后面 5 条移交断言跟着红）。
 *    这里的连带红是**正确信号**而不是噪声：移交坏了，移交这一节就该整片红。
 *    （对比 `owner-protect` 那次：那里的连带红跨到了凭据功能，所以把断言挪到了末尾。）
 *
 * ⚠ 还原后别立刻跑冒烟：`next dev` 热更新有窗口（revred-convert 那轮踩过）。
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

const F = "src/app/lib/server/services/users.ts";
const BAK = `${F}.revred.bak`;
const mode = process.argv[2];
const restore = process.argv[3] === "restore" || mode === "restore";

if (restore || mode === "restore") {
  if (!existsSync(BAK)) {
    console.error("没有备份可还原");
    process.exit(2);
  }
  writeFileSync(F, readFileSync(BAK, "utf8"), "utf8");
  unlinkSync(BAK);
  console.log("已还原");
  process.exit(0);
}

const NEEDLES = {
  "owner-gate": {
    needle: '  if (!actor.isSystemOwner) return { ok: false, why: "not_system_owner" };',
    replacement: "  // 反向红：摘掉「仅系统所有者可设凭据」",
    tag: "no-owner-gate",
  },
  "owner-protect": {
    needle: '    if (target.isSystemOwner) blockers.push("system_owner_protected");',
    replacement: "    // 反向红：摘掉「系统所有者不可被停用」",
    tag: "no-owner-protect",
  },
  /**
   * 移交的顺序写反（先授新、再清旧）。`uk_mn_app_user_owner` 是 partial unique index
   * （全局至多一行为 true），所以"同时为真"会撞索引 → 移交请求 500 → 断言红。
   *
   * 为什么必须验这一条：这条顺序是**不可见的正确性**——写反了在只有一个人持有标记时
   * 也"能用"（库里恰好没有第二个 true），只有在真交接时才炸。而真交接恰恰是
   * "系统已经出问题了、要换人恢复"的那一刻。
   */
  "handover-order": {
    needle: `    await tx
      .update(appUser)
      .set({ isSystemOwner: false, updatedBy: BigInt(actor.userId), updatedAt: now })
      .where(and(eq(appUser.isSystemOwner, true), eq(appUser.id, BigInt(actor.userId))));
    await tx
      .update(appUser)
      .set({ isSystemOwner: true, updatedBy: BigInt(actor.userId), updatedAt: now })
      .where(eq(appUser.id, BigInt(toUserId)));`,
    replacement: `    // 反向红：顺序写反（先授新、再清旧）—— partial unique index 会拦住
    await tx
      .update(appUser)
      .set({ isSystemOwner: true, updatedBy: BigInt(actor.userId), updatedAt: now })
      .where(eq(appUser.id, BigInt(toUserId)));
    await tx
      .update(appUser)
      .set({ isSystemOwner: false, updatedBy: BigInt(actor.userId), updatedAt: now })
      .where(and(eq(appUser.isSystemOwner, true), eq(appUser.id, BigInt(actor.userId))));`,
    tag: "handover-order",
  },
};

const spec = NEEDLES[mode];
if (!spec) {
  console.error("用法：node agent-work/revred-users.mjs <owner-gate|owner-protect> [restore]");
  process.exit(2);
}

const src = readFileSync(F, "utf8");
const hits = src.split(spec.needle).length - 1;
if (hits !== 1) {
  console.error(`锚点命中 ${hits} 次（要恰好 1 次）—— 拒绝注入，避免拆错地方`);
  process.exit(2);
}

writeFileSync(BAK, src, "utf8");
writeFileSync(F, src.replace(spec.needle, spec.replacement), "utf8");
console.log(`已注入缺陷 [${spec.tag}]，备份 ` + BAK);
