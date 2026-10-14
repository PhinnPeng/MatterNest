import { describe, expect, it } from "vitest";
import { createPumpGate } from "./pump-gate";

/**
 * 进程内单飞的形态（MATT-74 前置件 4）。
 *
 * ## 为什么这条必须钉住
 *
 * 单飞有三种写法，它们的**失败形态完全不同**，而其中两种会静默改变读驱动的语义：
 *
 * | 形态 | 并发时调用者拿到什么 |
 * |---|---|
 * | 跳过 | 什么都不跑 |
 * | 合并进在飞的那一次 | 早于它到达的那一次的结果 |
 * | **排队（本实现）** | 属于它自己的、起点晚于它到达的一次 |
 *
 * 前两种会让「打开通知中心 ⇒ 一定跑过一次完整 pump」变成「可能没跑」，
 * 而这条语义是 `agent-work/smoke-notifications.mjs:363-379` 逐字依赖的东西
 * ——被跳过的那次 GET 会让「转案件后事件数=1」偶发变红，而代码完全正确。
 * 所以这里的断言盯的不是「跑得快不快」，而是**每一次调用都真的跑了**。
 *
 * 串行性是靠 `Promise.all` 三次同时调用测的：`max` 恒为 1 才是单飞，
 * 而 `[1,2,3]` 说明三次调用各拿到自己的那一次（不是共享一个结果）。
 */
describe("进程内单飞（排队，不是跳过）", () => {
  it("三次并发调用 = 三次真 pump，但**从不并发**（最大并发恒为 1）", async () => {
    let inFlight = 0;
    let max = 0;
    let runs = 0;
    const gate = createPumpGate(async () => {
      runs += 1;
      inFlight += 1;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return runs;
    });

    const results = await Promise.all([gate("read"), gate("read"), gate("read")]);

    expect(max).toBe(1);
    expect(runs).toBe(3);
    // 每个调用者拿到**属于自己**的那一次（跳过/合并都拿不到这个序列）
    expect(results).toEqual([1, 2, 3]);
  });

  it("前一次失败不影响后面：失败原样交给它的调用者，链继续", async () => {
    let n = 0;
    const gate = createPumpGate(async () => {
      n += 1;
      if (n === 1) throw new Error("boom-1");
      return n;
    });

    // 失败**不吞**（读驱动那条要靠它决定这次 GET 的成败）
    await expect(gate("read")).rejects.toThrow("boom-1");
    // 也不把队列卡死（下一次照样跑，且拿到 n=2）
    await expect(gate("read")).resolves.toBe(2);
  });

  it("并发调用者里第二个起就有排队日志，且日志说得清**是谁**在排队", async () => {
    const lines: string[] = [];
    const spy = (msg: unknown) => {
      if (typeof msg === "string" && msg.startsWith("[pump]")) lines.push(msg);
    };
    const orig = console.info;
    console.info = spy as typeof console.info;
    try {
      const gate = createPumpGate(async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
      await Promise.all([gate("read"), gate("timer")]);
    } finally {
      console.info = orig;
    }
    // 第二条是定时器那一份：压测要证的正是「定时器被排在读驱动之后」，
    // 所以标签必须在日志里（没有标签的话 12 个并发读请求自己也会排队）
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("timer 这一次排在其后");
  });

  it("**单飞状态挂在 `globalThis` 上** —— Next 给 instrumentation 与路由各一份模块实例", async () => {
    /**
     * ## 这条断言为什么写成"直接查 globalThis"
     *
     * 本轮实测：定时器那一份与读驱动那一份是**同一个 pid、两个模块实例**
     * （`pid=61764 inst=w8yu9` vs `inst=gpra6`），所以模块级 `let tail/pending`
     * 各有一份，单飞跨不过它们 —— 而那是**静默失效**：日志里没有排队行，一切看起来正常。
     * 运行时证据在 `agent-work/probe-matt74-concurrency.mjs`
     * （它断言窗口里出现 `[pump] timer 这一次排在其后`）。
     *
     * ⚠ **这条断言的第一版是假绿**：原本写成「两个 `createPumpGate` 实例共用同一条链」，
     * 而反向红（把状态退回模块级 `let`）时它**照样绿** —— 因为两个 gate 都在**同一个模块实例**里，
     * 模块级 `let` 本来就是共享的。假绿比漏报更坏，所以改成直接断言那个**唯一的、
     * 跨模块实例可达的**落点：`globalThis` 上的键。
     */
    const gate = createPumpGate(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return "ok";
    });
    const running = gate("read");
    const state = (globalThis as typeof globalThis & { __matternest_pump_gate__?: unknown })
      .__matternest_pump_gate__ as { pending?: number } | undefined;
    expect(state, "状态不在 globalThis 上 ⇒ 换回模块级 let 了（单飞跨不过模块实例）").toBeDefined();
    expect(state?.pending).toBe(1);
    await expect(running).resolves.toBe("ok");
    expect(state?.pending).toBe(0);
  });
});
