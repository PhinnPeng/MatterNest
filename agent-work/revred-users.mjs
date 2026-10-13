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
