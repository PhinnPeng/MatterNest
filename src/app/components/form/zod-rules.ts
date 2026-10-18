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
 *
 * 另有两个**同源取值**（不是第二套规则，是同一约束喂给另一种机制）：
 *   · `maxLengthOf` —— 喂 `<Input maxLength>`（拦在键入时，`rulesFor` 管不到）；
 *   · `numberBoundsOf` —— 喂 `<InputNumber min/max>`（数字边界，`rulesFor` 只管长度）。
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
 * 取一个字段的**字符数上界**（`max_length`），没有则 `undefined`。
 *
 * 为什么除了 `rulesFor` 还要它：两者是**同一件约束在两个时机上**的执行 ——
 * `rulesFor` 给 antd 的 `{max}` 规则（提交/失焦时提示），`maxLength` 是输入框属性
 * （**拦在键入时**，用户多打一个字都进不去）。既然约束只有一个来源（禁令⑧），
 * 这个数也得从 schema 读，不能在 JSX 里写第二份。
 *
 * 实测代价（2026-10-18 复核）：`config-kind-view.tsx` 曾把 `maxLength={50}`、
 * `{32}`、`{20}` 手写在三处；`matter-create-dialog.tsx` 的 `maxLength={5000}`
 * 也是手抄 schema 的 `max(5000)`。schema 改字长时，这些抄写会留下一个
 * **更宽或更窄的输入框**，而它不报错 —— 只是允许用户打进一个提交必被拒的值。
 *
 * 读的是与 `rulesFor` 同一份内部形状（共用 `dig` / `unwrap` / `checksOf`），
 * 分开实现迟早有一处跟不上。
 */
export function maxLengthOf(schema: z.ZodTypeAny, path: (string | number)[]): number | undefined {
  const found = dig(schema, path);
  if (!found) return undefined;
  for (const raw of checksOf(unwrap(found))) {
    const def = (raw as { _zod?: { def?: ZodLike } })?._zod?.def;
    if (def?.check === "max_length" && typeof def.maximum === "number") return def.maximum;
  }
  return undefined;
}

/**
 * 取一个**数字**字段的上下界（`greater_than` / `less_than`）。
 *
 * 与字符串的 `min_length`/`max_length` 是**两套** check：`z.number().min(0)` 落成
 * `{check:"greater_than", value:0, inclusive:true}`，而 `rulesFor` 只管长度 ——
 * 所以数字边界此前只能由页面手写（`config-kind-view` 的 `min={0} max={9999}` 就是）。
 *
 * 排他边界（`inclusive:false`）**返回 undefined 而不是硬凑 ±1**：那是猜，
 * 与"正则不映射"同一条纪律 —— 拿不准就交给提交时的 `safeParse` 兜。
 */
export function numberBoundsOf(
  schema: z.ZodTypeAny,
  path: (string | number)[],
): { min?: number; max?: number } {
  const found = dig(schema, path);
  if (!found) return {};
  const out: { min?: number; max?: number } = {};
  for (const raw of checksOf(unwrap(found))) {
    const def = (raw as { _zod?: { def?: ZodLike & { value?: number; inclusive?: boolean } } })
      ?._zod?.def;
    if (!def || def.inclusive !== true || typeof def.value !== "number") continue;
    if (def.check === "greater_than") out.min = def.value;
    if (def.check === "less_than") out.max = def.value;
  }
  return out;
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

/**
 * 客户端校验失败 → 把**焦点**送到第一个出错字段（MATT-33）。
 *
 * ## 为什么不能只靠 `Form` 的 `scrollToFirstError`
 *
 * 它**只滚不聚焦**。实测（真 Chromium，1366×768，空表单提交建事项弹窗）：
 * 首错「事项名称」已标红、也在视口内，但 `document.activeElement` 仍是那个提交按钮。
 * 键盘用户因此要多按一串 Tab 才能走到该改的框——「错误在视口外等于点了没反应」
 * 这句话的另一半正是"焦点没过去，键盘用户不知道错在哪"。
 *
 * ## 为什么取 `errorFields[0].name` 而不自己扫 DOM
 *
 * antd 已经把"第一个错"算好了，顺序就是字段注册顺序（与视觉顺序一致）。
 * 自己扫 `.ant-form-item-has-error` 等于把同一件事算第二遍，还会与
 * `scrollToFirstError` 的选择打架。
 *
 * `focus` 选项是真实存在的（读过实现：`scrollToField` 里 `if (focus) wrapForm.focusField(name)`），
 * 不是猜的。
 */
export function focusFirstError(
  form: FormInstance,
  errorFields?: readonly { name?: unknown }[] | null,
) {
  const first = errorFields?.[0]?.name;
  if (!first) return;
  form.scrollToField(first as never, { focus: true, block: "center", behavior: "smooth" });
}

/**
 * `validateFields()` 的失败收口：**取回第一个错字段并聚焦**，再返回 null 让调用方早退。
 *
 * 三个弹窗原先都写 `.catch(() => null)` —— 错误对象被丢掉，于是只剩 antd 的自动滚动。
 * 收成一个助手，是因为"漏掉聚焦"这件事在三个地方各写一遍就会各漏一遍。
 */
export async function validateAndFocusFirst<T>(form: FormInstance<T>): Promise<T | null> {
  try {
    return await form.validateFields();
  } catch (e) {
    focusFirstError(form, (e as { errorFields?: { name?: unknown }[] })?.errorFields);
    return null;
  }
}
