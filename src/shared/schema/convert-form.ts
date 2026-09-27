import { z } from "zod";

/**
 * 转案件表单的**唯一**校验源（禁令⑧：react-hook-form + Zod resolver，与 `shared/schema` 同源）。
 * N7 spike 要证明的是最后那条通过标准：**错误能定位到"第几张卡、哪个字段"**。
 *
 * id 类字段一律 `string`（master P1-19 的建议口径：雪花 64 位过 `JSON.stringify` 会静默丢精度）。
 */

/** 跨卡复制的**白名单**。用白名单不用黑名单：黑名单会随字段增长而漏，白名单漏了当场就能在表单上看见。 */
export const COPYABLE_FIELDS = [
  "client_name",
  "client_role",
  "cause",
  "court",
  "amount",
  "filing_date",
  "summary",
  "tags",
] as const;

/** 明确不参与复制的字段（矩阵 §3）。这里列出来是为了让测试能断言"白名单 ∩ 黑名单 = ∅"。 */
export const NON_COPYABLE_FIELDS = ["matter_id", "node_id", "client_id"] as const;

export const caseNodeSchema = z.object({
  node_id: z.string().regex(/^\d+$/).optional(),
  name: z.string().min(1, "节点名称必填").max(40),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式应为 YYYY-MM-DD")
    .optional(),
});

export const caseCardSchema = z
  .object({
    matter_id: z.string().regex(/^\d+$/).optional(),
    client_id: z.string().regex(/^\d+$/).optional(),
    client_name: z.string().min(1, "当事人名称必填").max(50),
    client_role: z.enum(["party", "represented"]),
    cause: z.string().min(1, "案由必填").max(60),
    court: z.string().max(60).optional(),
    amount: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/, "金额最多两位小数")
      .optional(),
    filing_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式应为 YYYY-MM-DD")
      .optional(),
    summary: z.string().max(200).optional(),
    tags: z.array(z.string().min(1)).max(5).optional(),
    nodes: z.array(caseNodeSchema).min(1, "至少填一个节点"),
  })
  /** 跨字段规则：代理人角色必须已绑定当事人档案（对应权限草案 §7.2 的 `party` 跨案共享语义）。 */
  .superRefine((card, ctx) => {
    if (card.client_role === "represented" && !card.client_id) {
      ctx.addIssue({
        code: "custom",
        path: ["client_id"],
        message: "选择「代理人」时必须先选定当事人档案",
      });
    }
  });

export const convertFormSchema = z
  .object({
    risk_matter_id: z.string().regex(/^\d+$/),
    cases: z.array(caseCardSchema).min(1, "至少建一个案件").max(20, "一次最多转 20 个案件"),
  })
  /** 跨卡规则：同一批里案由+当事人不能重复（矩阵 §2 的实际约束）。 */
  .superRefine((form, ctx) => {
    const seen = new Map<string, number>();
    form.cases.forEach((c, i) => {
      const key = `${c.client_name}|${c.cause}`;
      const first = seen.get(key);
      if (first !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["cases", i, "cause"],
          message: `与第 ${first + 1} 张卡重复（当事人 + 案由相同）`,
        });
      } else {
        seen.set(key, i);
      }
    });
  });

export type ConvertForm = z.infer<typeof convertFormSchema>;
export type CaseCard = z.infer<typeof caseCardSchema>;

/** 字段中文名——**从 shared 出**，组件里不得再写一份（禁令⑧ / 枚举表 §5.1）。 */
export const CASE_FIELD_LABELS: Record<string, string> = {
  matter_id: "案件编号",
  client_id: "当事人档案",
  client_name: "当事人名称",
  client_role: "当事人角色",
  cause: "案由",
  court: "受理法院",
  amount: "标的金额",
  filing_date: "立案日期",
  summary: "案件摘要",
  tags: "标签",
  nodes: "节点",
  name: "节点名称",
  due_date: "节点期限",
  risk_matter_id: "来源事项",
  cases: "案件卡片",
};

/**
 * Zod 的 `issue.path`（如 `["cases", 2, "client_name"]`）→ 人话（「第 3 张卡 · 当事人名称」）。
 *
 * 这层映射就是 N7 通过标准的实现，**所以它自己要有测试**：索引 +1（人从 1 数起）、
 * 数组下标只出现在 `cases` 之后、未知字段名回退成原 key 而不是抛错。
 */
export function describeIssuePath(path: readonly PropertyKey[]): string {
  const parts: string[] = [];
  let cardIndex: number | undefined;

  for (let i = 0; i < path.length; i += 1) {
    const seg = path[i];
    if (typeof seg !== "string" && typeof seg !== "number") continue; // symbol 等异常段不进文案

    if (seg === "cases") {
      const next = path[i + 1];
      if (typeof next === "number") {
        cardIndex = next + 1;
        i += 1; // 数组下标已消费，不再单独展示
        continue;
      }
    }
    if (typeof seg === "number") continue; // 其它数组下标（如 nodes 的第几项）不进文案
    parts.push(CASE_FIELD_LABELS[seg] ?? seg);
  }

  const tail = parts.join(" · ") || "表单";
  return cardIndex === undefined ? tail : `第 ${cardIndex} 张卡 · ${tail}`;
}

/** 校验失败时的可读清单，直接喂给表单顶部的汇总区。 */
export function summarizeIssues(issues: readonly z.ZodIssue[]): string[] {
  return issues.map((i) => `${describeIssuePath(i.path)}：${i.message}`);
}

/**
 * 跨卡复制：只复制白名单字段，id 类与派生字段一律不带（矩阵 §3）。
 * 写成函数而不是"在组件里 spread 一下"，是为了让"复制不带走 id"可测。
 */
export function copyCardOnto(source: CaseCard, target: CaseCard): CaseCard {
  const picked: Partial<CaseCard> = {};
  for (const f of COPYABLE_FIELDS) {
    const key = f as keyof CaseCard;
    Object.assign(picked, { [key]: source[key] });
  }
  return { ...target, ...picked };
}
