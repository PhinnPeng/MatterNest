"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api, ApiFailure, toOptions, useMeta } from "@/app/lib/client/api";
import { convertSchema, type MatterCreateInput } from "@/shared/schema/hosts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Button } from "@/app/components/ui/button";
import { SelectField, ServerIssues, TextField } from "@/app/components/form/fields";
import { StateBlock } from "@/app/components/ui/state-block";

type RiskRow = { id: string; code: string; name: string; level: string };

/**
 * 事项 → 案件（修订稿 §3.4 / 映射矩阵 §2）。
 *
 * 表单里**没有金额与描述**两个字段，这不是省略：P0-1 的裁定是"金额不继承、描述不整体搬"，
 * 事项那条描述是给内部报备看的，直接抄进案卷会让后来的人以为它已经被确认过。
 * 等级默认带过来（同一条风险的等级当然还是案件的等级），但可以改。
 *
 * 成功后停在"已建案"这一步而不是立刻关框：新案件的内部编号要让人看见并确认一眼，
 * 再点"打开案件"跳过去 —— 这条链上最难查的故障是"建了但事项还显示未转"，
 * 所以这里同时给编号，并且把事项列表查询一起失效掉。
 */
export function ConvertDialog({
  source,
  onClose,
  onCreated,
}: {
  source: RiskRow | null;
  onClose: () => void;
  onCreated: (caseId: string) => void;
}) {
  const qc = useQueryClient();
  const { data: meta } = useMeta("matter");
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<{ id: string; internalCode: string } | null>(null);
  const [issues, setIssues] = useState<ApiFailure["issues"]>();

  const {
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<MatterCreateInput>({
    resolver: zodResolver(convertSchema),
    defaultValues: { name: "", cause: "", level: "" },
  });

  useEffect(() => {
    setOpen(source !== null);
    if (source) {
      reset({ name: source.name, cause: "", level: source.level });
      setCreated(null);
      setIssues(undefined);
    }
  }, [source, reset]);

  const mut = useMutation({
    mutationFn: (values: MatterCreateInput) =>
      api.post<{ id: string; internalCode: string }>(
        `/api/risk-matters/${source?.id}/convert`,
        values,
      ),
    onSuccess: (res) => {
      setCreated(res);
      qc.invalidateQueries({ queryKey: ["risk-matters"] });
      qc.invalidateQueries({ queryKey: ["matters"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (e) => setIssues(e instanceof ApiFailure ? e.issues : undefined),
  });

  function close() {
    setOpen(false);
    onClose();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) close();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{created ? "案件已建" : "转为案件"}</DialogTitle>
          <DialogDescription>
            {source ? (
              <>
                来源事项 <span className="num">{source.code}</span> · {source.name}
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="grid gap-4">
            <StateBlock
              title={`新案件编号 ${created.internalCode}`}
              hint="事项侧已标为「已转」，两本台账靠外键连着。金额与描述按规格不继承，进案件里补。"
              action={
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => onCreated(created.id)}>
                    打开案件
                  </Button>
                  <Button size="sm" variant="outline" onClick={close}>
                    留在事项列表
                  </Button>
                </div>
              }
            />
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
              />
              <TextField name="cause" control={control} label="案由" required />
              <SelectField
                name="level"
                control={control}
                label="风险等级"
                required
                options={(meta?.levels ?? []).map((l) => ({ value: l.code, label: l.name }))}
                hint="默认沿用事项等级，可改"
              />
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
              <TextField name="filingDate" control={control} type="date" label="立案日期" />
            </div>

            <ServerIssues issues={issues} />
            {errors.name ? <p className="text-xs text-destructive">{errors.name.message}</p> : null}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                取消
              </Button>
              <Button type="submit" disabled={mut.isPending}>
                {mut.isPending ? "建案中" : "转为案件"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
