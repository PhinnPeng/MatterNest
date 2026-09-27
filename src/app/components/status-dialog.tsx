"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api, ApiFailure, type StatusRow } from "@/app/lib/client/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Button } from "@/app/components/ui/button";
import { Field, ServerIssues } from "@/app/components/form/fields";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { Textarea } from "@/app/components/ui/textarea";

/** 归档/结案这两个语义要求原因（与 `services/matters.ts:changeStatus` 同一判据） */
const REASON_SEMANTICS = new Set(["closed", "archived"]);

export type StatusTarget = { id: string; code: string; name: string; status: string };

/**
 * 案件状态变更对话框。
 *
 * 原因必填的**判定在服务层**（它才知道目标态的 semantics，那才是防线）；
 * 这里只是提前把星号与提示画出来，让用户少撞一次 422 —— 一个是防线、一个是体验，
 * 少画星号系统照样正确，所以这处重复是有意的，别把它当"两处实现"去合。
 *
 * 一期只做**案件**侧：事项侧的状态流转要另写一条 `changeRiskStatus`
 * （归档位、结案日期都各自一张表），而本次 Demo 的事项动作是"转案件"，
 * 所以这里不假装支持——传 matter 之外的宿主会被类型挡住。
 */
export function StatusDialog({
  target,
  statuses,
  open,
  onOpenChange,
}: {
  target: StatusTarget | null;
  statuses: StatusRow[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const [issues, setIssues] = useState<ApiFailure["issues"]>();

  const semantics = statuses.find((s) => s.code === to)?.semantics;
  const reasonRequired = REASON_SEMANTICS.has(semantics ?? "");
  const reasonMissing = reasonRequired && reason.trim().length === 0;
  const unchanged = to === "" || to === target?.status;

  useEffect(() => {
    if (open) {
      setTo("");
      setReason("");
      setTouched(false);
      setIssues(undefined);
    }
  }, [open, target?.id]);

  const mut = useMutation({
    mutationFn: () => api.post(`/api/matters/${target?.id}/status`, { to, reason: reason.trim() }),
    onSuccess: () => {
      // 状态一改，列表行、详情、工作台的"在办/分布"三处都旧了，一起失效
      qc.invalidateQueries({ queryKey: ["matters"] });
      qc.invalidateQueries({ queryKey: ["matter"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      onOpenChange(false);
    },
    onError: (e) => setIssues(e instanceof ApiFailure ? e.issues : undefined),
  });

  if (!target) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>变更状态</DialogTitle>
          <DialogDescription>
            <span className="num">{target.code}</span> · {target.name}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3.5">
          <Field
            label="目标状态"
            required
            htmlFor="status-to"
            error={touched && to === "" ? "请选择目标状态" : undefined}
            hint={
              semantics === "archived"
                ? "归档后默认从列表消失，撤销归档需专门权限。"
                : semantics === "closed"
                  ? "结案会写入结案日期，与归档互不影响。"
                  : undefined
            }
          >
            <Select value={to} onValueChange={setTo}>
              <SelectTrigger id="status-to" className="w-full">
                <SelectValue placeholder="选择要转到的状态" />
              </SelectTrigger>
              <SelectContent>
                {statuses
                  .filter((s) => s.code !== target.status)
                  .map((s) => (
                    <SelectItem key={s.code} value={s.code}>
                      {s.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </Field>

          <Field
            label="原因"
            required={reasonRequired}
            htmlFor="status-reason"
            error={touched && reasonMissing ? "结案与归档必须写原因" : undefined}
            hint={reasonRequired ? undefined : "这个状态不需要原因，写了会一起进活动记录。"}
          >
            <Textarea
              id="status-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder={reasonRequired ? "为什么现在转到这个状态" : "补充说明（选填）"}
            />
          </Field>

          <ServerIssues issues={issues} />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button
              type="button"
              disabled={unchanged || mut.isPending}
              onClick={() => {
                setTouched(true);
                if (unchanged || reasonMissing) return;
                mut.mutate();
              }}
            >
              {mut.isPending ? "提交中" : "确认变更"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
