/**
 * 冒烟用的临时账号装置（审计 F1 之后加的）。
 *
 * 为什么需要它：seed 原先下发"口令 = 用户名"的演示摘要（明文写在 git 跟踪的 SQL 里），
 * 三个冒烟脚本就靠那个摘要登录。F1 把摘要撤掉之后**它们全都登不进去**。
 *
 * 为什么不改成"换个口令继续用同一个账号"：那等于把弱口令换个形状留在仓库里——
 * F1 撤掉的是「拿到仓库就能登入」，不是「测试需要一个能登的账号」。
 *
 * 所以账号由脚本**在运行时自建**，口令是当场随机生成的：
 *   · 仓库里不再有任何可用凭据；
 *   · 每次跑用的是不同口令，跑完即删；
 *   · 清单里的 `finally` 已经会删会话与角色，这里再删账号本身。
 *
 * 哈希算法与 `auth.ts` 的 `derive` 同源（scrypt + `mn-demo-salt-<username>`）。
 * 这里复制那一行是**有意的**：冒烟脚本是纯 .mjs，导不进 TS 模块；
 * 而若哪天 `auth.ts` 改了 salt 规则，本装置会在下面那条登录断言上直接红——
 * 那正是我们想要的「不一致会被发现」。
 */
import { randomBytes, scryptSync } from "node:crypto";

const SALT_PREFIX = "mn-demo-salt-";

function hashLike(password, username) {
  return scryptSync(password, `${SALT_PREFIX}${username}`, 64).toString("hex");
}

/**
 * 建一个临时账号并挂上给定的角色 code。
 * @returns {{id: bigint, username: string, password: string}}
 */
export async function createSmokeAccount(sql, { roles, isAdmin = false, suffix = "" }) {
  const username = `mn_smoke_${randomBytes(4).toString("hex")}${suffix}`;
  const password = randomBytes(18).toString("base64url");
  const hash = hashLike(password, username);
  const stamp = BigInt(Date.now() * 1000) + BigInt(Math.floor(Math.random() * 1000));

  const [user] = await sql`
    insert into mn_app_user (id, username, display_name, password_hash, is_enabled, is_admin, activation_status, created_at, updated_at)
    values (${stamp}, ${username}, ${`冒烟临时账号 ${username.slice(-6)}`}, ${hash}, true, ${isAdmin}, 'active', now(), now())
    on conflict ("username") do update set password_hash = excluded.password_hash, is_enabled = true, updated_at = now()
    returning id`;

  for (const [i, code] of roles.entries()) {
    const [role] = await sql`select id from mn_role where code = ${code} limit 1`;
    if (!role) throw new Error(`冒烟账号挂角色失败：mn_role 里没有 code=${code}`);
    await sql`
      insert into mn_app_user_role (id, user_id, role_id, created_at)
      values (${stamp + BigInt(i) + 1n}, ${user.id}, ${role.id}, now())
      on conflict do nothing`;
  }
  return { id: user.id, username, password };
}

/**
 * 删掉临时账号。清场用。
 *
 * ## 为什么要分三类处置
 *
 * `mn_app_user` 被 11 条外键引用，其中只有 2 条是 CASCADE（`mn_app_user_role.user_id`、
 * `mn_auth_session.user_id`，会自己跟着删），**其余 9 条全是 RESTRICT**——不先处理就报
 * `violates foreign key constraint`。这不是假设：做视觉验收时留的那个 standby 账号写了
 * 7 条活动日志，就直接卡住了。而冒烟脚本一直没暴露，只因为它们没触发被审计的动作，
 * **没暴露不等于不存在**。
 *
 * 三类，分别对应三种后果：
 *
 * 1. **自己的审计痕迹**（`mn_activity_log`）→ 直接删。删的是这个账号自己写的行。
 *    同类的还有**两张按用户派生的新表**（迁移 0010 带来的）：
 *    `mn_notification_delivery`（投递到某人的通知）与 `mn_user_watch`（某人的关注清单）。
 *    它们不是业务记录，是**这个账号自己的数据**，所以与审计痕迹同一处置。
 *
 *    ⚠ 这两条是**后补的**，补的原因值得记：0010 给 `mn_notification_delivery.user_id`
 *    加了 NOT NULL + RESTRICT 的外键，而本函数当时不认识它 ⇒ **任何触发真实通知的冒烟**
 *    （转案件触发规则 7、加关注人触发规则 2/8）都会在这个账号名下留一行投递，
 *    于是账号删不掉、**每轮攒一个孤儿账号**。实测症状出现在**别的**冒烟上
 *    （`smoke-risk` 报 `mn_notification_delivery_user_id_mn_app_user_id_fk`），
 *    而根因在通知管线——这正是"新表要有人回头补清场清单"的典型漏点。
 *    教训：**加一张引用 `mn_app_user` 的表，就要回来看看这份清单**。
 * 2. **可空的归属列**（`mn_matter_node.owner_id`、`mn_risk_matter.owner_id`、
 *    `mn_risk_matter_node.owner_id`）→ 置 NULL。业务行留着，只解除引用。
 * 3. **NOT NULL 的归属列**（`mn_matter.owner_id`、`mn_matter.created_by`、
 *    `mn_matter_progress.author_id`、`mn_matter_staff.user_id`、
 *    `mn_risk_matter.created_by`、`mn_risk_matter_staff.user_id`、`mn_comment.author_id`）
 *    → **不删**。删业务行不是这个函数的职责：跑到这里还有 NOT NULL 的行指着这个账号，
 *    说明**冒烟脚本自己的清场漏了夹具**，那是脚本的 bug。该报出来，不该替它擦掉。
 *    悄悄删掉生产形状的业务行，比留着残留危险得多。
 *
 *    ⚠ `created_by` 两列是**补进来的**（2026-10-13）：原先只查 `owner_id`，于是
 *    "账号建了事项但没清掉"这种情况会绕过这里的报错，直接撞上 Postgres 的
 *    `violates foreign key constraint` —— 错误信息里只有约束名，看不出是哪张表哪一列，
 *    排查得从头翻 schema。检查清单必须覆盖**真正会拦住的列**，不然这份"友好报错"
 *    只覆盖了它恰好想到的那一半（本轮实测：7 个残留账号里 6 个是 `created_by` 拦的）。
 */
export async function dropSmokeAccount(sql, userId) {
  if (userId === undefined || userId === null) return;

  // 1) 自己的审计痕迹 + **按用户派生的两张表**（迁移 0010 带来的）
  //
  // ⚠ 顺序：投递行先删。`mn_notification_event` 是**事件**（挂在宿主上，不挂人），
  //   所以不在这里删——删事件要连带它的业务语义，那是业务行，不是"这个账号的数据"。
  //   只删投递（"通知发给谁"）与关注（"谁关注了什么"）这两张按用户派生的表。
  //
  // ⚠ `mn_import_batch` 是**后补的第三张**（迁移 0013，MATT-44）。它指着操作人，
  //   但**没有外键**（与 `mn_activity_log.operator_id` 同口径：审计物不指人），
  //   所以删不掉账号这件事**不会报错** —— 只会留下一批指向不存在账号的批次记录。
  //   没有外键不等于不用清：那正是"新表要有人回头补清场清单"最容易被漏掉的一种
  //   （有外键的会被 PG 当场拦住，没外键的只会静静攒着）。
  //   `mn_import_row` 随批次 CASCADE（迁移 0013 的外键动作），这里不用单独删。
  await sql`delete from mn_activity_log where operator_id = ${userId}`;
  await sql`delete from mn_notification_delivery where user_id = ${userId}`;
  await sql`delete from mn_user_watch where user_id = ${userId}`;
  await sql`delete from mn_import_batch where created_by = ${userId}`;

  // 2) 可空的归属列：只解除引用，不动业务行
  await sql`update mn_matter_node set owner_id = null where owner_id = ${userId}`;
  await sql`update mn_risk_matter set owner_id = null where owner_id = ${userId}`;
  await sql`update mn_risk_matter_node set owner_id = null where owner_id = ${userId}`;

  // 3) NOT NULL 的归属列：先查，报出是谁在指，而不是删掉它
  const blockers = [];
  const check = async (table, column) => {
    const rows = await sql.unsafe(
      `select count(*)::int as c from ${table} where ${column} = $1`,
      [userId],
    );
    if (rows[0].c > 0) blockers.push(`${table}.${column}（${rows[0].c} 行）`);
  };
  await check("mn_matter", "owner_id");
  await check("mn_matter", "created_by");
  await check("mn_matter_progress", "author_id");
  await check("mn_matter_staff", "user_id");
  await check("mn_risk_matter", "created_by");
  await check("mn_risk_matter_staff", "user_id");
  await check("mn_comment", "author_id");
  if (blockers.length) {
    throw new Error(
      `临时账号 ${userId} 删不掉：还有 NOT NULL 的业务行指着它 —— ${blockers.join("、")}。\n` +
        `这些是冒烟脚本漏清的夹具，应该由脚本自己删（或把 owner 改成另一个账号再删），\n` +
        `不该由 dropSmokeAccount 代删业务行。`,
    );
  }

  // 4) 会话与角色是 CASCADE，显式删只为不依赖外键动作
  await sql`delete from mn_auth_session where user_id = ${userId}`;
  await sql`delete from mn_app_user_role where user_id = ${userId}`;
  await sql`delete from mn_app_user where id = ${userId}`;
}

export const ROLE_CODES = {
  /** 全局管理：全部记录 + 撤销归档 + 明文导出。冒烟里用它当"权限最大的那个人" */
  fullAdmin: "full_admin",
  /** 参与经办：只看得见自己参与的事 */
  joined: "joined_operator",
  /** 承办经办：只看得见自己经办或创建的 */
  self: "self_operator",
  /** 系统管理：管配置与账号，数据范围压到 owned */
  sysAdmin: "sys_admin",
};