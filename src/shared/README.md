# src/shared

前后端唯一共用层，**纯 TS**（禁令①）：不得 import `next/*`、`react`、Node API，也不得反向依赖 `app/`。
这条约束由 `eslint.config.mjs` 挂载，并由 `tools/lint-guard/check.mjs` 每跑一次 `pnpm verify` 就证伪一次。

子目录与出处：

| 目录      | 放什么                                         | 规格件                    |
| --------- | ---------------------------------------------- | ------------------------- |
| `enums/`  | E01–E37：TS 联合类型 + 值数组 + 中文名字典     | 枚举表 §5.1               |
| `schema/` | Zod schema，DTO 与表单校验的**唯一**来源       | 枚举表 §5.1、禁令⑧        |
| `ids/`    | 雪花生成（`bigint`，DTO 层出 string 见 P1-19） | 技术选型 §2、修订稿 §12.2 |
| `time/`   | 期限计算、`date` 与 `timestamptz` 边界         | 修订稿 §12.2/§12.3        |
| `crypto/` | AES-GCM 字段加密 + HMAC 索引列                 | 技术选型 §4、修订稿 §6.3  |

`enums/` 已落地（W0-3，2026-09-27）：分册 `targets / status / business / notify / auth / audit / automation`

- `index.ts`（`ENUM_REGISTRY`，E01–E37 逐行登记，含三行"本就不是枚举"的占位）。
  **一致性测试不在这里** —— 它要读迁移 SQL 与文档，得用 `node:fs`，而本层禁止 Node API，
  故落在 `src/app/lib/server/db/enum-check.spec.ts`。W1-7 落 `schema/`。
