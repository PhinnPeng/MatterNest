import {
  createSmokeAccount,
  dropSmokeAccount,
  finishSmoke,
  noteCleanupFailure,
  ROLE_CODES,
} from "./_testacct.mjs";
/**
 * 账号与角色的真 HTTP 冒烟（MATT-10 / F6-1、F6-5、F6-9、F6-11）。
 *
 * 覆盖票面的四条硬约束，每条都配一条**能红**的断言：
 *  ① 禁自助提权：改自己的角色必须失败（403 self_escalation）。
 *  ② 不提供裸的用户列表：无 canManageUser 者拿 403；且响应里**没有口令摘要**。
 *  ③ 系统所有者不可被停用（MATT-53 移交过来的守卫），拒绝码可区分。
 *  ④ F6-9 本地凭据：**只有系统所有者能设**；设完之后那个账号**真能登录**
 *     ——这是本票的核心价值（系统此前没有任何人能登录），
 *     只断言"返回 200"是不够的：口令写错了照样 200，只有登录能证。
 *
 * 另：启停要吊销会话、待开通批准要同时落角色（否则"能登录却什么都看不到"）。
 */
const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";

let pass = 0;
let fail = 0;
function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`[ ok ] ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function call(method, path, cookie, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(payload ? { "content-type": "application/json" } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** 登录并拿 cookie（独立于 call：它不共用调用者的 cookie） */
async function login(username, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return { status: r.status, cookie };
}

const stamp = Date.now();
const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

// 系统所有者（admin 是唯一持有者）+ 一个有 canManageUser 但**不是**所有者的账号
const owner = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin, ROLE_CODES.sysAdmin] });
await sql`update mn_app_user set is_system_owner = false where id = ${owner.id}`;
const mgr = await createSmokeAccount(sql, { roles: [ROLE_CODES.sysAdmin] });
const plain = await createSmokeAccount(sql, { roles: [ROLE_CODES.joined] });
// 被管理对象：一个待开通的账号（F6-11 的队列来源）
const pendingName = `mn_smoke_pending_${stamp}`;
const [pendingUser] = await sql`
  insert into mn_app_user (id, username, display_name, is_enabled, is_admin, activation_status, created_at, updated_at)
  values (${BigInt(Date.now() * 1000)}, ${pendingName}, ${`待开通冒烟 ${stamp}`}, true, false, 'pending', now(), now())
  returning id`;
const pendingId = String(pendingUser.id);

/** 让 owner 成为系统所有者（全局唯一由 partial unique index 兜底，先清干净） */
await sql`update mn_app_user set is_system_owner = false where is_system_owner and id <> ${owner.id}`;
await sql`update mn_app_user set is_system_owner = true where id = ${owner.id}`;

async function cleanup() {
  await sql`delete from mn_activity_log where target_type='app_user' and target_id in (${pendingUser.id}, ${owner.id}, ${mgr.id}, ${plain.id})`;
  await sql`delete from mn_activity_log where operator_id in (${owner.id}, ${mgr.id}, ${plain.id})`;
  await sql`delete from mn_auth_session where user_id in (${owner.id}, ${mgr.id}, ${plain.id}, ${pendingUser.id})`;
  await sql`delete from mn_app_user_role where user_id in (${owner.id}, ${mgr.id}, ${plain.id}, ${pendingUser.id})`;
  await sql`delete from mn_app_user where id = ${pendingUser.id}`;
  // 恢复真正的所有者标记：admin。
  // ⚠ 顺序不能反：partial unique index 保证全局至多一行为 true，所以必须**先清掉
  //   冒烟账号的标记**再给 admin——反过来会撞 uk_mn_app_user_owner（本轮真踩到，
  //   表现为"清场失败"而不是断言失败，很容易被当成无关噪音）。
  await sql`update mn_app_user set is_system_owner = false where username like 'mn_smoke_%'`;
  await sql`update mn_app_user set is_system_owner = true where username = 'admin'`;
  for (const u of [owner, mgr, plain]) {
    try {
      await dropSmokeAccount(sql, u.id);
    } catch (e) {
      noteCleanupFailure(`临时账号 ${u.username}（${u.id}）`, e);
    }
  }
}

try {
  const ownerSession = await login(owner.username, owner.password);
  const mgrSession = await login(mgr.username, mgr.password);
  const plainSession = await login(plain.username, plain.password);
  ok("三个夹具账号都能登录", ownerSession.status === 200 && mgrSession.status === 200 && plainSession.status === 200, "");

  // ---- ① 会话 DTO 暴露 isSystemOwner（界面据它决定要不要显示凭据入口）----
  const sess = await call("GET", "/api/session", ownerSession.cookie);
  ok("会话 DTO 带 isSystemOwner=true（本账号是所有者）", sess.body?.isSystemOwner === true, `值=${sess.body?.isSystemOwner}`);
  const sessMgr = await call("GET", "/api/session", mgrSession.cookie);
  ok("非所有者的 isSystemOwner=false", sessMgr.body?.isSystemOwner === false, `值=${sessMgr.body?.isSystemOwner}`);

  // ---- ② 裸用户列表：无 canManageUser 者拿 403 ----
  const denied = await call("GET", "/api/users", plainSession.cookie);
  ok("无 canManageUser → 403（不提供裸用户列表）", denied.status === 403, `status=${denied.status}`);
  ok("拒绝码是 privilege_required", denied.body?.error === "privilege_required", String(denied.body?.error));

  const list = await call("GET", "/api/users", mgrSession.cookie);
  ok("持 canManageUser → 200 且带账号与角色字典", list.status === 200 && Array.isArray(list.body?.users) && Array.isArray(list.body?.roles), `users=${list.body?.users?.length} roles=${list.body?.roles?.length}`);
  const meRow = (list.body?.users ?? []).find((u) => u.username === owner.username);
  ok("列表里**没有口令摘要字段**（只给 hasCredential 布尔）", meRow !== undefined && !("passwordHash" in meRow) && typeof meRow.hasCredential === "boolean", `keys=${Object.keys(meRow ?? {}).join(",")}`);

  // ---- ③ 禁自助提权 ----
  const selfEsc = await call("POST", `/api/users/${owner.id}/roles`, ownerSession.cookie, {
    roleIds: [String((list.body?.roles ?? []).find((r) => r.code === ROLE_CODES.joined)?.id)],
  });
  ok("**改自己的角色 → 403 self_escalation**", selfEsc.status === 403 && selfEsc.body?.error === "self_escalation", `status=${selfEsc.status} err=${selfEsc.body?.error}`);

  // 改别人的角色：成功 + 审计带 old/new
  const joinedRoleId = String((list.body?.roles ?? []).find((r) => r.code === ROLE_CODES.joined)?.id);
  const setRoles = await call("POST", `/api/users/${plain.id}/roles`, mgrSession.cookie, { roleIds: [joinedRoleId] });
  ok("改别人的角色 → 200", setRoles.status === 200, `status=${setRoles.status} ${JSON.stringify(setRoles.body)?.slice(0, 60)}`);
  const [roleAudit] = await sql`
    select payload from mn_activity_log
    where action='ROLE_CHANGED' and target_type='app_user' and target_id=${plain.id} order by created_at desc limit 1`;
  ok("写了 ROLE_CHANGED 审计且带 old/new", Boolean(roleAudit?.payload?.old) && Boolean(roleAudit?.payload?.new), JSON.stringify(roleAudit?.payload)?.slice(0, 90));

  const badRole = await call("POST", `/api/users/${plain.id}/roles`, mgrSession.cookie, { roleIds: ["999999"] });
  ok("给不存在的角色 → 422 role_not_found", badRole.status === 422 && badRole.body?.error === "role_not_found", `status=${badRole.status}`);

  // ---- ④ 启停：不能停自己（"所有者不可停用"那条放最后，见文件末尾的注释）----
  const stopSelf = await call("PATCH", `/api/users/${mgr.id}`, mgrSession.cookie, { enabled: false });
  ok("**停用自己 → 403 self_disable**", stopSelf.status === 403 && stopSelf.body?.error === "self_disable", `status=${stopSelf.status} err=${stopSelf.body?.error}`);

  const disablePlain = await call("PATCH", `/api/users/${plain.id}`, mgrSession.cookie, { enabled: false });
  ok("停用他人 → 200", disablePlain.status === 200, `status=${disablePlain.status}`);
  const [statusAudit] = await sql`
    select payload from mn_activity_log
    where action='USER_STATUS_CHANGED' and target_id=${plain.id} order by created_at desc limit 1`;
  ok("写了 USER_STATUS_CHANGED 审计且带 from/to", statusAudit?.payload?.is_enabled?.from === true && statusAudit?.payload?.is_enabled?.to === false, JSON.stringify(statusAudit?.payload));
  const [sessLeft] = await sql`select count(*)::int n from mn_auth_session where user_id=${plain.id}`;
  ok("**停用同时吊销该账号全部会话**", sessLeft.n === 0, `剩余会话=${sessLeft.n}`);
  const afterDisable = await call("GET", "/api/session", plainSession.cookie);
  ok("被停用者的旧 cookie 立刻失效（401）", afterDisable.status === 401, `status=${afterDisable.status}`);

  const enablePlain = await call("PATCH", `/api/users/${plain.id}`, mgrSession.cookie, { enabled: true });
  ok("重新启用 → 200", enablePlain.status === 200, `status=${enablePlain.status}`);

  // ---- ⑤ F6-9 本地凭据：只有系统所有者能设 ----
  const newPw = `Pw-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
  const byMgr = await call("POST", `/api/users/${plain.id}/credential`, mgrSession.cookie, { password: newPw });
  ok("**持 canManageUser 但非所有者 → 403 system_owner_required**", byMgr.status === 403 && byMgr.body?.error === "system_owner_required", `status=${byMgr.status} err=${byMgr.body?.error}`);

  const tooShort = await call("POST", `/api/users/${plain.id}/credential`, ownerSession.cookie, { password: "1234567" });
  ok("7 位口令 → 400（schema 层拦）", tooShort.status === 400, `status=${tooShort.status}`);

  const setPw = await call("POST", `/api/users/${plain.id}/credential`, ownerSession.cookie, { password: newPw });
  ok("系统所有者设口令 → 200", setPw.status === 200, `status=${setPw.status}`);
  const [credAudit] = await sql`
    select payload from mn_activity_log
    where action='CREDENTIAL_CHANGED' and target_id=${plain.id} order by created_at desc limit 1`;
  const credPayload = JSON.stringify(credAudit?.payload ?? {});
  ok("写了 CREDENTIAL_CHANGED 审计", Boolean(credAudit), credPayload);
  ok("**审计里不含口令或摘要**", !credPayload.includes(newPw) && !credPayload.includes("password"), credPayload);

  // 核心断言：设完之后**真能登录**
  const relogin = await login(plain.username, newPw);
  ok("**用新设的口令真能登录**（F6-9 的验收本质）", relogin.status === 200, `status=${relogin.status}`);

  // ---- ⑥ 待开通队列（F6-11）----
  const pendList = await call("GET", "/api/users/pending", mgrSession.cookie);
  ok("待开通队列里能看到 pending 账号", (pendList.body?.users ?? []).some((u) => u.id === pendingId), `n=${pendList.body?.users?.length}`);
  const emptyApprove = await call("POST", `/api/users/${pendingId}/approve`, mgrSession.cookie, { roleIds: [] });
  ok("批准但一个角色都不给 → 400（schema min 1）", emptyApprove.status === 400, `status=${emptyApprove.status}`);
  const approve = await call("POST", `/api/users/${pendingId}/approve`, mgrSession.cookie, { roleIds: [joinedRoleId] });
  ok("批准并当场指定角色 → 200", approve.status === 200, `status=${approve.status} ${JSON.stringify(approve.body)?.slice(0, 60)}`);
  const [afterApprove] = await sql`select activation_status, is_enabled from mn_app_user where id=${pendingUser.id}`;
  ok("批准后 activation_status=active", afterApprove.activation_status === "active", `值=${afterApprove.activation_status}`);
  const [pendRoles] = await sql`select count(*)::int n from mn_app_user_role where user_id=${pendingUser.id}`;
  ok("**批准同时落了角色**（否则能登录却什么都看不到）", pendRoles.n === 1, `角色行=${pendRoles.n}`);
  const [actAudit] = await sql`
    select payload from mn_activity_log where action='USER_ACTIVATED' and target_id=${pendingUser.id} limit 1`;
  ok("写了 USER_ACTIVATED 审计", Boolean(actAudit), JSON.stringify(actAudit?.payload)?.slice(0, 80));

  // ---- ⑦ 系统所有者不可被停用（MATT-53 移交的守卫）----
  //
  // ⚠ **故意放在最后**：这条一旦被拆掉（反向红会这么干），所有者就真被停用、
  //    而停用会吊销他的全部会话 ⇒ 后面所有用 ownerSession 的断言都会连带 401。
  //    放中间的话反向红会红 4 条（1 条目标 + 3 条因果），信号就不精确了。
  //    放最后则只红这一条——"红的是断言、且是那一条"才是有效证据。
  const stopOwner = await call("PATCH", `/api/users/${owner.id}`, mgrSession.cookie, { enabled: false });
  ok(
    "**停用系统所有者 → 403 system_owner_protected**",
    stopOwner.status === 403 && stopOwner.body?.error === "system_owner_protected",
    `status=${stopOwner.status} err=${stopOwner.body?.error}`,
  );

  // ---- ⑧ 移交系统所有者（MATT-53 的「移交是唯一出路」）----
  //
  // 这一节必须放在**所有依赖 ownerSession 的断言之后**：移交成功后 owner 不再是所有者，
  // 它的凭据权限随之消失（后面的断言会因此变红，那是因果不是缺陷）。
  const byMgr2 = await call("POST", `/api/users/${mgr.id}/system-owner`, mgrSession.cookie);
  ok(
    "**非所有者发起移交 → 403 system_owner_required**",
    byMgr2.status === 403 && byMgr2.body?.error === "system_owner_required",
    `status=${byMgr2.status} err=${byMgr2.body?.error}`,
  );

  // 受让人必须是"登得进来的人"：停用的账号不能拿生命线
  const toDisabled = await call("POST", `/api/users/${plain.id}/system-owner`, ownerSession.cookie);
  // plain 此时是启用的（前面重新启用过）→ 应当成功；先把它停掉再试一次更准确
  ok("受让人启用时可移交（前置：先确认它能被移交）", toDisabled.status === 200, `status=${toDisabled.status}`);
  // 把所有者标记先移回来，再测"受让人被停用"这条
  await sql`update mn_app_user set is_system_owner = false where id = ${plain.id}`;
  await sql`update mn_app_user set is_system_owner = true where id = ${owner.id}`;
  // 这一发只为把 plain 停掉，好让下一发能验 target_disabled；
  // 它有没有真停掉，由下面那条「受让人被停用 → 422」说了算（停不掉就是 200，那条会红）。
  await call("PATCH", `/api/users/${plain.id}`, mgrSession.cookie, { enabled: false }); // discard: 停用是否生效由下一条 422 target_disabled 断言
  const toDisabled2 = await call("POST", `/api/users/${plain.id}/system-owner`, ownerSession.cookie);
  ok(
    "**受让人被停用 → 422 target_disabled**（不能把生命线交给登不进来的人）",
    toDisabled2.status === 422 && toDisabled2.body?.error === "target_disabled",
    `status=${toDisabled2.status} err=${toDisabled2.body?.error}`,
  );
  // 重新启用 plain 走的是**同一发 PATCH 的反向**，但它没有下游断言兜着：往后
  // 移交的目标是 mgr，没人再看 plain 的 enabled —— 静默失败就等于给库里留一个
  // 停用账号（与本脚本开头「停用会吊销会话 ⇒ 后面全 401」的顾虑同源），所以自己钉。
  const reEnable = await call("PATCH", `/api/users/${plain.id}`, mgrSession.cookie, { enabled: true });
  ok("把 plain 重新启用 → 200（不留停用账号给后面的用例）", reEnable.status === 200, `status=${reEnable.status}`);

  // 正式移交：owner → mgr
  const handover = await call("POST", `/api/users/${mgr.id}/system-owner`, ownerSession.cookie);
  ok("所有者移交 → 200", handover.status === 200, `status=${handover.status}`);
  const owners = await sql`
    select username from mn_app_user where is_system_owner order by username`;
  ok(
    "**全局仍然只有一人持有**（partial unique index 的口径）",
    owners.length === 1 && owners[0].username === mgr.username,
    `持有者=${owners.map((o) => o.username).join(",")}`,
  );
  const [handoverAudit] = await sql`
    select payload, target_type, action from mn_activity_log
    where action='ROLE_CHANGED' and target_id=${mgr.id} and payload ? 'new'
      and payload->'new' ? 'system_owner_user_id'
    order by created_at desc limit 1`;
  ok(
    "**移交落审计**（target_type=app_user · action=ROLE_CHANGED · 带 old/new）",
    handoverAudit?.target_type === "app_user" &&
      handoverAudit?.payload?.old?.system_owner_user_id === owner.id &&
      handoverAudit?.payload?.new?.system_owner_user_id === mgr.id,
    JSON.stringify(handoverAudit?.payload),
  );

  // 权力真的走了：原所有者不能再移交，新所有者可以
  const oldOwnerAgain = await call("POST", `/api/users/${owner.id}/system-owner`, ownerSession.cookie);
  ok(
    "**移交后原所有者失去移交权 → 403**（权力真的转移了，不是复制了一份）",
    oldOwnerAgain.status === 403 && oldOwnerAgain.body?.error === "system_owner_required",
    `status=${oldOwnerAgain.status}`,
  );
  const newOwnerBack = await call("POST", `/api/users/${owner.id}/system-owner`, mgrSession.cookie);
  ok("新所有者可以把所有权移交回去 → 200", newOwnerBack.status === 200, `status=${newOwnerBack.status}`);
} catch (e) {
  fail++;
  console.log(`[FAIL] 脚本中断 —— ${e?.stack ?? e}`);
} finally {
  try {
    await cleanup();
    console.log("[clean] 清场完成");
  } catch (e) {
    noteCleanupFailure("夹具清场", e);
  }
  await sql.end();
}

console.log(`\n${fail ? "FAIL" : "PASS"}：${pass} 通过 / ${fail} 失败`);
finishSmoke(fail);
