import { eq } from "drizzle-orm";
import { loginSchema } from "@/shared/schema/hosts";
import { getDb } from "@/app/lib/server/db/client";
import { appUser } from "@/app/lib/server/db/schema";
import { createSession, setSessionCookie, verifyPassword } from "@/app/lib/server/auth/auth";
import { body, fail, json } from "@/app/lib/server/http";

/**
 * 本地密码通道（技术选型 §3.4 的兜底路径；云之家通道属 N6，未验，故不接）。
 *
 * 三种失败给**同一个** 401 文案：账号不存在、口令错、未开通/已停用都不许区分 ——
 * 否则这个端点就是"哪些账号存在"的字典。案号本身可枚举（AJ-YYYYMMDD-XXX 三位序号），
 * 所以这套"不泄露存在性"的口径在业务读接口上也是同样的 404 逻辑（§1 元规则 3）。
 */
export async function POST(req: Request) {
  const parsed = await body(req, loginSchema);
  if (!parsed.ok) return parsed.res;
  const { username, password } = parsed.data;

  const db = await getDb();
  const [row] = await db
    .select({
      id: appUser.id,
      displayName: appUser.displayName,
      hash: appUser.passwordHash,
      isEnabled: appUser.isEnabled,
      activationStatus: appUser.activationStatus,
    })
    .from(appUser)
    .where(eq(appUser.username, username))
    .limit(1);

  const same = "账号或口令不正确";
  if (!row || !verifyPassword(password, username, row.hash))
    return fail(401, "bad_credentials", same);
  /**
   * 未开通/已停用**也走同一句**，不用 `unauthorized()`：
   * 后者的文案是"会话已失效或未登录"，那是给 `/api/session` 用的；在登录端点上用它
   * 等于把"这个账号存在但没开通"单独标出来 —— 本文件上面那条口径就白写了。
   * 本轮冒烟正是拿这条断言发现的：代码此前返回 `unauthorized()`，与注释互相矛盾。
   */
  if (!row.isEnabled || row.activationStatus !== "active")
    return fail(401, "bad_credentials", same);

  const { token, expiresAt } = await createSession(String(row.id));
  await setSessionCookie(token, expiresAt);
  await db
    .update(appUser)
    .set({ lastLoginAt: new Date().toISOString() })
    .where(eq(appUser.id, row.id));
  return json({ userId: String(row.id), displayName: row.displayName });
}
