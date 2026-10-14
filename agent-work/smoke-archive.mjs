import { createSmokeAccount, dropSmokeAccount, ROLE_CODES } from "./_testacct.mjs";
/**
 * 归档完备性真 HTTP 冒烟（MATT-42 / F2-26 / G4 / IQ-16）。
 *
 * 票面七条 AC，这里逐条配断言，其中三条是这批里最容易糊过去的：
 *
 *  ① **判定只实现一次，两个出口**：详情页「归档就绪」卡与列表「已结案缺材料」筛选。
 *     所以有一条**两出口一致性断言**——详情页判为缺的案件，列表筛选必须也能找到它；
 *     详情页判为齐备的，列表筛选必须找不到。两个出口各写一份判定的漂移不会报错，
 *     只会让"列表说有缺、详情页说齐备"同时成立。
 *  ② **缺项不阻断 + 空数组 ≠ 齐备**：`missing_at_archive` 之外还要有
 *     `unavailable_at_archive`（附件那项没有数据源、这次没判）。
 *  ③ **事项侧不做这项校验**：归档事项时不该出现 `missing_at_archive`。
 *
 * 顺带验一条**声明了但没实现的效果**：`SEMANTICS_RULES.closed.effect` 写着
 * "视为结案，closing_date 自动写入"，而此前没有任何路径能写这一列
 * ⇒ 第②项恒判缺、详情页「已结案」标记永不出现。本轮补上了，这里钉住它。
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

async function login(username, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return {
    status: r.status,
    cookie: (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; "),
  };
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

const boss = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
const matterIds = [];
const riskIds = [];

async function cleanup() {
  for (const id of matterIds) {
    await sql.unsafe(`delete from mn_activity_log where matter_id=${id}`).catch(() => {});
    await sql.unsafe(`delete from mn_matter_staff where matter_id=${id}`).catch(() => {});
    await sql.unsafe(`delete from mn_matter_node where matter_id=${id}`).catch(() => {});
    await sql.unsafe(`delete from mn_matter_party where matter_id=${id}`).catch(() => {});
    await sql.unsafe(`delete from mn_matter where id=${id}`).catch(() => {});
  }
  for (const id of riskIds) {
    await sql.unsafe(`delete from mn_activity_log where risk_matter_id=${id}`).catch(() => {});
    await sql.unsafe(`delete from mn_risk_matter_staff where risk_matter_id=${id}`).catch(() => {});
    await sql.unsafe(`delete from mn_risk_matter where id=${id}`).catch(() => {});
  }
  await sql`delete from mn_activity_log where operator_id = ${boss.id}`;
  await sql`delete from mn_auth_session where user_id = ${boss.id}`;
  await sql`delete from mn_app_user_role where user_id = ${boss.id}`;
  try {
    await dropSmokeAccount(sql, boss.id);
  } catch (e) {
    console.log(`[clean] 删不掉 ${boss.username} —— ${String(e.message).split("\n")[0]}`);
  }
}

try {
  const s = await login(boss.username, boss.password);
  ok("夹具账号能登录", s.status === 200, `status=${s.status}`);
  const meta = await call("GET", "/api/meta?host=matter", s.cookie);
  const statuses = meta.body?.statuses ?? [];
  const closed = statuses.find((x) => x.semantics === "closed");
  const archived = statuses.find((x) => x.semantics === "archived");
  ok(
    "拿到 closed 与 archived 两个语义的状态（配置驱动，不硬编码 code）",
    !!closed && !!archived,
    `closed=${closed?.code} archived=${archived?.code}`,
  );

  const mkMatter = (name) =>
    call("POST", "/api/matters", s.cookie, {
      name,
      cause: "建设工程施工合同纠纷",
      caseType: "civil_commercial",
      procedure: "first_instance",
      litigationRole: "defendant",
      level: "high",
    });

  // ── A. 缺材料的案件：直接归档（无结案日期、有未决节点） ──
  const a = await mkMatter(`归档冒烟 缺材料 ${stamp}`);
  ok("建案 A → 201", a.status === 201, `status=${a.status}`);
  matterIds.push(a.body?.id);

  const detailA = await call("GET", `/api/matters/${a.body.id}`, s.cookie);
  const rA = detailA.body?.archiveReadiness;
  ok("详情带 archiveReadiness（卡片的数据源）", !!rA, JSON.stringify(rA)?.slice(0, 90));
  ok(
    "**第①项是 `unavailable` 而不是红也不是绿**（附件表一期未建）",
    rA?.checks?.find((c) => c.key === "judgment")?.state === "unavailable",
    `state=${rA?.checks?.find((c) => c.key === "judgment")?.state}`,
  );
  ok(
    "第②项判缺（还没结案）",
    rA?.checks?.find((c) => c.key === "closingDate")?.state === "missing",
    "",
  );
  ok(
    "第③项判缺且带上未决节点数",
    rA?.checks?.find((c) => c.key === "openNodes")?.state === "missing" &&
      (rA?.checks?.find((c) => c.key === "openNodes")?.count ?? 0) > 0,
    `count=${rA?.checks?.find((c) => c.key === "openNodes")?.count}`,
  );
  ok("`missing` 与 `unavailable` 分开列出", (rA?.missing ?? []).length === 2 && rA?.unavailable?.length === 1, JSON.stringify({ m: rA?.missing, u: rA?.unavailable }));

  // 归档**不填原因** → 422（强归必填 reason）
  const noReason = await call("POST", `/api/matters/${a.body.id}/status`, s.cookie, {
    to: archived.code,
  });
  ok(
    "**归档不填原因 → 422 reason_required**",
    noReason.status === 422,
    `status=${noReason.status} err=${noReason.body?.error}`,
  );

  // 填原因 → 归档成功（缺项不阻断）
  const archA = await call("POST", `/api/matters/${a.body.id}/status`, s.cookie, {
    to: archived.code,
    reason: "冒烟：材料没齐也照样归档",
  });
  ok("**缺项不阻断归档 → 200**", archA.status === 200, `status=${archA.status}`);

  const [logA] = await sql`
    select payload, reason from mn_activity_log
    where action='ARCHIVED' and matter_id=${a.body.id} order by created_at desc limit 1`;
  ok(
    "**缺项清单随 ARCHIVED 落库**",
    Array.isArray(logA?.payload?.missing_at_archive) &&
      logA.payload.missing_at_archive.includes("closingDate") &&
      logA.payload.missing_at_archive.includes("openNodes"),
    JSON.stringify(logA?.payload?.missing_at_archive),
  );
  ok(
    "**`unavailable_at_archive` 同时落库**（空数组 ≠ 齐备）",
    Array.isArray(logA?.payload?.unavailable_at_archive) &&
      logA.payload.unavailable_at_archive.includes("judgment"),
    JSON.stringify(logA?.payload?.unavailable_at_archive),
  );
  ok("归档原因也落了库", String(logA?.reason ?? "").includes("没齐"), String(logA?.reason ?? "").slice(0, 30));

  // ── 列表出口一：已结案缺材料 ──
  const listMissing = await call(
    "GET",
    "/api/matters?page=1&pageSize=100&archivedOnly=1&missingMaterials=1",
    s.cookie,
  );
  ok("列表「已结案缺材料」→ 200", listMissing.status === 200, `status=${listMissing.status}`);
  const missingIds = (listMissing.body?.items ?? []).map((r) => r.id);
  ok(
    "**两出口一致：详情判缺的案件，列表筛选找得到**",
    missingIds.includes(a.body.id),
    `命中 ${missingIds.length} 条`,
  );
  ok(
    "筛选结果里**每一条都真的已归档**（未归档的不算缺材料）",
    (listMissing.body?.items ?? []).every((r) => r.isArchived === true),
    "",
  );

  // ── B. 齐备的案件：先结案（自动写 closing_date）再把节点做完，然后归档 ──
  const b = await mkMatter(`归档冒烟 齐备 ${stamp}`);
  matterIds.push(b.body?.id);
  const closeB = await call("POST", `/api/matters/${b.body.id}/status`, s.cookie, {
    to: closed.code,
    reason: "冒烟：先结案",
  });
  ok("转到 closed 语义的状态 → 200", closeB.status === 200, `status=${closeB.status}`);
  const [rowB1] = await sql`
    select closing_date::text as cd from mn_matter where id=${b.body.id}`;
  ok(
    "**`closing_date` 自动写入**（`SEMANTICS_RULES.closed.effect` 那句承诺）",
    !!rowB1?.cd,
    `closing_date=${rowB1?.cd}`,
  );

  // 把该案件的节点全部置为 completed
  const detailB = await call("GET", `/api/matters/${b.body.id}`, s.cookie);
  const nodes = detailB.body?.nodes ?? [];
  ok("齐备案件有预设节点可做", nodes.length > 0, `节点=${nodes.length}`);
  /** 每个节点那条 POST 的 `id:status`，循环外合成一条断言 —— 挂了要能一眼看出是哪个节点 */
  const nodeDone = [];
  for (const n of nodes) {
    // ⚠ 契约：**POST** `/api/matters/{id}/nodes/{nodeId}`（nodeId 在**路径**里），
    //   不是 `PATCH …/nodes?nodeId=` —— 事项侧才是查询串形状，两侧不同形。
    //   本轮靠读路由源码才发现（库断着，跑不出来）：写错会 404，于是节点全留在
    //   未决状态，"齐备案件"那一节会以一条看不懂的信息全红。
    //   原来这里是裸的 `await call(...)`：404 被丢掉，只剩下面 `openNodes` 那条
    //   断言报"第②③项不是绿"——指向的是判齐备逻辑，不是"这个动词写错了"。
    const doneN = await call("POST", `/api/matters/${b.body.id}/nodes/${n.id}`, s.cookie, {
      status: "completed",
    });
    nodeDone.push(`${n.id}:${doneN.status}`);
  }
  ok(
    "**每个节点都置成 completed → 200**（动词错/路径错就是 404，不看状态码只会看到「没判齐备」）",
    nodeDone.every((x) => x.endsWith(":200")),
    nodeDone.join(" "),
  );
  const detailB2 = await call("GET", `/api/matters/${b.body.id}`, s.cookie);
  const rB = detailB2.body?.archiveReadiness;
  ok(
    "**齐备案件的第②③项都是绿**",
    rB?.checks?.find((c) => c.key === "closingDate")?.state === "ok" &&
      rB?.checks?.find((c) => c.key === "openNodes")?.state === "ok",
    JSON.stringify(rB?.checks?.map((c) => `${c.key}:${c.state}`)),
  );
  ok(
    "`ready` = 已判项齐备（**不是**三项齐备——附件那项没有数据源）",
    rB?.ready === true && rB?.missing?.length === 0 && rB?.unavailable?.length === 1,
    `ready=${rB?.ready} missing=${JSON.stringify(rB?.missing)} unavailable=${JSON.stringify(rB?.unavailable)}`,
  );

  const archB = await call("POST", `/api/matters/${b.body.id}/status`, s.cookie, {
    to: archived.code,
    reason: "冒烟：材料齐备后归档",
  });
  ok("齐备案件归档 → 200", archB.status === 200, `status=${archB.status}`);
  const [logB] = await sql`
    select payload from mn_activity_log
    where action='ARCHIVED' and matter_id=${b.body.id} order by created_at desc limit 1`;
  ok(
    "**齐备案件的 `missing_at_archive` 是空数组**（空 = 这一项真的齐）",
    Array.isArray(logB?.payload?.missing_at_archive) &&
      logB.payload.missing_at_archive.length === 0,
    JSON.stringify(logB?.payload?.missing_at_archive),
  );

  const listMissing2 = await call(
    "GET",
    "/api/matters?page=1&pageSize=100&archivedOnly=1&missingMaterials=1",
    s.cookie,
  );
  // ⚠ 负向断言必须先钉住状态码：请求失败时 `items` 是 undefined ⇒ `missingIds2` 是 `[]`
  //   ⇒ `!includes(...)` **恒真**，这条负向断言会空过（检查子代理指出的）。
  ok("第二次列表调用也必须是 200（否则下面的负向断言会空过）", listMissing2.status === 200, `status=${listMissing2.status}`);
  const missingIds2 = (listMissing2.body?.items ?? []).map((r) => r.id);
  ok(
    "**两出口一致：详情判齐备的案件，列表筛选找不到它**",
    !missingIds2.includes(b.body.id),
    `命中 ${missingIds2.length} 条`,
  );

  // ── D. 正交夹具：只缺一项，用来钉住**子句级**漂移 ──
  //
  // 为什么需要它：A 案（两项都缺）与 B 案（两项都齐）只能证明"整体是否生效"。
  // 把 `archiveMissingSql` 里的 `closing_date is null` 或 `exists(未决节点)` 任删一条，
  // A 找得到、B 找不到**都仍然成立** ⇒ 子句级漂移无感。C/D 各只缺一项，才能分别钉住。
  const c = await mkMatter(`归档冒烟 C 只缺未决节点 ${stamp}`);
  matterIds.push(c.body?.id);
  // C：先结案（拿到 closing_date），节点保持未决
  // ⚠ 原来是裸的 `await call(...)`。这一发被拒（archived 是终态、缺 can_unarchive…）
  //   时，下面只会报 `missing=["closingDate","openNodes"]` —— 读起来像判齐备的逻辑坏了，
  //   而真因是"结案这一步压根没成"。B 案的同一发是有状态码断言的（见上面 closeB）。
  const closeC = await call("POST", `/api/matters/${c.body.id}/status`, s.cookie, {
    to: closed.code,
    reason: "冒烟 C：先结案",
  });
  ok("C 案结案 → 200（`closing_date` 得先落下来）", closeC.status === 200, `status=${closeC.status}`);
  const detailC = await call("GET", `/api/matters/${c.body.id}`, s.cookie);
  const rC = detailC.body?.archiveReadiness;
  ok(
    "**C 案只缺「无未决节点」**（结案日期已填、节点未做完）",
    rC?.missing?.length === 1 && rC.missing[0] === "openNodes",
    `missing=${JSON.stringify(rC?.missing)}`,
  );

  const d = await mkMatter(`归档冒烟 D 只缺结案日期 ${stamp}`);
  matterIds.push(d.body?.id);
  // D：把节点全做完，但**不结案**（closing_date 保持 NULL）
  const detailD0 = await call("GET", `/api/matters/${d.body.id}`, s.cookie);
  const nodeDoneD = [];
  for (const n of detailD0.body?.nodes ?? []) {
    const doneN = await call("POST", `/api/matters/${d.body.id}/nodes/${n.id}`, s.cookie, {
      status: "completed",
    });
    nodeDoneD.push(`${n.id}:${doneN.status}`);
  }
  // 与 B 案同一条路、同一道门，所以也钉状态码：失败时下面那条只会说
  // `missing=["closingDate","openNodes"]`，看不出是"动词写错 404"还是"判齐备逻辑漂了"。
  ok(
    "D 案每个节点都置成 completed → 200",
    nodeDoneD.every((x) => x.endsWith(":200")),
    nodeDoneD.join(" ") || "（D 案没有预设节点）",
  );
  const detailD = await call("GET", `/api/matters/${d.body.id}`, s.cookie);
  const rD = detailD.body?.archiveReadiness;
  ok(
    "**D 案只缺「结案日期」**（节点全做完、没结案）",
    rD?.missing?.length === 1 && rD.missing[0] === "closingDate",
    `missing=${JSON.stringify(rD?.missing)}`,
  );

  for (const [label, m, code] of [
    ["C", c, archived.code],
    ["D", d, archived.code],
  ]) {
    // ⚠ 原来是裸的 `await call(...)`：归档没成功时，下面那条只会报"列表里找不到它"，
    //   读起来像筛选子句漂了（而那正是本节要钉的东西），真因却是这一步没归档成。
    const archCD = await call("POST", `/api/matters/${m.body.id}/status`, s.cookie, {
      to: code,
      reason: `冒烟 ${label}：归档`,
    });
    ok(`${label} 案归档 → 200`, archCD.status === 200, `status=${archCD.status}`);
    const list = await call(
      "GET",
      "/api/matters?page=1&pageSize=100&archivedOnly=1&missingMaterials=1",
      s.cookie,
    );
    ok(
      `**${label} 案（只缺一项）在列表筛选里找得到**——钉住那一条子句没被删掉`,
      (list.body?.items ?? []).some((r) => r.id === m.body.id),
      `status=${list.status}`,
    );
  }

  // ── E. 归档**不清空**结案日期（`closed → archived` 是 seed 的推荐后继）──
  const [rowB2] = await sql`
    select closing_date::text as cd, is_archived from mn_matter where id=${b.body.id}`;
  ok(
    "**归档后结案日期仍在**（`closed → archived` 保留日期，不抹掉）",
    !!rowB2?.cd && rowB2?.is_archived === true,
    `closing_date=${rowB2?.cd} is_archived=${rowB2?.is_archived}`,
  );

  // ── F. 列表的「下一期限」不能恒为 NULL ──
  //
  // ⚠ 这条守的是**同一类 drizzle 缺陷的第三例**：`listMatters` 的 `nextDeadline` 关联子查询里
  //   写的是 `${matter.id}`，在 **select 列表**上下文被渲染成无限定的 `"id"`，
  //   而子查询自己那张表也有 `id` ⇒ `n.matter_id = "id"` 变成 `n.matter_id = n.id`，**恒假**。
  //   比另外两例更阴：子查询只有一张表，PG **不报歧义**，`min()` 静默恒 NULL——
  //   列表的「下一期限」一列永远是空的，而此前**没有任何测试盯着它**（真库实测：
  //   6 个案件里本该 4 个有期限，实际全空）。
  //
  //   夹具用**直接写库**设节点时间：`start_time`/`end_time` 是生成列 `deadline_time` 的两个来源，
  //   而一期没有"改节点时间"的接口（预设节点建出来时时间是空的）。
  //   `ck_mn_matter_node_time_shape` 管着这一列的三种合法形状（照抄约束原文）：
  //     · `range` ⇒ start 与 end 都非空且 `end >= start`
  //     · `point` ⇒ **end 必须为 NULL**（只有时间点，没有时间段）
  //     · 两者都空 ⇒ 允许（"时间待定"是一等状态）
  //   预设节点里 `举证` 是 `range`、其余是 `point`，所以按类型分别给——
  //   一律写两个值会被约束拦下（我第一次就是这么写的，直接 23514）。
  //   ⚠ 建案响应只有 `{id, code, nameConflicts}`，**没有 `name`** ——
  //     所以关键词要用自己传进去的那个串，用 `f.body.name` 会得到字符串 "undefined"，
  //     列表 0 条，而断言会以"nextDeadline 是 null"的面目红（我第一次就是这么红的）。
  const fName = `归档冒烟 F 下一期限 ${stamp}`;
  const f = await mkMatter(fName);
  matterIds.push(f.body?.id);
  const detailF = await call("GET", `/api/matters/${f.body.id}`, s.cookie);
  const nodeF = (detailF.body?.nodes ?? []).find((n) => n.timeType === "range") ?? detailF.body?.nodes?.[0];
  ok("F 案有预设节点可设时间", !!nodeF?.id, `nodes=${detailF.body?.nodes?.length} type=${nodeF?.timeType}`);
  await sql`
    update mn_matter_node
       set start_time = now() + interval '5 days',
           end_time = case when time_type = 'range' then now() + interval '7 days' else null end
     where id = ${nodeF.id}`;
  const listF = await call("GET", `/api/matters?keyword=${encodeURIComponent(fName)}`, s.cookie);
  const rowF = (listF.body?.items ?? []).find((r) => r.id === String(f.body.id));
  const [dbF] = await sql`
    select count(*)::int as open_nodes,
           min(n.deadline_time)::text as min_deadline
      from mn_matter_node n
     where n.matter_id = ${f.body.id} and not n.is_deleted
       and n.status in ('not_started','in_progress')`;
  ok(
    "**列表的「下一期限」是真的**（不是恒 NULL、也不是 500）",
    listF.status === 200 && !!rowF?.nextDeadline,
    `status=${listF.status} 列表条数=${listF.body?.items?.length} 找到行=${!!rowF} ` +
      `接口值=${rowF?.nextDeadline ?? "null"} · 库内该案未决节点=${dbF?.open_nodes} 最早期限=${dbF?.min_deadline}`,
  );

  // ── C. 事项侧不做这项校验 ──
  const r = await call("POST", "/api/risk-matters", s.cookie, {
    name: `归档冒烟 事项 ${stamp}`,
    type: "contract",
    level: "high",
    description: "冒烟：事项侧不做材料完备校验",
  });
  ok("建事项 → 201", r.status === 201, `status=${r.status}`);
  riskIds.push(r.body?.id);
  const riskMeta = await call("GET", "/api/meta?host=risk_matter", s.cookie);
  const rArchived = (riskMeta.body?.statuses ?? []).find((x) => x.semantics === "archived");
  const archRisk = await call("POST", `/api/risk-matters/${r.body.id}/status`, s.cookie, {
    to: rArchived?.code,
    reason: "冒烟：归档事项",
  });
  const [riskLog] = await sql`
    select action, payload from mn_activity_log
    where risk_matter_id=${r.body.id} and action='ARCHIVED' order by created_at desc limit 1`;
  ok(
    "**事项侧归档不写 `missing_at_archive`**（事项是台账，没有材料完整要求）",
    archRisk.status === 200 && !riskLog?.payload?.missing_at_archive,
    `status=${archRisk.status} payload=${JSON.stringify(riskLog?.payload)}`,
  );
} catch (e) {
  fail++;
  console.log(`[FAIL] 脚本中断 —— ${e?.stack ?? e}`);
} finally {
  try {
    await cleanup();
    console.log("[clean] 清场完成");
  } catch (e) {
    console.log(`[clean] 清场失败 —— ${e?.message ?? e}`);
  }
  await sql.end();
}

console.log(`\n${fail ? "FAIL" : "PASS"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
