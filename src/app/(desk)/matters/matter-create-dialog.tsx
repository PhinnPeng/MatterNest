"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { XIcon } from "lucide-react";

import { api, ApiFailure, toOptions, type Meta } from "@/app/lib/client/api";
import { matterCreateSchema, type MatterCreateInput } from "@/shared/schema/hosts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Button } from "@/app/components/ui/button";
import { SelectField, ServerIssues, TextField, TextareaField } from "@/app/components/form/fields";
import { StateBlock } from "@/app/components/ui/state-block";

/**
 * 新建案件。
 *
 * 编号不在表单里：`internal_code` 由服务层在**同一个事务**里向 `mn_code_seq` 单语句取号
 * （`INSERT … ON CONFLICT DO UPDATE … RETURNING`），所以这个对话框提交完才拿得到编号，
 * 也所以成功后我把它单独显示出来 —— 让用户看见"这条案卷从此有了系统内号"，
 * 是这套编号规则唯一能被感知的时刻。
 *
 * `caseNo`（正式案号）留空时服务层用内部编号顶上（§6.3：未立案也要有条目可跟）。
 */
export function MatterCreateDialog({
  open,
  onOpenChange,
  meta,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  meta: Meta | undefined;
}) {
  const qc = useQueryClient();
  const [created, setCreated] = useState<{ id: string; internalCode: string } | null>(null);
  const [issues, setIssues] = useState<ApiFailure["issues"]>();

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors },
  } = useForm<MatterCreateInput>({
    resolver: zodResolver(matterCreateSchema),
    defaultValues: { name: "", cause: "", parties: [] },
  });

  const parties = useFieldArray({ control, name: "parties" });

  useEffect(() => {
    if (open) {
      reset({ name: "", cause: "", parties: [] });
      setCreated(null);
      setIssues(undefined);
    }
  }, [open, reset]);

  const mut = useMutation({
    mutationFn: (values: MatterCreateInput) => api.post("/api/matters", values),
    onSuccess: (res) => {
      setCreated(res as { id: string; internalCode: string });
      qc.invalidateQueries({ queryKey: ["matters"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (e) => setIssues(e instanceof ApiFailure ? e.issues : undefined),
  });

  const levelOptions = (meta?.levels ?? []).map((l) => ({ value: l.code, label: l.name }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{created ? "案件已建" : "新建案件"}</DialogTitle>
          <DialogDescription>
            {created
              ? "内部编号由数据库取号生成，不可编辑。"
              : "带 * 的是必填。当事人可以现在填，也可以建好之后在详情页加。"}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="grid gap-4">
            <StateBlock
              title={`内部编号 ${created.internalCode}`}
              hint="案号留空时先用内部编号占位，正式立案后回详情改。"
              action={
                <div className="flex gap-2">
                  <Button asChild size="sm">
                    <Link href={`/matters/${created.id}`}>打开案件</Link>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      reset({ name: "", cause: "", parties: [] });
                      setCreated(null);
                    }}
                  >
                    再建一条
                  </Button>
                </div>
              }
            />
            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                关闭
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={handleSubmit((v) => mut.mutate(v))} className="grid gap-3.5" noValidate>
            <div className="grid gap-3.5 sm:grid-cols-2">
              <TextField
                name="name"
                control={control}
                label="案件名称"
                required
                className="sm:col-span-2"
                placeholder="例：甲公司诉乙公司买卖合同纠纷"
              />
              <TextField name="cause" control={control} label="案由" required />
              <SelectField
                name="caseType"
                control={control}
                label="案件类型"
                required
                options={meta ? toOptions(meta.enums.caseTypes) : []}
              />
              <SelectField
                name="procedure"
                control={control}
                label="审级 / 程序"
                required
                options={meta ? toOptions(meta.enums.procedures) : []}
              />
              <SelectField
                name="litigationRole"
                control={control}
                label="我方诉讼地位"
                required
                options={meta ? toOptions(meta.enums.litigationRoles) : []}
              />
              <TextField name="court" control={control} label="受理法院" />
              <SelectField
                name="level"
                control={control}
                label="风险等级"
                required
                options={levelOptions}
                hint="来自配置表，不是硬编码四档"
              />
              <TextField name="amount" control={control} label="标的额（元）" hint="最多两位小数" />
              <TextField name="caseNo" control={control} label="正式案号" hint="留空先用内部编号" />
              <TextField
                name="filingDate"
                control={control}
                type="date"
                label="立案日期"
                hint="日历日期，不带时刻"
              />
              <TextareaField
                name="description"
                control={control}
                label="基本情况"
                rows={3}
                className="sm:col-span-2"
              />
            </div>

            <fieldset className="rounded-lg border border-border p-3">
              <legend className="px-1 text-xs font-medium">当事人</legend>
              {parties.fields.map((f, i) => (
                <div
                  key={f.id}
                  className="mb-2 grid items-start gap-2 sm:grid-cols-[1fr_7rem_7rem_1.5rem]"
                >
                  <TextField
                    name={`parties.${i}.name`}
                    control={control}
                    label="名称"
                    required={i === 0}
                  />
                  <SelectField
                    name={`parties.${i}.type`}
                    control={control}
                    label="类型"
                    options={meta ? toOptions(meta.enums.partyTypes) : []}
                  />
                  <SelectField
                    name={`parties.${i}.partyRole`}
                    control={control}
                    label="诉讼地位"
                    options={meta ? toOptions(meta.enums.litigationRoles) : []}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="移除该当事人"
                    className="mt-6"
                    onClick={() => parties.remove(i)}
                  >
                    <XIcon />
                  </Button>
                  {/* 是否我方代理与诉讼地位是**正交**两列（枚举表 E06/E07），所以单独一个开关而不是并成一个值 */}
                  <label className="col-span-4 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      className="size-3.5 accent-(--primary)"
                      {...register(`parties.${i}.represented`)}
                    />
                    我方代理
                  </label>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  parties.append({
                    name: "",
                    type: "legal_person",
                    partyRole: "plaintiff",
                    represented: true,
                  })
                }
              >
                添加当事人
              </Button>
              {errors.parties?.root?.message ? (
                <p className="pt-1 text-xs text-destructive">{errors.parties.root.message}</p>
              ) : null}
            </fieldset>

            <ServerIssues issues={issues} />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button type="submit" disabled={mut.isPending}>
                {mut.isPending ? "提交中" : "建案"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
