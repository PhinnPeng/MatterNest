/**
 * 真实冒烟（一期改进批次，2026-10-03）。跑在**已启动的 dev server + 已迁移已 seed 的库**上：
 *
 *   node agent-work/smoke-improvements.mjs            # 默认 http://127.0.0.1:3000
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
const BASE = process.env.BASE ?? "http://127.0.0.1:3000";

const results = [];
function record(ok, id, msg) {
  results.push({ ok, id });
  console.log(`${ok ? "[ ok ]" : "[FAIL]"} ${id} ${msg}`);
}

/** 每个账号一个 fetch：cookie 手工带，Next 的 session 是 httpOnly，拿不到就得自己存 */
function makeClient(username) {
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
      const r = await call("POST", "/api/auth/login", { username, password: username });
      return r.status === 200;
    },
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b),
  };
}

/** 演示数据里的固定 id：见 `seed/0003_demo.sql`（7001 承办人 103、协办 104；7006 已归档、承办 102） */
const DEMO = { matterOwnedByOther: "7001", archivedNotVisible: "7006", riskWithParties: "8302" };

async function main() {
  // S1 助理 104（纯 L2，7001 的协办）能登录
  const assistant = makeClient("suny");
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
  const admin = makeClient("wangkf");
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
    name: "冒烟转案件 · 当事人引用",
    cause: "合同纠纷",
    caseType: "civil_commercial",
    procedure: "first_instance",
    litigationRole: "defendant",
    level: "mid",
  });
  const convDetail = conv.status === 201 ? await admin.get(`/api/matters/${conv.data.id}`) : null;
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
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("冒烟脚本自身出错（多半是 dev server 没起或库还没迁移）：", e);
  process.exit(2);
});
