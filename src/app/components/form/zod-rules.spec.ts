import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { FormInstance, FormRule as Rule } from "antd";

import { rulesFor, setFieldErrors } from "./zod-rules";
import { matterCreateSchema } from "@/shared/schema/hosts";

/**
 * 适配器守卫：证明"antd 表单的规则是从 Zod 读的"，而不是看起来像。
 *
 * 断言用**真实业务 schema**（`matterCreateSchema`），因为它才是会被改的那一份：
 * 有人在 schema 上把 max 从 200 改成 500，这里不会红，但表单立刻跟着变——那正是要的行为。
 *
 * `pick` 的 cast 只出现在测试里：antd 的 `Rule` 是"对象形态 | 函数形态"的联合，
 * 读字段要收窄一次。生产侧保持返回 `Rule[]`，否则每个调用方都要 cast。
 */
type Loose = { required?: boolean; min?: number; max?: number; validator?: unknown };
const pick = (rules: Rule[]): Loose[] => rules as Loose[];

describe("rulesFor：Zod → antd rules", () => {
  it("字符串的必填与长度上下界都从 schema 来", () => {
    const r = pick(rulesFor(matterCreateSchema, ["name"]));
    expect(r.some((x) => x.required)).toBe(true);
    expect(r.find((x) => x.min !== undefined)?.min).toBe(2);
    expect(r.find((x) => x.max !== undefined)?.max).toBe(200);
  });

  it("枚举给一条 validator（值不在值域里就报，值域取自 schema）", () => {
    const r = pick(rulesFor(matterCreateSchema, ["caseType"]));
    expect(r.some((x) => x.required)).toBe(true);
    expect(r.some((x) => typeof x.validator === "function")).toBe(true);
  });

  it("数组元素路径走得通（当事人名称的必填靠它）", () => {
    const s = z.object({
      rows: z.array(z.object({ name: z.string().min(2).max(200) })).default([]),
    });
    const r = pick(rulesFor(s, ["rows", 0, "name"]));
    expect(r.some((x) => x.required)).toBe(true);
    expect(r.find((x) => x.min !== undefined)?.min).toBe(2);
  });

  it("选填字段不推 required；路径走不通时返回空而不是猜规则", () => {
    expect(pick(rulesFor(matterCreateSchema, ["court"])).some((x) => x.required)).toBe(false);
    expect(rulesFor(matterCreateSchema, ["不存在", "也没有"])).toEqual([]);
  });

  it("unwrap 只剥 optional/nullable/default（ZodArray 也有 unwrap()，多剥一层会静默丢规则）", () => {
    // 回归：曾经写成"只要有 unwrap() 就一直剥"，于是 `rows[0].name` 的必填静默没了
    const s = z.object({ rows: z.array(z.object({ v: z.string().min(1) })).default([]) });
    expect(pick(rulesFor(s, ["rows", 0, "v"])).some((x) => x.required)).toBe(true);
  });
});

/**
 * 服务端错误的落点。
 *
 * 这里用假 form 而不是 `Form.useForm()`：要钉的是**调用形状**——
 * 路径必须是数组（数字段要转回 number，否则 `parties.0.name` 指不到那一条），
 * 且第一个错误必须被滚过去（错误在视口外＝标红了也没人看见）。
 */
describe("setFieldErrors：服务端 fieldIssues → 字段 + 定位", () => {
  const fakeForm = () => {
    const calls: { set: unknown[]; scroll: unknown[][] } = { set: [], scroll: [] };
    const form = {
      setFields: (f: unknown[]) => calls.set.push(...f),
      scrollToField: (...a: unknown[]) => calls.scroll.push(a),
    };
    return { form: form as unknown as FormInstance, calls };
  };

  it("点号路径拆成数组，数字段转回 number", () => {
    const { form, calls } = fakeForm();
    setFieldErrors(form, [{ path: "parties.0.client_name", message: "不能为空" }]);
    expect(calls.set[0]).toMatchObject({ name: ["parties", 0, "client_name"] });
  });

  it("滚到第一个错误字段（多个 issue 时只滚第一个）", () => {
    const { form, calls } = fakeForm();
    setFieldErrors(form, [
      { path: ["name"], message: "太短" },
      { path: "amount", message: "不是数字" },
    ]);
    expect(calls.scroll).toHaveLength(1);
    expect(calls.scroll[0]?.[0]).toEqual(["name"]);
  });

  it("没有 issue 时既不清空也不乱滚", () => {
    const { form, calls } = fakeForm();
    setFieldErrors(form, []);
    expect(calls.set).toHaveLength(0);
    expect(calls.scroll).toHaveLength(0);
  });
});
