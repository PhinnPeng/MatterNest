# MATT-78 节点到期提醒：等值判定改区间判定（补发窗口 K=3）

> Paca #78（T4g）。反向红 + 实现 + 自检。**不**改调度器（属 MATT-74）、**不**碰规则 9 的参数、`dedupe.ts` 的函数构造一个字不动。

## 一、需求

`src/shared/notification/scan.ts:81` 今天是**等值判定**：

```ts
const hit = [...new Set(node.remindDays)].filter((d) => d === daysLeft).sort((a, b) => a - b);
```

⇒ 必须**恰好**在 `daysLeft === d` 的那一天跑扫描，否则该档永久丢失。触发面 = 定时器还没上线 / 停机 / 没人打开通知页（扫描挂在读请求上）。

**产品裁定 = (a) 改成区间判定，K = 3 天**（产品裁定，不是技术决定）。

### 窗口方向的裁定（票面 `[remindDay, remindDay+K)` 是笔误，按下面读）

**往 `daysLeft` 更小的一侧扩（补发），不是更大的一侧**：

```
命中条件 = d - K < daysLeft <= d        // K = 3 ⇒ daysLeft ∈ {d, d-1, d-2}
```

三条理由（都要落进代码注释）：

1. `daysLeft` 随日子**递减**（`businessDaysBetween(now, deadline)`；`daysLeft < 0` = 已过期 ⇒ 不算）。今天没人打开页面 / 停机跨过那一档，恢复时 `daysLeft` **已经小于 d**；`[d, d+K)` 那一侧不含这些值 ⇒ 一个也补不回来，等于没修（票面症状原文就是「停机跨过那一档」）。
2. 票面验收判据写的是「**跨过档位当天补跑**，仍能命中」——只有下界那一侧满足。
3. 同族先例：`docs/research-portable-scheduler.md:320,325` 把替代写法点明为 `d >= daysLeft`；规则 9（`services/archive-reminder.ts` → `judgeArchiveReminder`）也是**下界**（「14 天以后都还发」）。本票与规则 9 **同形而不同参数**：那边下界无上界，这边用 K 封顶。

⇒ 票面的窗与成本句都该按这个方向读；成本是**晚发**：最迟 `d-K+1` 天还剩时发出「还有 d 天」的提醒。

### 去重键必须同步变成「档位稳定」

区间化之后同一档位会在 `d, d-1, d-2` 三天都命中。现状 `services/notifications.ts` 用 `businessDateKey(now)`（**扫描日**）构造 `scheduledDedupeKey` ⇒ 三天三个 key ⇒ 同一条「还有 3 天」连发三条。

**做法（遵守票面边界）**：在 `scan.ts` 新增导出的纯函数 `scanDueDateKey(deadlineTime, remindDay)` → `${businessDateKey(deadlineTime)}#${remindDay}`；`notifications.ts` 构造 scheduled key 处改用它。**`shared/notification/dedupe.ts` 的函数构造/签名一个字不许动**（只允许改注释）。

语义变化：原来「同节点同**扫描日**一条」→ 现在「同节点同**档位**一条」。同一扫描日若同时命中两个档位（长停机后 `daysLeft` 落进两窗交叠区，如 `remindDays=[7,3,1]`、`daysLeft=1`）会出两条 —— 那是**两条不同的里程碑**，是想要的。

## 二、验收判据

- [ ] `scan.ts` 区间判定，K = 3 具名为常量（如 `SCAN_CATCHUP_DAYS`，注释写明是产品裁定）
- [ ] `notification.spec.ts` 至少三条断言：
  1. **跨过档位当天补跑仍能命中**：同一节点同一档位，`daysLeft = d` 那天没跑，改在 `d-1` / `d-2` 跑仍命中；
  2. **同一节点同一档位只发一次**：同一 (节点截止日, 档位) 在补发窗口内的不同扫描日得到**同一个** key；不同档位得到**不同** key；截止日改了得到**新** key（改期会重新提醒）；
  3. 保留并核对既有用例：`daysLeft=3, remindDays=[7,1]` 仍一条不出（`notification.spec.ts:231`）、`[3,3,1]` 仍只出一条（`:225`）。
- [ ] **反向红两次**：(i) 摘掉窗口下界的 `- K`（变纯下界）⇒ 判据 1 与 `:231` 必红；(ii) 把 key 换回 `businessDateKey(now)` ⇒ 判据 2 必红。跑完逐字节恢复（node 读写比对，不用 `git checkout`）。
- [ ] `grep` 确认没有别处在用等值判定 / 扫描日 dateKey 构造 scheduled key。
- [ ] `agent-work/verify-anchors.mjs` 与 `revred-notifications.mjs` 的锚点核对（是否需要跟着搬）。
- [ ] `pnpm verify` 全绿。
- [ ] 只动本票文件；边界见任务标题下那句。

## 三、非目标 / 边界

- 不改 `judgeArchiveReminder` 的下界口径（规则 9 参数是产品裁定，另一票）。
- 不动 `src/app/lib/server/scheduler*` / 应用内定时器调度策略（MATT-74）。
- `dedupe.ts` 只改注释。
- `daysLeft` 载荷仍是**档位值**（`{eventType, daysLeft: d}`）；补发时它是**里程碑标签**、不是精确剩余天数（最迟可能差 K-1 天）——这句写进注释，**是否改成精确值留产品裁定**。

## 四、对齐件

- `docs/PRD-phase1-design-revision-r1.md` §7.2（`dedupe_key` 的 scheduled 行 + 合并规则 4）—— 我的改动**证伪**了那里「`date_key(扫描日期)`」的写法。
- `docs/research-portable-scheduler.md` §5.1（「不会补发。错过的档位永久丢失」这句结论被本票改掉，节点提醒那一半）。
- 说明：票面第一顺位对齐件 `docs/PRD-phase1-g-targets-b5-draft.md` 是**已批准定稿**，其中与节点提醒相关的只有 G3 的度量行与规则 9 注记，**没有**描述「档位判定 / scheduled key 构造」的段落 ⇒ 写去了上面两份。
