/**
 * 规则 1 / 3 的**落地前置**核对（2026-10-18）。
 *
 * ## 为什么要单开一份核对
 *
 * 票 A 让 7 条规则的开关变真（`probe-rule-executors.mjs` 现报 7 有效 / 0 装饰），
 * 剩下的规则 1（结案自动归档）与规则 3（进入进行中创建节点）**连执行体都没有**。
 * 本可以照着规则 2 的形状直接写，但开工前核出来两处**硬阻塞** ——
 * 都不是"代码没写"，而是**规格与库结构对不上**。写在这里是因为：
 * 照现状硬写会得到一个**看起来能用、实际会坏**的实现，而那种形态最难发现。
 *
 * ## 两处阻塞（逐条实测，可复核）
 *
 * ### 规则 1：`operator = SYSTEM` 无处落地
 *
 * 权限草案 §8 原话：「系统内部身份（`operator = SYSTEM`）**不建 `app_user` 行**，
 * 用常量 id，特权恒为假」，且「规则以 `operator = SYSTEM` 执行」。
 *
 * 而 `mn_activity_log.operator_id` 是 **NOT NULL + 外键指向 `mn_app_user(id)`
 * ON DELETE RESTRICT**（`0000_mn_baseline.sql:343/406`）。当前库里：
 *   · 没有任何 `username ilike '%system%'` 的账号行；
 *   · `AUTO_RULE_*` 的审计行是**零行** —— 所有既有规则（4/9）**都不写 `activity_log`**，
 *     它们只写 `mn_notification_event`（那张表没有 operator 列，也就绕过了这件事）。
 *
 * ⇒ 规则 1 的动作是 `archive`，而归档在人工路径上**必须**落 `ARCHIVED` 审计
 * 且 `reason` 必填（`REASON_REQUIRED_ACTIONS`）。规则触发时没有人类 actor、也没有 reason。
 * 三条路各有代价：
 *   ① 建一行 `SYSTEM` 账号（违反 §8 的"不建行"，且它会出现在用户列表/选人面里）；
 *   ② 把 `operator_id` 放宽成可空（改 NOT NULL 契约，影响全部审计语义）；
 *   ③ 用"触发规则的那个用户"当 operator（事件发生时通常没有用户在场 ——
 *      规则 1 是定时/状态驱动，不是用户动作的回声）。
 * **这是要人拍的产品/建模决定，不是 agent 该自作主张的。**
 *
 * ### 规则 3：`template_code` 列不存在，且与 P1 重叠
 *
 * 修订稿 §4（A3）要求 `node_type_config` 有 `template_code varchar(32)`
 * 作为「P2 归组码，规则 3 按它批量取模板节点」。实测：**该列不存在**
 * （`information_schema` 零行）⇒ 规则 3 无法按 `action_config.template_code` 找节点类型。
 * 要落地得先加一列（迁移）+ 回填 3 行 seed。
 *
 * 更要紧的是**行为重叠**：`preset_on_create = true` 的三行（filing/evidence/hearing）
 * 在**建案时**已经生成节点（`planPresetNodesFor`）。规则 3 若在"进入进行中"时
 * 再按同一批类型生成一次，同一案件就会有**两套**举证/开庭节点，
 * 且 `sort_order` 各自从 1 开始 —— 详情页时间线会交错。规格没有回答
 * "P1 已生成的类型，P2 是否跳过"，这同样是产品决定。
 *
 * ## 本脚本做什么
 *
 * 只**读**，把上面四项事实每次重新量一遍并打印。它不打红也不打绿（退出码恒 0）：
 * 今天的事实就是"两处阻塞还在"，把它写成断言等于让仓库常红。
 * 它的价值是**阻断"我以为能写"**：谁要动规则 1/3，先跑它。
 *
 *     node --env-file=.env agent-work/probe-rule13-blockers.mjs
 */
import postgres from "postgres";

const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  connect_timeout: 8,
});

const line = (s) => console.log(s);

try {
  line("规则 1 / 3 的落地前置核对（只读）\n");

  // ── 规则 1 ──
  const fks = await sql`
    select pg_get_constraintdef(oid) def from pg_constraint
     where conname like '%activity_log_operator%'`;
  line("【规则 1】`mn_activity_log.operator_id` 的约束：");
  for (const f of fks) line(`  · ${f.def}`);
  const notNull = await sql`
    select is_nullable from information_schema.columns
     where table_name = 'mn_activity_log' and column_name = 'operator_id'`;
  line(`  · is_nullable = ${notNull[0]?.is_nullable}`);

  const sysUser = await sql`
    select id, username from mn_app_user where username ilike '%system%'`;
  line(
    `  · SYSTEM 账号行：${sysUser.length ? sysUser.map((r) => `${r.id}/${r.username}`).join(",") : "**不存在**"}`,
  );
  const autoRows = await sql`
    select count(*)::int n from mn_activity_log where action like 'AUTO_RULE%'`;
  line(`  · 库里 AUTO_RULE_* 审计行：${autoRows[0].n} 行（既有规则 4/9 只写通知，不写审计）`);
  const reasonRequired = ["ARCHIVED", "UNARCHIVED", "UNCONVERT", "NODE_CANCELLED"];
  line(`  · 归档在人工路径上属 ${JSON.stringify(reasonRequired)} 之一 ⇒ 规则触发时无 reason、无 actor`);
  line(
    "  ⇒ **阻塞**：要写 ARCHIVED 审计就得先决定 operator 怎么表示（建 SYSTEM 行 / 放宽可空 / 借用触发人）\n",
  );

  // ── 规则 3 ──
  const tc = await sql`
    select column_name from information_schema.columns
     where table_name = 'mn_node_type_config' and column_name = 'template_code'`;
  line("【规则 3】`mn_node_type_config.template_code`（A3 要求的 P2 归组码）：");
  line(`  · ${tc.length ? "在" : "**不存在**（规则 3 无法按 template_code 找节点类型，需迁移 + 回填 seed）"}`);

  const preset = await sql`
    select code, preset_on_create, sort_order from mn_node_type_config
     where host_type = 'matter' order by sort_order`;
  const p1 = preset.filter((r) => r.preset_on_create).map((r) => r.code);
  line(`  · \`preset_on_create = true\` 的类型（P1 建案时已生成）：${p1.join(", ") || "无"}`);
  const [rule3] = await sql`
    select action_config from mn_automation_rule where code = 'preset_03_in_progress_create_node'`;
  line(`  · 规则 3 的 action_config：${JSON.stringify(rule3?.action_config ?? null)}`);
  line(
    "  ⇒ **阻塞**：P1 已在建案时生成同一批类型；P2 再生成一次 ⇒ 同一案件两套节点、" +
      "两套 sort_order。规格未回答「P1 已生成的类型 P2 是否跳过」\n",
  );

  line("结论：规则 1 / 3 **不能照规则 2 的形状直接写**，两者各需一个先决裁定。");
  line('      本脚本不判红绿（今天的事实就是「还堵着」）；要动它们，先看上面四项。');
} catch (e) {
  console.error(`核对失败（${e?.message ?? e}）—— 隧道可能正在抖，重跑即可。`);
  process.exitCode = 3;
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
}
