# Form Guidelines

> 前端表单（弹窗/动态表单）的统一写法。来源代码：`src/app/components/form/zod-rules.ts`、`src/app/(desk)/matters/matter-create-dialog.tsx`、`risk-create-dialog.tsx`、`convert-dialog.tsx`、`status-dialog.tsx`、`src/shared/schema/*`。

---

## 校验规则单源（禁令⑧ 的落点）

- 校验规则只定义在 `src/shared/schema/*.ts` 的 Zod schema 里；组件**不许**手写 `rules={[{required:true,max:200}]}` 第二份。
- antd `Form.Item` 的 `rules` 由 `rulesFor(schema, [path...])` 从同一份 schema 推导，antd rules 只负责即时提示；提交时仍用同一 schema `parse` 一遍。
- `Form.Item` 的 `name` 必须与 Zod schema 的 key 一致；数组字段用 `[index, 'field']` 路径（`zod-rules.spec.ts` 的数组路径回归即此约束）。
- 服务端打回的字段错误走 `applyServerIssues(form, issues)` → `form.setFields` 标红 + `scrollToField` 定位到第一个出错字段；文案不在前端抄第二份。

## 适配器边界（`zod-rules.ts` 的实测约束）

- 只映射四类：必填（`!isOptional()`）、长度上/下限、枚举（`ZodEnum.options`）、服务端 issues。
- **正则不映射**——Zod 4 的 `pattern` 是包装对象，拿不准就不猜；交给提交时 `schema.parse` 兜底，表现成「晚一点提示」而不是「前端过了后端拒」。
- `unwrap()` 剥 optional/nullable/default 必须按**类型判断**剥，不能无脑 unwrap（`ZodArray` 也有 `unwrap()`，会把数组剥成 element，路径断掉，规则静默为空）。
- Zod 4 内部形状是 `check._zod.def`，不是 `_def.checks`；踩过则详见文件头注释。

## 提交与值转换

- 日期字段表单里是 `Dayjs`，**提交前一处转 `YYYY-MM-DD`**（各弹窗的 `toValues()`），不在多处各自格式化。
- 枚举展示/选项来自 `src/shared/enums/<file>.ts` 或 `/api/meta`，组件里不写第二份字典。
- 跨卡复制（转案件动态表单）用白名单 `COPYABLE_FIELDS`，`COPYABLE ∩ NON_COPYABLE = ∅` 有断言。

## 禁止项

- 引入 `react-hook-form` / `pro-components` 写表单（禁令⑦，peer 不兼容 antd 6）。
- 在 Server Component 里放 antd 表单组件（全部 hook，SSR 抛）。
- 表单里发明新的错误文案格式；服务端 `issues[].path` 与 DTO 字段名对齐后直接落字段。
