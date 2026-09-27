"use client";

import { useId, type ReactNode } from "react";
import { Controller, type Control, type FieldValues, type Path } from "react-hook-form";
import { cn } from "cn";

import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Textarea } from "@/app/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";

/**
 * 表单字段的**唯一**形状（禁令⑦：一套组件体系）。
 *
 * 三条约束都不是审美：
 *   · `htmlFor`/`id` 由 `useId()` 生成并写进 aria —— 手写的 id 在同一页面渲染两次（列表+新建对话框）
 *     会撞成"点标签聚焦到别的那个框"，这是最难复现的一类可访问性 bug；
 *   · 错误信息挂在控件旁边而不是 toast：用户要能看清**哪个**字段错了；
 *   · Select 用哨兵字符串表示"未选"：radix 的 Select 不接受 `value=""`（空串是保留值，
 *     传了会在控制台每次渲染都告警），所以这里统一把空转成 `__none__`。
 */

export const UNSET = "__unset__";

export function Field({
  label,
  required,
  error,
  hint,
  htmlFor,
  className,
  children,
}: {
  label: ReactNode;
  required?: boolean;
  error?: string;
  hint?: ReactNode;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {required ? (
          <span className="text-destructive" aria-hidden>
            *
          </span>
        ) : (
          <span className="text-[0.65rem] font-normal text-muted-foreground">选填</span>
        )}
      </Label>
      {children}
      {error ? (
        <p id={htmlFor ? `${htmlFor}-error` : undefined} className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

type BaseProps<T extends FieldValues> = {
  name: Path<T>;
  control: Control<T>;
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  className?: string;
  disabled?: boolean;
};

export function TextField<T extends FieldValues>({
  name,
  control,
  label,
  required,
  hint,
  className,
  disabled,
  type = "text",
  placeholder,
}: BaseProps<T> & { type?: string; placeholder?: string }) {
  const id = useId();
  return (
    <Controller
      name={name}
      control={control}
      render={({ field, fieldState }) => (
        <Field
          label={label}
          required={required}
          hint={hint}
          error={fieldState.error?.message}
          htmlFor={id}
          className={className}
        >
          <Input
            {...field}
            id={id}
            type={type}
            disabled={disabled}
            placeholder={placeholder}
            aria-invalid={fieldState.invalid}
            aria-describedby={fieldState.error ? `${id}-error` : undefined}
          />
        </Field>
      )}
    />
  );
}

export function TextareaField<T extends FieldValues>({
  name,
  control,
  label,
  required,
  hint,
  className,
  disabled,
  rows = 3,
  placeholder,
}: BaseProps<T> & { rows?: number; placeholder?: string }) {
  const id = useId();
  return (
    <Controller
      name={name}
      control={control}
      render={({ field, fieldState }) => (
        <Field
          label={label}
          required={required}
          hint={hint}
          error={fieldState.error?.message}
          htmlFor={id}
          className={className}
        >
          <Textarea
            {...field}
            id={id}
            rows={rows}
            disabled={disabled}
            placeholder={placeholder}
            aria-invalid={fieldState.invalid}
            aria-describedby={fieldState.error ? `${id}-error` : undefined}
          />
        </Field>
      )}
    />
  );
}

export function SelectField<T extends FieldValues>({
  name,
  control,
  label,
  required,
  hint,
  className,
  disabled,
  options,
  placeholder = "请选择",
}: BaseProps<T> & {
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  const id = useId();
  return (
    <Controller
      name={name}
      control={control}
      render={({ field, fieldState }) => (
        <Field
          label={label}
          required={required}
          hint={hint}
          error={fieldState.error?.message}
          htmlFor={id}
          className={className}
        >
          <Select
            value={field.value === "" || field.value == null ? UNSET : String(field.value)}
            onValueChange={(v) => field.onChange(v === UNSET ? "" : v)}
            disabled={disabled}
          >
            <SelectTrigger
              id={id}
              className="w-full"
              size="default"
              aria-invalid={fieldState.invalid}
            >
              <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>{placeholder}</SelectItem>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
    />
  );
}

/** 服务端校验回传（`ApiFailure.issues`）。路径与 DTO 字段名一致，所以直接标在字段名上。 */
export function ServerIssues({ issues }: { issues?: { path: string; message: string }[] }) {
  if (!issues?.length) return null;
  return (
    <ul className="space-y-1 rounded-md border border-destructive/35 bg-destructive/[0.04] px-3 py-2 text-xs text-destructive">
      {issues.map((i) => (
        <li key={`${i.path}-${i.message}`}>
          <span className="num">{i.path}</span> · {i.message}
        </li>
      ))}
    </ul>
  );
}
