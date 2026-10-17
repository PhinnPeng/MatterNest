import { createSmokeAccount, dropSmokeAccount, finishSmoke, noteCleanupFailure, ROLE_CODES } from "./_testacct.mjs";

/**
 * 收藏 ⭐（MATT-63 / F1-13）的端点级冒烟 —— 只走 HTTP + 查库复核。
 *
 * 票面点名的两条"真 HTTP 断言"：
 *   · 收藏后**库里真有一行**且**重启会话后仍在**（不是只断言接口 200）；
 *   · 移除关注人后他那行 `follow` **真的没了**。
 *
 * 外加三条结构性断言（这三条是本票真正的风险面）：
 *   · **⭐ 不进「n 人关注」名单**（收藏是私人的，ADR-0003 把两者分开）；
 *   · **不可见的记录不能被收藏**（范围谓词唯一出口）；
 *   · **反向那一半**：不加关注人就不得有 `follow` 行（两份真相的防线）。
 *
 * 2026-10-17 复审补的一组（当时这几条**在反向红里看不见**，所以整批绿却是假绿）：
 *   · **创建期**关注人（`followerIds`）也要写 `follow` 行，两个宿主各一条 ——
 *     初版只给 `addMatterStaff`/`addRiskFollowers` 补了同步，创建路径漏了；
 *   · 非数字 id 的码必须是 `bad_id`（即真的走了 `pathId()`），
 *     以及 `undefined` 当 id 给 400 而不是 500。
 *
 * 三个账号的真实对撞（照 smoke-followers 的形状）：
 *   smoke  = full_admin + is_admin（L1，看全部）
 *   smoke2 = joined（L2，能被 L1 加为关注人）
 *   smoke3 = self（L3，看不见 smoke 建的那条 → 收藏它必被拒）
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

async function login(username, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, cookie };
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

const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

const stamp = Date.now();
const ids = { matter: [], risk: [] };

const smoke = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
const smoke2 = await createSmokeAccount(sql, { roles: [ROLE_CODES.joined] });
const smoke3 = await createSmokeAccount(sql, { roles: [ROLE_CODES.self] });

const watchRows = async (userId, targetType, targetId) =>
  await sql`select watch_type from mn_user_watch
            where user_id = ${String(userId)}
              and target_type = ${targetType}
              and target_id = ${String(targetId)}`;

async function cleanup() {
  try {
    const rids = ids.risk.map(BigInt);
    const mids = ids.matter.map(BigInt);
    await sql`delete from mn_user_watch
              where target_id = any(${sql.array([...ids.risk, ...ids.matter])}::bigint[])
                and target_type in ('risk_matter','matter')`;
    await sql`delete from mn_user_watch where user_id in (${String(smoke.id)}, ${String(smoke2.id)}, ${String(smoke3.id)})`;
    if (rids.length) {
      await sql`delete from mn_comment where target_type = 'risk_matter' and target_id = any(${sql.array(rids)}::bigint[])`;
      await sql`delete from mn_activity_log where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
      await sql`delete from mn_risk_matter_staff where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
      await sql`delete from mn_risk_matter_node where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
      await sql`delete from mn_risk_matter where id = any(${sql.array(rids)}::bigint[])`;
    }
    if (mids.length) {
      // ⚠ 子表必须先删：`mn_matter_node` 等对 `mn_matter` 是 RESTRICT 外键，
      //   首轮漏了这一步，清场当场红（而这正是 `noteCleanupFailure` 要抓的形态）。
      await sql`delete from mn_comment where target_type = 'matter' and target_id = any(${sql.array(mids)}::bigint[])`;
      await sql`delete from mn_activity_log where matter_id = any(${sql.array(mids)}::bigint[])`;
      await sql`delete from mn_matter_staff where matter_id = any(${sql.array(mids)}::bigint[])`;
      await sql`delete from mn_matter_node where matter_id = any(${sql.array(mids)}::bigint[])`;
      await sql`delete from mn_matter_party where matter_id = any(${sql.array(mids)}::bigint[])`;
      await sql`delete from mn_matter where id = any(${sql.array(mids)}::bigint[])`;
    }
  } catch (e) {
    noteCleanupFailure("matt63 收藏冒烟", e);
  }
}

try {
  const l1 = await login(smoke.username, smoke.password);
  ok("L1 登录", l1.status === 200, `status=${l1.status}`);
  const cookie = l1.cookie;
  const l3 = await login(smoke3.username, smoke3.password);
  ok("L3 登录（看不见目标记录）", l3.status === 200, `status=${l3.status}`);

  // ── 夹具：L1 建一条事项 ──
  const created = await call("POST", "/api/risk-matters", cookie, {
    name: `收藏冒烟 ${stamp}`,
    type: "contract",
    level: "high",
    description: "冒烟：⭐ 收藏",
  });
  ok("建事项 → 201", created.status === 201, `status=${created.status}`);
  const riskId = created.body?.id;
  ids.risk.push(riskId);

  // ── 断言①：⭐ 收藏 → 库里真有一行 ──
  const fav = await call("PUT", `/api/watch/risk_matter/${riskId}`, cookie, { watching: true });
  ok("加 ⭐ → 200 watching=true", fav.status === 200 && fav.body?.watching === true, `status=${fav.status} ${JSON.stringify(fav.body)?.slice(0, 60)}`);
  const rows1 = await watchRows(smoke.id, "risk_matter", riskId);
  ok("**库里真有一行 favorite**（不是只看接口 200）", rows1.length === 1 && rows1[0].watch_type === "favorite", `n=${rows1.length}`);

  // ── 断言②：重启会话后仍在（重新登录拿新 cookie，再读详情）──
  const relogin = await login(smoke.username, smoke.password);
  const detail = await call("GET", `/api/risk-matters/${riskId}`, relogin.cookie);
  ok("**重启会话后仍在**（新 cookie 读详情 favorited=true）", detail.status === 200 && detail.body?.favorited === true, `favorited=${detail.body?.favorited}`);

  // ── 断言③：⭐ 不进「n 人关注」名单（收藏是私人的）──
  const staffList = await call("GET", `/api/risk-matters/${riskId}/staff/followers`, cookie);
  ok("**⭐ 不进关注人名单**（收藏与关注是两件事）", staffList.status === 200 && !staffList.body.some((f) => f.userId === String(smoke.id)), `名单长度=${staffList.body?.length}`);
  const followAfterFav = await watchRows(smoke.id, "risk_matter", riskId);
  ok("⭐ 不存在同行的 follow（只写 favorite 一条）", followAfterFav.filter((r) => r.watch_type === "follow").length === 0, `行数=${followAfterFav.length}`);

  // ── 幂等：重复点 ⭐ 不得 500、不得写第二行 ──
  const favDup = await call("PUT", `/api/watch/risk_matter/${riskId}`, cookie, { watching: true });
  const rows2 = await watchRows(smoke.id, "risk_matter", riskId);
  ok("重复点 ⭐ → 200 且**不写第二行**", favDup.status === 200 && rows2.length === 1, `status=${favDup.status} n=${rows2.length}`);

  // ── 断言④：不可见的记录不能被收藏 ──
  const invisible = await call("PUT", `/api/watch/risk_matter/${riskId}`, l3.cookie, { watching: true });
  ok("**看不见的记录收藏 → 404**（范围谓词门）", invisible.status === 404, `status=${invisible.status}`);
  const l3rows = await watchRows(smoke3.id, "risk_matter", riskId);
  ok("被拒后没有偷偷写行", l3rows.length === 0, `n=${l3rows.length}`);

  // ── 断言⑤：follow 同步（加关注人 ⇒ 写 follow 行）──
  const follow1 = await call("POST", `/api/risk-matters/${riskId}/staff/followers`, cookie, {
    userIds: [String(smoke2.id)],
  });
  ok("加他人为关注人 → 200", follow1.status === 200, `status=${follow1.status}`);
  const f2rows = await watchRows(smoke2.id, "risk_matter", riskId);
  ok("**同步写了 follow 行**（ADR-0003）", f2rows.length === 1 && f2rows[0].watch_type === "follow", `n=${f2rows.length} type=${f2rows[0]?.watch_type}`);

  // ── 反向那一半：不加关注人就不得有 follow 行 ──
  // smoke3 从头到尾没被加进名单 ⇒ 它必须一行 follow 都没有
  const l3follow = await watchRows(smoke3.id, "risk_matter", riskId);
  ok("**不加关注人就不得有 follow 行**（反向那一半）", l3follow.length === 0, `n=${l3follow.length}`);

  // ── 断言⑥：移除关注人 ⇒ 他那行 follow 真的没了 ──
  const unfollow = await call(
    "DELETE",
    `/api/risk-matters/${riskId}/staff/followers/${smoke2.id}`,
    cookie,
  );
  ok("移除关注人 → 200", unfollow.status === 200, `status=${unfollow.status}`);
  const f2after = await watchRows(smoke2.id, "risk_matter", riskId);
  ok("**他那行 follow 真的没了**（连带删，ADR-0003）", f2after.length === 0, `n=${f2after.length}`);

  // ── 取关 ⭐（本人操作，硬删）──
  const unfav = await call("DELETE", `/api/watch/risk_matter/${riskId}`, cookie);
  ok("取消 ⭐ → 200 watching=false", unfav.status === 200 && unfav.body?.watching === false, `status=${unfav.status}`);
  const rows3 = await watchRows(smoke.id, "risk_matter", riskId);
  ok("取关后行真的没了（硬删，不带 is_deleted）", rows3.length === 0, `n=${rows3.length}`);
  // 硬删的**理由**在这里证：取关后重新点 ⭐ 不得违反唯一键
  const reFav = await call("PUT", `/api/watch/risk_matter/${riskId}`, cookie, { watching: true });
  ok("取关后重新点 ⭐ → 200（若软删会撞唯一键）", reFav.status === 200, `status=${reFav.status}`);

  // ── 「我收藏的」查询面 ──
  const mine = await call("GET", "/api/watch", cookie);
  ok("我收藏的 → 200 且含这条", mine.status === 200 && (mine.body?.favorites ?? []).some((f) => f.targetId === riskId), `n=${mine.body?.favorites?.length}`);
  // L3 的「我收藏的」里不得出现这条（权限问题，不是过滤问题）
  const l3mine = await call("GET", "/api/watch", l3.cookie);
  ok("**不可见的记录不出现在「我收藏的」里**", l3mine.status === 200 && !(l3mine.body?.favorites ?? []).some((f) => f.targetId === riskId), `n=${l3mine.body?.favorites?.length}`);

  // ── 断言⑦：**创建期**关注人也写 follow 行（MATT-63 补漏，2026-10-17）──
  //
  // 票面写「加关注人时同步写 `user_watch(watch_type='follow')`」，而 ADR-0003 把
  // `*_staff.follower` 与 `user_watch(follow)` 定义为**同一张表的两面**。
  // 初版只给 `addMatterStaff`/`addRiskFollowers` 补了同步，**创建路径漏了** ——
  // IQ-5/IQ-14 允许建案/建事项时直接填关注人，那条路只写了名单、没写关注行。
  // 本组冒烟当时只打 `POST /staff/followers`，所以整批断言全绿也照不出这个洞。
  const createWithFollowers = await call("POST", "/api/risk-matters", cookie, {
    name: `收藏冒烟-创建期关注人 ${stamp}`,
    type: "contract",
    level: "high",
    description: "冒烟：创建期 followerIds ⇒ follow 行",
    followerIds: [String(smoke2.id), String(smoke3.id)],
  });
  ok("创建期带 followerIds 建事项 → 201", createWithFollowers.status === 201, `status=${createWithFollowers.status}`);
  const crId = createWithFollowers.body?.id;
  if (crId) ids.risk.push(crId);
  const crStaff = await call("GET", `/api/risk-matters/${crId}/staff/followers`, cookie);
  ok(
    "创建期关注人进了名单（前提，否则下一条不成立）",
    crStaff.status === 200 && crStaff.body?.length === 2,
    `名单=${crStaff.body?.length}`,
  );
  const crF2 = await watchRows(smoke2.id, "risk_matter", crId);
  const crF3 = await watchRows(smoke3.id, "risk_matter", crId);
  ok(
    "**创建期关注人同步写了 follow 行**（ADR-0003 的两面）",
    crF2.length === 1 &&
      crF2[0].watch_type === "follow" &&
      crF3.length === 1 &&
      crF3[0].watch_type === "follow",
    `smoke2=${crF2.length}/${crF2[0]?.watch_type} smoke3=${crF3.length}/${crF3[0]?.watch_type}`,
  );

  // ── 案件侧同形（宿主是 matter 时也走同一套）──
  // 顺手带上 `followerIds`：创建期同步在**两个宿主各有一份实现**（matters.ts / risks.ts），
  // 上面验了事项侧，这里验案件侧 —— 只修一侧、另一侧静默漏掉，正是这一族的失败形态。
  const mc = await call("POST", "/api/matters", cookie, {
    name: `收藏冒烟案件 ${stamp}`,
    cause: "买卖合同纠纷",
    caseType: "civil_commercial",
    procedure: "first_instance",
    litigationRole: "plaintiff",
    level: "high",
    ownerId: String(smoke.id),
    followerIds: [String(smoke2.id)],
  });
  if (mc.status === 201) {
    const matterId = mc.body?.id;
    ids.matter.push(matterId);
    const mfav = await call("PUT", `/api/watch/matter/${matterId}`, cookie, { watching: true });
    const mrows = await watchRows(smoke.id, "matter", matterId);
    ok("案件侧加 ⭐ 同形成功", mfav.status === 200 && mrows.length === 1, `status=${mfav.status} n=${mrows.length}`);
    const mfollow = await watchRows(smoke2.id, "matter", matterId);
    ok(
      "**案件侧创建期关注人同步写了 follow 行**（同形的那一份）",
      mfollow.length === 1 && mfollow[0].watch_type === "follow",
      `n=${mfollow.length} type=${mfollow[0]?.watch_type}`,
    );
  } else {
    ok("案件侧夹具建成（否则案件侧断言不成立）", false, `status=${mc.status}`);
  }

  // ── 非法输入 ──
  // 宿主类型是**闭合枚举**（公开知识，界面上就这两个入口）⇒ 400（请求写错了），
  // 不是 404（"东西不在了"会让排查的人去查数据而不是查请求）。
  // 而"看不见的记录"仍是 404 且与"不存在"同形 —— 那条判定在服务层。
  const badTarget = await call("PUT", "/api/watch/party/123", cookie, { watching: true });
  ok("不支持的宿主类型 → 400", badTarget.status === 400, `status=${badTarget.status}`);
  ok("宿主类型非法给 `bad_target`（枚举错，与 bad_tag/bad_status 同族）", badTarget.body?.error === "bad_target", `error=${badTarget.body?.error}`);
  // ⚠ 这条盯的是 **id 形态规则只有一处**：非数字 id 必须由 `http.ts:pathId()` 回话，
  //   码是 `bad_id`（全仓 61 处同形）。初版本路由自己写了 `/^\d{1,19}$/` 并自造 `bad_target`，
  //   于是同一个错误在两条路由上报出两个码 —— 只断 400 是照不出这个分叉的。
  const badId = await call("PUT", `/api/watch/risk_matter/abc`, cookie, { watching: true });
  ok("非数字 id → 400", badId.status === 400, `status=${badId.status}`);
  ok("非数字 id 的码是 `bad_id`（即走的是 `pathId()`，不是自造规则）", badId.body?.error === "bad_id", `error=${badId.body?.error}`);
  // `BigInt("undefined")` 抛 SyntaxError 会冒成 500（`pathId()` 存在的理由）——
  // 手打一个坏 URL 不该污染错误率监控。
  const undefId = await call("PUT", "/api/watch/risk_matter/undefined", cookie, { watching: true });
  ok("`undefined` 当 id → 400 而不是 500（`pathId()` 的原始理由）", undefId.status === 400, `status=${undefId.status}`);
  // ⚠ 这条是**自造 follow 的防线**：`watchType` 若能过，用户就写出一条 follow 行，
  //   于是「我关注」与「关注人名单」成了两份真相，而两边都 200、都不报错。
  const badType = await call("PUT", `/api/watch/risk_matter/${riskId}`, cookie, {
    watching: true,
    watchType: "follow",
  });
  ok("body 里塞 watchType → 400（.strict() 拒绝，堵死自造 follow）", badType.status === 400, `status=${badType.status}`);
  const [noSneak] = await sql`select count(*)::int as n from mn_user_watch
                              where target_type='risk_matter' and target_id=${riskId} and watch_type='follow'`;
  ok("被拒之后库里没有多出 follow 行", noSneak.n === 0, `n=${noSneak.n}`);
} finally {
  await cleanup();
  // ⚠ 第二个参数是 **user id 标量**（不是账号对象）：首版传了整个对象，
  //   `_testacct.mjs` 里 `where user_id = ${userId}` 把它插成 `[object Object]`
  //   ⇒ PG `invalid input syntax for type bigint`。清场工具的参数面没有类型保护，
  //   所以这条注释留在调用点（别的冒烟都是 `dropSmokeAccount(sql, a.id)`）。
  await dropSmokeAccount(sql, smoke.id);
  await dropSmokeAccount(sql, smoke2.id);
  await dropSmokeAccount(sql, smoke3.id);
  await sql.end({ timeout: 5 });
}

// ⚠ 汇总行是给 `tools/run-smokes.mjs` 看的：它**以退出码为准**，但
//   「退出码 0 却整段找不到汇总行」会被判成失败（"未见汇总"）——
//   首版就漏了这一行，全组冒烟因此报 1 个失败而退出码明明是 0。
console.log(`
${fail ? "FAIL" : "PASS"}：${pass} 通过 / ${fail} 失败`);
finishSmoke(fail);
