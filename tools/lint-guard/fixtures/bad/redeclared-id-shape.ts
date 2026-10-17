/**
 * 故意写坏：19 位 id 上界与 bigint 转换被抄到了第二处。
 * check.mjs 会以 `src/app/api/` 下的虚拟路径喂给仓库 config，断言**两处**都被拦。
 *
 * 为什么这是个真问题：`error-handling.md` 要求 `BigInt(路径参数)` 之前必过
 * `http.ts:pathId()`（`BigInt("undefined")` 抛 SyntaxError 会冒成 500），
 * 而"19 位"这个上界一旦出现第二份，两份就会各自演化 —— 实测来源是一次
 * watch 路由把这份正则又抄了一遍、并按自造的 `bad_target` 报错，
 * 同一个错误因此在两条路由上报出两个码。
 *
 * ⚠ 形状刻意是**单个 id**（`.regex(...)` 直接挂在 `z.string()` 上）而不是数组：
 * `z.array(z.string().regex(/^\d{1,19}$/))` 是 body 里 id 数组的**合法**写法
 * （`shared/schema/batch.ts` 专门写了理由），被规则放过 —— 那个形状见 good fixture。
 *
 * ⚠ 同样不许出现色值字面量或 `fail(404, …)`：计数按 ruleId 过滤。
 */
declare const z: {
  string(): { regex(re: RegExp): unknown };
  object(shape: Record<string, unknown>): unknown;
};

export const targetSchema = z.object({
  targetId: z.string().regex(/^\d{1,19}$/), // 1/2 路径参数却自带 id 形态
});

export function isNumericId(raw: string): boolean {
  return /^\d{1,19}$/.test(raw); // 2/2 裸的 .test()，同样绕开了 pathId()
}
