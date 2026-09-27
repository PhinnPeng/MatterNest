"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api, ApiFailure, toOptions, useMeta } from "@/app/lib/client/api";
import { riskCreateSchema, type RiskCreateInput } from "@/shared/schema/hosts";
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

/** 新建风险事项（报备）。编号 `FX-YYYYMMDD-XXX` 同样由 DB 单语句取号。 */
export function RiskCreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const { data: meta } = useMeta("risk_matter");
  const [created, setCreated] = useState<{ id: string; code: string } | null>(null);
  const [issues, setIssues] = useState<ApiFailure["issues"]>();

  const {
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<RiskCreateInput>({
    resolver: zodResolver(riskCreateSchema),
    defaultValues: { name: "", description: "" },
  });

  useEffect(() => {
    if (open) {
      reset({ name: "", description: "" });
      setCreated(null);
      setIssues(undefined);
    }
  }, [open, reset]);

  const mut = useMutation({
    mutationFn: (values: RiskCreateInput) =>
      api.post<{ id: string; code: string }>("/api/risk-matters", values),
    onSuccess: (res) => {
      setCreated(res);
      qc.invalidateQueries({ queryKey: ["risk-matters"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (e) => setIssues(e instanceof ApiFailure ? e.issues : undefined),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{created ? "事项已报备" : "新建风险事项"}</DialogTitle>
          <DialogDescription>
            {created
              ? "编号由数据库取号生成，之后转案件时两本台账靠外键连着。"
              : "风险描述必填 —— 它是这件事能不能立案的判断依据，不是一句标题。"}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <StateBlock
            title={`事项编号 ${created.code}`}
            hint="回到列表可以看到它，状态是配置的初始态。"
            action={
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    reset({ name: "", description: "" });
                    setCreated(null);
                  }}
                >
                  再报一条
                </Button>
                <Button size="sm" onClick={() => onOpenChange(false)}>
                  完成
                </Button>
              </div>
            }
          />
        ) : (
          <form onSubmit={handleSubmit((v) => mut.mutate(v))} className="grid gap-3.5" noValidate>
            <TextField name="name" control={control} label="事项名称" required />
            <div className="grid gap-3.5 sm:grid-cols-2">
              <SelectField
                name="type"
                control={control}
                label="风险类型"
                required
                options={meta ? toOptions(meta.enums.riskTypes) : []}
              />
              <SelectField
                name="level"
                control={control}
                label="风险等级"
                required
                options={(meta?.levels ?? []).map((l) => ({ value: l.code, label: l.name }))}
              />
              <SelectField
                name="source"
                control={control}
                label="来源"
                options={meta ? toOptions(meta.enums.riskSources) : []}
                hint="可空：来源不明的风险也要能报备"
              />
              <TextField
                name="amount"
                control={control}
                label="预估影响（元）"
                hint="最多两位小数"
              />
              <TextField
                name="discoverDate"
                control={control}
                type="date"
                label="发现日期"
                hint="留空按今天记"
              />
            </div>
            <TextareaField
              name="description"
              control={control}
              label="风险描述"
              required
              rows={3}
            />
            <TextareaField name="measure" control={control} label="已采取措施" rows={2} />

            <ServerIssues issues={issues} />
            {errors.name ? <p className="text-xs text-destructive">{errors.name.message}</p> : null}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button type="submit" disabled={mut.isPending}>
                {mut.isPending ? "提交中" : "报备"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
