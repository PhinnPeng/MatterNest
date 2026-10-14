import { createSmokeAccount, dropSmokeAccount, ROLE_CODES } from "./_testacct.mjs";
/**
 * 真实冒烟（一期改进批次，2026-10-03）。跑在**已启动的 dev server + 已迁移已 seed 的库**上：
 *
 *   node agent-work/smoke-improvements.mjs            # 默认 http://127.0.0.1:3777
 *   BASE=http://127.0.0.1:3123 node agent-work/smoke-improvements.mjs
 *
 * 七条断言，全部是"离线单测证不了、只有真登录 + 真 HTTP 才看得到"的那类：
 *   S1 登录本身能过（新增的 `is_admin` 列真在库里，`readActor` 没崩）
 *   S2 L2 协办改别人案子的状态 → **403 attribution_required**（护栏 1）
 *   S3 看不见的归档案件改状态 → **404 而不是 403**（元规则 3，反探测）
 *   S4 偏离推荐路径缺原因 → 422；同一跳带上原因 → 200（§3.3 第 3 条）
 *   S5 建案带出 P1 预设节点，且 `start_time` 为空、序号连续（§4）
 *   S6 同名当事人**不自动合并**：新建一行 + 回 name_conflicts（§7.2 / F3-3）
 *   S7 转案件把事项的当事人**引用**过去（不是克隆），事项无当事人时 422（映射 §2.6）
 *
 * 只读断言之外确实会写库：S4/S5/S6/S7 会留下案件与活动日志。这是 dev 演示库，
 * 且演示数据本身就是 `0003_demo.sql` 可重放的 —— 不在生产/他人库上跑。
 */
// ⚠ 原来读 `process.env.BASE` 且默认 3000 —— 与其余 17 个脚本的 `SMOKE_BASE`
// / 3777 都不一致，于是「起在非默认端口」时本脚本是全组唯一连不上的那个。
// 现在与其余脚本同口径。
const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";

// 自建临时账号（账号收敛为单个 admin 之后，不再依赖 seed 里的演示账号）。
// admin 不参与本脚本：它是 is_admin=true，会短路范围谓词，拿它当 L1 测不出差异。
const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});
// 范围最广的**普通角色**，不是逃生口。
// `isAdmin: true` 会让探针账号拿到 §3 的最后开关，于是它成了第二个"逃生口持有人"，
// 每次跑都在把"is_admin 到底有几个人"这个数往错的方向推。本脚本要验的是
// 三档数据范围，全公司那一档由 `full_admin`（scope=all）就给得起，不需要逃生口。
const acctL1 = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: false });
const acctL2 = await createSmokeAccount(sql, { roles: [ROLE_CODES.joined] });
/** 本轮造的案件 id；清场要先删它，否则账号删不掉（owner_id 是 NOT NULL） */
let createdMatterId = null;
/** 本轮给 7001 加的协办行 id；清场要先删它 */
let staffFxId = `${Date.now()}999`;
const dropAccts = async () => {
  const step = async (label, fn) => {
    try { await fn(); } catch (e) { console.log(`  · 清场「${label}」未完成：${String(e.message).split("\n")[0]}`); }
  };

  /**
   * ⚠ 必须先删本脚本造的案件，**再**删账号（2026-10-12 修）。
   *
   * 原来只删账号，于是 `mn_matter.owner_id` 是 NOT NULL 且指向那个临时账号 ⇒
   * 账号删不掉，`dropSmokeAccount` 按设计**拒绝删业务行**并报出阻塞者（这个行为是对的）。
   * 结果每次跑都往库里留两个孤儿账号，其中两个还是 `is_admin=true`。
   *
   * 删除顺序按 FK RESTRICT：当事人关联与节点先走，案件最后。
   */
  if (createdMatterId) {
    await step("删本轮造的案件", async () => {
      await sql`delete from mn_matter_party where matter_id = ${createdMatterId}`;
      await sql`delete from mn_matter_staff where matter_id = ${createdMatterId}`;
      await sql`delete from mn_matter_node where matter_id = ${createdMatterId}`;
      await sql`delete from mn_activity_log where matter_id = ${createdMatterId}`;
      await sql`delete from mn_matter where id = ${createdMatterId}`;
    });
  }
  // S7 转出来的案件：它同时被两条链指着——`mn_risk_matter_case.risk_matter_id`
  // （转案件关联）与 `mn_activity_log.risk_matter_id`。少删前者就会撞 FK。
  await step("删本轮转出的案件", async () => {
    const rows = await sql`
      select m.id from mn_matter m
      join mn_risk_matter_case c on c.matter_id = m.id
      where c.risk_matter_id = ${BigInt(DEMO.riskWithParties)}
        and m.name like '冒烟转案件%'`;
    for (const r of rows) {
      await sql`delete from mn_matter_party where matter_id = ${r.id}`;
      await sql`delete from mn_matter_staff where matter_id = ${r.id}`;
      await sql`delete from mn_matter_node where matter_id = ${r.id}`;
      await sql`delete from mn_activity_log where matter_id = ${r.id} or risk_matter_id = ${r.id}`;
      await sql`delete from mn_risk_matter_case where matter_id = ${r.id}`;
      await sql`delete from mn_matter where id = ${r.id}`;
    }
  });
  // 7001 是 seed 数据本身，**只删本脚本给它加的那一行协办**，别把 seed 的参与人一起删了
  await step("删本脚本加的协办行", () =>
    sql`delete from mn_matter_staff where id = ${staffFxId}`,
  );

  await step("删 L1 临时账号", () => dropSmokeAccount(sql, acctL1.id));
  await step("删 L2 临时账号", () => dropSmokeAccount(sql, acctL2.id));
  await step("断开数据库", () => sql.end());
};

const results = [];
function record(ok, id, msg) {
  results.push({ ok, id });
  console.log(`${ok ? "[ ok ]" : "[FAIL]"} ${id} ${msg}`);
}

/** 每个账号一个 fetch：cookie 手工带，Next 的 session 是 httpOnly，拿不到就得自己存 */
function makeClient(acct) {
  // acct 是 _testacct 自建的临时账号；口令是当场随机的，**不等于**账号名
  const username = acct.username;
  const password = acct.password;
  let cookie = "";
  async function call(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.getSetCookie?.() ?? [];
    for (const c of sc) cookie = c.split(";")[0];
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* 空响应体 */
    }
    return { status: res.status, data };
  }
  return {
    async login() {
      const r = await call("POST", "/api/auth/login", { username, password });
      return r.status === 200;
    },
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b),
  };
}

/** 演示数据里的固定 id：见 `seed/0003_demo.sql`（7001 承办人 103、协办 104；7006 已归档、承办 102） */
const DEMO = { matterOwnedByOther: "7001", archivedNotVisible: "7006", riskWithParties: "8302" };

async function main() {
  /**
   * S2 要先造一个「L2 是协办、但不是负责人」的靶子。
   *
   * 原来靠 seed 的 7001（负责人 103、协办 104）。账号收敛为单个 admin 之后，
   * 7001 的负责人行与协办行**都指向 admin**，于是临时 L2 根本不是它的协办：
   * 看不见 → 404，而不是预期的 403 `attribution_required`。
   *
   * 403 与 404 的区别正是这条断言的价值：**403 等于确认"这条路你知道但走不了"**，
   * 404 才是"对你来说它不存在"。两者混用会把权限模型的存在性泄出去。
   *
   * 参与人只能直连 SQL 加——`/api/matters` 下没有任何加参与人的入口。
   */
  await sql`insert into mn_matter_staff (id, matter_id, user_id, staff_role)
            values (${BigInt(staffFxId)}, ${BigInt(DEMO.matterOwnedByOther)}, ${acctL2.id}, 'co_owner')
            on conflict do nothing`;

  // S1 助理（纯 L2，7001 的协办）能登录
  const assistant = makeClient(acctL2);
  record(await assistant.login(), "S1", "suny（L2 协办）登录成功 ⇒ is_admin 列未破坏 readActor");

  // S2 协办改别人的案子状态
  const s2 = await assistant.post(`/api/matters/${DEMO.matterOwnedByOther}/status`, {
    to: "closed",
    reason: "冒烟：协办试着推走别人的案子",
  });
  record(
    s2.status === 403 && s2.data?.error === "attribution_required",
    "S2",
    `协办改状态 → ${s2.status} ${s2.data?.error ?? ""}`,
  );

  // S3 看不见的归档案件：必须是 404，不能是 403（403 等于确认了它存在）
  const s3 = await assistant.post(`/api/matters/${DEMO.archivedNotVisible}/status`, {
    to: "pending",
    reason: "冒烟：探测一条看不见的归档案件",
  });
  record(s3.status === 404, "S3", `不可见归档案件 → ${s3.status}（要求 404，不是 403）`);

  // S4 主任 101（L1，可改任何一条）走一次偏离
  const admin = makeClient(acctL1);
  await admin.login();
  const s4a = await admin.post(`/api/matters/${DEMO.matterOwnedByOther}/status`, { to: "pending" });
  const s4b = await admin.post(`/api/matters/${DEMO.matterOwnedByOther}/status`, {
    to: "pending",
    reason: "冒烟：验证偏离推荐路径必须写原因",
  });
  record(
    s4a.status === 422 && s4a.data?.error === "reason_required" && s4b.status === 200,
    "S4",
    `缺原因 → ${s4a.status}/${s4a.data?.error}；带原因 → ${s4b.status}`,
  );
  // 再把状态推回 in_progress，别让演示数据停在待受理
  await admin.post(`/api/matters/${DEMO.matterOwnedByOther}/status`, {
    to: "in_progress",
    reason: "冒烟收尾：回到在办",
  });

  // S5 + S6 建案：预设节点 + 同名当事人不合并
  // 证件号每次跑都换（同名那次**必须**是"库里没有这个人"），否则第二次运行会命中
  // (type, id_number) 精确复用 —— 那是另一条正确分支，会让 S6 看起来"失败"。
  const smokeId = `SMOKE-${Date.now()}`;
  const created = await admin.post("/api/matters", {
    name: `冒烟案件 · 预设节点与同名当事人 ${smokeId}`,
    cause: "买卖合同纠纷",
    caseType: "civil_commercial",
    procedure: "first_instance",
    litigationRole: "plaintiff",
    level: "mid",
    // 与演示数据里的 6004 同名，但证件号是新的 ⇒ 必须新建一行 + 回提示
    parties: [
      {
        name: "南京云脉数据科技有限公司",
        type: "legal_person",
        idNumber: smokeId,
        partyRole: "plaintiff",
        represented: true,
      },
    ],
  });
  const detail = created.status === 201 ? await admin.get(`/api/matters/${created.data.id}`) : null;
  // 记下 id：清场要先删这条案件，否则临时账号删不掉（owner_id NOT NULL 指向它）
  if (created.status === 201 && created.data?.id) createdMatterId = BigInt(created.data.id);
  const nodes = detail?.data?.nodes ?? [];
  record(
    nodes.length === 3 &&
      nodes.map((n) => n.sortOrder).join() === "1,2,3" &&
      nodes.every((n) => n.startTime === null && n.isTimeConfirmed === false),
    "S5",
    `建案带出预设节点 ${nodes.length} 条：${nodes.map((n) => n.name).join("/")}（时间待定=${nodes.every((n) => !n.startTime)}）`,
  );
  record(
    (created.data?.nameConflicts ?? []).length >= 1,
    "S6",
    `同名当事人 → 新建 + 回提示 ${JSON.stringify(created.data?.nameConflicts ?? [])}`,
  );

  // S7 转案件引用事项当事人（不克隆），并对无当事人的事项拒转
  const conv = await admin.post(`/api/risk-matters/${DEMO.riskWithParties}/convert`, {
    // ⚠ `cases` 是数组：T2 把转案件改成一次可转 1→N，这个脚本原先打的是单案表单
    // （name/cause/… 若干平级字段），被 Zod 判 400 validation_failed —— 断言过时，不是缺陷。
    cases: [
      {
        name: "冒烟转案件 · 当事人引用",
        cause: "合同纠纷",
        caseType: "civil_commercial",
        procedure: "first_instance",
        litigationRole: "defendant",
        level: "mid",
      },
    ],
  });
  // ⚠ 形状是 `{cases:[{id, internalCode}]}`（T2 改 1→N 之后的结果），**不是** `{id}`。
  // 原先写成 `conv.data.id`，取出来是 undefined → 详情取不到 → 当事人 0 条，
  // 断言红在"转案件没带出当事人"，而真实原因只是读错了返回字段。
  const convCaseId = conv.status === 201 ? conv.data?.cases?.[0]?.id : null;
  const convDetail = convCaseId ? await admin.get(`/api/matters/${convCaseId}`) : null;
  const parties = convDetail?.data?.parties ?? [];
  record(
    parties.length >= 1 && parties.every((p) => /^60\d\d$/.test(String(p.partyId))),
    "S7",
    `转案件带出当事人 ${parties.length} 条（引用既有 id：${parties.map((p) => p.partyId).join(",")}）`,
  );

  // S8 「时间待定」与「标已确认」是**命令**不是状态：只翻 `is_time_confirmed`，
  //      `status` 一列不许动（动了就等于把进行中的举证拉回未开始），也不许撞 E21 的 CHECK。
  //      靶子是演示数据 7001 的举证节点（8202，in_progress、时间已确认）。
  const before = await admin.get("/api/matters/7001");
  const node8Before = (before.data?.nodes ?? []).find((n) => n.id === "8202");
  await admin.post("/api/matters/7001/nodes/8202", { status: "pending" });
  const afterPending = await admin.get("/api/matters/7001");
  const node8Pending = (afterPending.data?.nodes ?? []).find((n) => n.id === "8202");
  const s8a =
    node8Pending &&
    node8Pending.isTimeConfirmed === false &&
    node8Pending.status === node8Before?.status;
  // 再走反方向：时间还在，所以 confirm_time 应该把它抬回已确认，status 依然不动
  const s8b = await admin.post("/api/matters/7001/nodes/8202", { status: "confirm_time" });
  const afterConfirm = await admin.get("/api/matters/7001");
  const node8Back = (afterConfirm.data?.nodes ?? []).find((n) => n.id === "8202");
  record(
    Boolean(s8a) &&
      s8b.status === 200 &&
      node8Back?.isTimeConfirmed === true &&
      node8Back?.status === node8Before?.status,
    "S8",
    `待定 → isTimeConfirmed=${node8Pending?.isTimeConfirmed}/status=${node8Pending?.status}；` +
      `已确认 → ${node8Back?.isTimeConfirmed}/${node8Back?.status}（要求：布尔来回翻，status 全程不变）`,
  );

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n冒烟：${results.length - failed.length}/${results.length} 通过` +
      (failed.length ? `，失败 ${failed.map((f) => f.id).join(" ")}` : ""),
  );
  await dropAccts();
process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("冒烟脚本自身出错（多半是 dev server 没起或库还没迁移）：", e);
  process.exit(2);
});
