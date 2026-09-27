"use client";

import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";

import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import {
  caseCardSchema,
  convertFormSchema,
  copyCardOnto,
  summarizeIssues,
  type ConvertForm,
} from "@/shared/schema/convert-form";

/**
 * N7 的表单半截：动态数组表单（一次交 N 个案件）。
 * 通过标准就一句：**错误能定位到"第几张卡、哪个字段"**——
 * 定位文案由 `shared/schema/convert-form.ts` 的 `summarizeIssues()` 产出，
 * 所以这里只负责把它显示出来，不在组件里再写一套规则（禁令⑧）。
 */
export function N7ConvertForm() {
  const [summary, setSummary] = useState<string[]>([]);
  const [copiedFrom, setCopiedFrom] = useState<number | null>(null);

  const {
    control,
    register,
    handleSubmit,
    getValues,
    setValue,
    formState: { errors },
  } = useForm<ConvertForm>({
    resolver: zodResolver(convertFormSchema),
    defaultValues: {
      risk_matter_id: "1234567890",
      cases: [
        {
          client_name: "",
          client_role: "party",
          cause: "",
          tags: [],
          nodes: [{ name: "举证期限" }],
        },
      ],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: "cases" });

  const onValid = (data: ConvertForm) => {
    setSummary([]);
    setCopiedFrom(null);
    // spike：只回显，不提交
    console.info("通过校验的案件卡片数：", data.cases.length);
  };

  const onInvalid = (errs: Record<string, unknown>) => {
    // 把 RHF 的错误还原成 Zod 风格的 path，再交给同一份映射函数
    const flat: string[] = [];
    for (const [field, e] of Object.entries(errs)) {
      if (field === "cases" && e && typeof e === "object") {
        for (const [idx, cardErrs] of Object.entries(e as Record<string, unknown>)) {
          if (cardErrs && typeof cardErrs === "object") {
            for (const [k, v] of Object.entries(cardErrs as Record<string, { message?: string }>)) {
              flat.push(`第 ${Number(idx) + 1} 张卡 · ${k}：${v?.message ?? "无效"}`);
            }
          }
        }
      } else if (e && typeof e === "object" && "message" in e) {
        flat.push(`${field}：${(e as { message: string }).message}`);
      }
    }
    setSummary(flat);
  };

  /** 跨卡复制：只带白名单字段，id 类不动（矩阵 §3），逻辑在 shared 里且有测试。 */
  const copyToOthers = (from: number) => {
    const source = getValues("cases")[from];
    const parsed = caseCardSchema.safeParse(source);
    if (!parsed.success) {
      setSummary(summarizeIssues(parsed.error.issues));
      return;
    }
    const all = getValues("cases");
    all.forEach((target, i) => {
      if (i !== from)
        setValue(`cases.${i}`, copyCardOnto(parsed.data, target), { shouldValidate: true });
    });
    setCopiedFrom(from);
    setSummary([]);
  };

  return (
    <form onSubmit={handleSubmit(onValid, onInvalid)} className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            append({
              client_name: "",
              client_role: "party",
              cause: "",
              tags: [],
              nodes: [{ name: "" }],
            })
          }
        >
          加一张案件卡
        </Button>
        <Button type="submit" size="sm">
          提交校验
        </Button>
        <span className="text-xs text-muted-foreground">当前 {fields.length || 1} 张卡</span>
      </div>

      {summary.length > 0 ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <p className="mb-1 font-medium">校验未通过（{summary.length} 处）</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {summary.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {fields.map((f, i) => (
        <Card key={f.id}>
          <CardHeader className="flex-row items-center justify-between py-2">
            <CardTitle className="text-sm">第 {i + 1} 张卡</CardTitle>
            <div className="flex gap-1">
              <Button type="button" size="sm" variant="outline" onClick={() => copyToOthers(i)}>
                复制本卡到其余
              </Button>
              {fields.length > 1 ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => remove(i)}>
                  删除
                </Button>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3">
            <label className="text-xs">
              当事人名称
              <Input
                {...register(`cases.${i}.client_name`)}
                className={errors.cases?.[i]?.client_name ? "border-destructive" : ""}
              />
              {errors.cases?.[i]?.client_name ? (
                <span className="text-destructive">{errors.cases[i]?.client_name?.message}</span>
              ) : null}
            </label>
            <label className="text-xs">
              案由
              <Input
                {...register(`cases.${i}.cause`)}
                className={errors.cases?.[i]?.cause ? "border-destructive" : ""}
              />
              {errors.cases?.[i]?.cause ? (
                <span className="text-destructive">{errors.cases[i]?.cause?.message}</span>
              ) : null}
            </label>
            <label className="text-xs">
              受理法院
              <Input {...register(`cases.${i}.court`)} />
            </label>
            <label className="text-xs">
              标的金额
              <Input
                {...register(`cases.${i}.amount`)}
                className={errors.cases?.[i]?.amount ? "border-destructive" : ""}
              />
              {errors.cases?.[i]?.amount ? (
                <span className="text-destructive">{errors.cases[i]?.amount?.message}</span>
              ) : null}
            </label>
            <label className="text-xs">
              立案日期（YYYY-MM-DD）
              <Input {...register(`cases.${i}.filing_date`)} placeholder="2026-09-27" />
            </label>
            <label className="text-xs">
              当事人角色
              <select
                {...register(`cases.${i}.client_role`)}
                className="w-full rounded-md border px-2 py-1 text-sm"
              >
                <option value="party">当事人</option>
                <option value="represented">代理人</option>
              </select>
            </label>
            {copiedFrom === i ? (
              <p className="text-xs text-muted-foreground">
                已把本卡内容复制到其他卡（id 类字段不带过去）
              </p>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </form>
  );
}
