import type { FormInstance, FormRule as Rule } from "antd";
import { z } from "zod";

/**
 * Zod → antd `Form` rules 的适配器。**不是第二套校验**：规则从 schema 里读，
 * 提交时仍用同一个 schema `parse` 一遍（antd 的 rules 只负责即时提示）。
 *
 * 为什么必须有这层：禁令⑧ 要求校验规则单源。直接在组件里手写
 * `rules={[{required:true,max:200}]}` 就会长出两份规则——前端说 200、
 * `matterCreateSchema` 说另一个数、DB 的 `varchar` 再说第三个数，
 * 这类"两份实现"在本仓已经因枚举、CHECK、locale 各翻过一次车。
 *
 * 只映射**验过能稳定拿到**的四类（Zod 4 的内部形状是 `check._zod.def`，
 * 不是 `_def.checks`，也不是 `_def.check`——`_def` 在这版上不存在，实测撞过）：
 *   · 必填 ← `!isOptional()`
 *   · 长度上下界 ← `{check:"min_length"|"max_length", minimum|maximum}`
 *   · 枚举 ← `ZodEnum.options`
 *   · 服务端回传字段错误 ← `applyServerIssues`
 * **正则不映射**：Zod 4 的 `pattern` 内部是个包装对象而不是 RegExp，
 * 拿不准就不猜——那类字段交给提交时的 `schema.parse` 兜，
 * 表现是"点提交才提示"，而不是"前端提示了但后端仍然拒"（后者才是真麻烦）。
 */
type ZodLike = { check?: string; minimum?: number; maximum?: number };

export function rulesFor(schema: z.ZodTypeAny, path: (string | number)[]): Rule[] {
  const found = dig(schema, path);
  if (!found) return [];
  const v = unwrap(found);
  const rules: Rule[] = [];

  if (!found.isOptional() && !found.isNullable()) rules.push({ required: true });

  for (const raw of checksOf(v)) {
    const def = (raw as { _zod?: { def?: ZodLike } })?._zod?.def;
    if (!def) continue;
    if (def.check === "min_length" && typeof def.minimum === "number") {
      rules.push({ min: def.minimum, message: `至少 ${def.minimum} 个字符` });
    }
    if (def.check === "max_length" && typeof def.maximum === "number") {
      rules.push({ max: def.maximum, message: `最多 ${def.maximum} 个字符` });
    }
  }

  if (v instanceof z.ZodEnum) {
    const allowed = v.options as string[];
    rules.push({
      validator: (_r, value) =>
        value === undefined || value === "" || allowed.includes(String(value))
          ? Promise.resolve()
          : Promise.reject(new Error(`取值只能是：${allowed.join(" / ")}`)),
    });
  }

  return rules;
}

/**
 * 剥掉 optional / nullable / default 包装，拿到真正的类型节点。
 *
 * ⚠ 必须按**类型判断**，不能"只要有 `unwrap()` 就一直剥"：
 * 实测 `ZodArray` 上也有 `unwrap()`（它剥到 element），
 * 于是 `["parties", 0, "name"]` 这种路径会在第一步就把数组剥成对象，
 * 下一步拿 `shape[0]` 得到 undefined——适配器静默返回空规则，
 * 表单就变成"没有 required"。这种错不会报错，只会让必填项可以空着提交。
 */
function unwrap(node: z.ZodTypeAny): z.ZodTypeAny {
  let cur: unknown = node;
  while (
    cur instanceof z.ZodOptional ||
    cur instanceof z.ZodNullable ||
    cur instanceof z.ZodDefault
  ) {
    cur = (cur as unknown as { unwrap(): z.ZodTypeAny }).unwrap();
  }
  return cur as z.ZodTypeAny;
}

function checksOf(node: z.ZodTypeAny): unknown[] {
  const list = (node as unknown as { _zod?: { def?: { checks?: unknown[] } } })?._zod?.def?.checks;
  return Array.isArray(list) ? list : [];
}

/** 按路径走到目标字段；走不通返回 undefined，调用方据此什么都不加（不猜规则） */
function dig(schema: z.ZodTypeAny, path: (string | number)[]): z.ZodTypeAny | undefined {
  let cur: unknown = schema;
  for (const key of path) {
    const node = unwrap(cur as z.ZodTypeAny);
    const def = (node as unknown as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;
    if (def?.type === "object") {
      const shape = def.shape as Record<string, z.ZodTypeAny> | undefined;
      cur = shape?.[String(key)];
    } else if (def?.type === "array" && (key === "number" || typeof key === "number")) {
      cur =
        (node as unknown as { element?: z.ZodTypeAny }).element ??
        (def as { element?: z.ZodTypeAny }).element;
    } else {
      return undefined;
    }
    if (!cur) return undefined;
  }
  return cur as z.ZodTypeAny;
}

/**
 * schema / 服务端 的字段错误 → antd 表单。
 *
 * 三个对话框都用它，所以那个 `as never` 只出现在这一处：antd 的 `FormInstance<T>` 把
 * `name` 收成 `T` 的字面量联合，而这里是**运行时**才知道的路径数组，类型上对不上但语义正确。
 * 写在调用方就会变成三处各 cast 一次，那种"到处 `as`"才是真难查。
 */
export function setFieldErrors(
  form: FormInstance,
  issues: readonly { path: readonly PropertyKey[] | string; message: string }[],
) {
  const names = issues.map(
    (i) =>
      (typeof i.path === "string"
        ? i.path.split(".").map(seg)
        : i.path.map((p) => seg(String(p)))) as never,
  );
  form.setFields(issues.map((i, n) => ({ name: names[n], errors: [i.message] })) as never);
  // 服务端打回来的错误常常在视口外（转案件一屏 10+ 项），标红了也等于没发生：
  // 把人带到第一个出错的字段上。客户端校验失败那条路径由 Form 的 scrollToFirstError 负责。
  if (names.length > 0) form.scrollToField(names[0], { block: "center", behavior: "smooth" });
}

/** DTO 路径段：数字段要转回来，`parties.0.name` 才指得到那一条当事人 */
const seg = (p: string | number) => (typeof p === "number" ? p : /^\d+$/.test(p) ? Number(p) : p);

/**
 * 服务端 `ApiFailure.issues` → antd 字段错误。
 * path 是 DTO 字段名（`http.ts` 里组好的点号串），所以能直接标到字段上，
 * 不需要把后端的文案在前端再抄一份。
 */
export function applyServerIssues(
  form: FormInstance,
  issues?: { path: string; message: string }[],
) {
  if (!issues?.length) return;
  setFieldErrors(form, issues);
}
