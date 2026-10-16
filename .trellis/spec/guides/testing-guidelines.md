# Testing Guidelines

> 测试模式来自当前 `*.spec.ts` 实现（vitest 5）。来源：`src/app/lib/server/services/nodes.spec.ts`、`src/app/lib/server/scope/guards.spec.ts`、`src/app/components/form/zod-rules.spec.ts`、`src/shared/time/zh-cn.spec.ts`。

---

## 放置与命名

- 就近放置：`foo.ts` 旁边的 `foo.spec.ts`，同目录、同名。
- vitest 直接 import：`import { describe, expect, it } from "vitest"`。
- 运行：`pnpm test`（`vitest run`）；全量门禁 `pnpm verify`。

## 写法口径（从现有 spec 归纳）

1. **describe 名带上被测函数与它盯住的业务问题**，例如 `describe("guards/ownsAttribution：护栏 1 的主体判定")`。
2. **每条 it 的名字写成「期望 — 反例事故」**：点出「若漏判会怎样」。如「停用的类型不生成，即使它勾了预设」。
3. **造数函数集中在文件顶部**（`typeRow(over)`），只声明被测路径用得上的字段，其余用默认值填满，`Partial<T> & 必填键`。
4. **断言整体形状** `expect(x.map(...)).toEqual([...])`，不要逐条下标索引——`noUncheckedIndexedAccess` 下 `arr[1]` 是 `| undefined`，撒 `!` 会掩盖「少了一行」的失败。
5. **该钉的反向一个都不许省**：化简（如 `coOccurred ?? false`、`presetOnCreate=false`、停用类型、`bigint/string` 混用）必须逐个有用例，只看「每种范围一个」视为没覆盖。
6. 回归用例在注释里写明对应事故（「这条就是 §2.2 存在的理由」式）。
7. **「刻意豁免」也要有断言，而且断言的是说明不是行为**：某条路径**不加**校验/门是裁定过的（如 `risks.spec.ts` 里「标签路径不被冻结门拦住」），那就同时钉住两件事 —— ① 它确实没被拦住（防有人顺手加）；② 说明还在、且写清了理由（防有人顺手把注释抄走或删掉：门还是没加、行为不变，但「为什么不加」没了，下一个人再也分不清「刻意豁免」与「忘了加」）。判据取注释里的关键词与理由线（`risks.spec.ts:378-401` 是样板）。

## 不测的

- 不打真实 DB / 真实 Next 请求的集成测试目前不在本仓模式内（DB 行为靠 drizzle schema + `client.spec.ts` / `enum-check.spec.ts` 这类离线断言覆盖）。新增模式需先在 PRD/任务里裁定。
- 快照测试未使用；断言一律显式。
