# 研究：CI 里那条超级用户角色（#87）

> **本文是调研快照，不是施工方案。** 修法形态要人拍 —— 见文末「要人拍的三点」。
> 调研日期 2026-10-15。所有结论都是**在本地实测出来的**，不是查文档推的。

## 一句话结论

`tools/migrate.mjs` 里那两道闸门 —— `MN_DB_CONFIRM` 与 advisory lock —— **都不依赖超级用户**。
CI 之所以必须红，是因为 workflow 用 `POSTGRES_USER: dev_matternest` 建库，而该镜像把这个角色
建成了 **SUPERUSER**；本地那条同名角色不是，于是本地全绿、CI 必红。

## 本地那条非超级用户角色的权限画像

直接问库（`rolsuper=false` 的会话）：

| 项 | 值 |
| --- | --- |
| `rolsuper` | `false` |
| `rolcreatedb` | `true` |
| `rolcreaterole` | `false` |
| 库的属主 | **它自己**（`pg_get_userbyid(datdba)`） |
| `public` schema 属主 | **它自己**（真角色，oid 535384，**不是** `pg_database_owner` 伪角色） |
| `public` ACL | `{dev_matternest=UC/dev_matternest}`（USAGE + CREATE） |
| `public` 下自有表 | 34 张（全有） |
| `drizzle` schema 属主 | 它自己 |

⇒ **本地跑通的姿态是「非超级用户 + 自有库 + 自有 `public`」**，不是「非超级用户 + 被逐条授权的普通角色」。
这个区别决定了修法形态（见第四节）。

## 两道闸门逐条实测

全部以 `rolsuper=false` 的会话执行：

| 闸门 | 用的东西 | 需要超级用户吗 | 实测 |
| --- | --- | --- | --- |
| `MN_DB_CONFIRM` | `select current_database()` | **否** | 通过 |
| advisory lock | `hashtext('matternest:migrator')` + `pg_advisory_lock` | **否** | `k=-558534946`，取到并释放成功 |
| `hashtext` 本身 | 内部函数 | **否** | `has_function_privilege(...,'EXECUTE') = true` |
| C3 自己那条查询 | 读 `pg_roles` | **否** | `has_table_privilege('pg_roles','SELECT') = true` |

补一条更强的证据：本地每天的 `pnpm db:migrate` / `pnpm db:seed` 就是**这条非超级用户角色在跑**，
两道闸门每次都过。所以这不是「推断可行」，是「一直在这么跑」。

本地 `pnpm db:check` 的 C3 此刻也是绿的：

```text
[ ok ] C3 current_database=dev_matternest current_user=dev_matternest rolsuper=false
```

## 那到底什么需要权限

需要权限的只有一件事：**建对象**。

- `CREATE SCHEMA IF NOT EXISTS drizzle`（drizzle migrator）⇒ 需要库级 `CREATE`。
- 34 张业务表的 `CREATE TABLE` / `ALTER` / `CREATE INDEX` ⇒ 需要 `public` 上的 `CREATE` + `USAGE`。
- seed 的 `INSERT`、冒烟的写操作 ⇒ 需要对象上的 DML；这些对象若是自己建的，天然全有。

`MN_DB_CONFIRM`、advisory lock、读系统目录 —— **一条权限都不需要**。

## 形状里的一处不确定，不能假设

PG 15+ 新建库的 `public` schema 属主本应是伪角色 `pg_database_owner`（oid 6171，它隐式跟随**库属主**）。
但本地这个库的 `public` 属主是**真角色** `dev_matternest`（oid 535384）—— 说明有人显式改过。

⇒ **不能假设「把库属主转给新角色，`public` 的 CREATE 权限就自动跟着走」。** 那是 PG15+ 的默认语义，
而本地这个实例不符合它。CI 的 `postgres:16-alpine` 到底给不给 `pg_database_owner`，得实测；
稳妥做法是 `ALTER SCHEMA public OWNER TO …` 显式写出来，不依赖默认。

## 要人拍的三点

调研到此为止，下面是取舍，不是事实问题。

1. **CI 里那条超级用户角色还会不会留着？**
   一定会 —— 镜像的 `POSTGRES_USER` 必须是超级用户，否则它自己起不来，而它是**唯一**能 `CREATE ROLE` 的入口。
   要拍的是：这条超级用户只在**建库 + 建角色那一步**用（该 step 单独覆盖 `PGUSER`），之后的
   迁移 / seed / dev server / db:check / 冒烟**全部**换成非超级用户角色？还是别的切法。

2. **新角色要不要当库属主？**
   - 当属主（`ALTER DATABASE … OWNER TO mn_app` + `ALTER SCHEMA public OWNER TO mn_app`）：
     与本地姿态**逐字一致**，权限集自动成立，改动最少。代价：该角色能 `DROP DATABASE`。
   - 不当属主，逐条 `GRANT`：能防 `DROP DATABASE`。代价：授权集要自己维护，
     且 PG15+ `public` 的 `CREATE` 得显式给，稍有遗漏就在 CI 上表现为一条与真因无关的权限错。

   本仓的 C3 只禁 `rolsuper`，**不**禁「拥有自己的库」。所以当属主是合规的；
   但「能删库」是不是可接受，是产品判断不是技术判断。

3. **要不要顺手把 C3 扩到 `rolcreatedb`？**
   本地那条角色 `rolcreatedb=true`（大概率是历史遗留，没人需要它）。扩了它就得改本地与 CI 两边。
   本轮**建议不扩** —— 先解 CI 的红，扩 C3 是另一件事。