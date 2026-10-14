"use client";

import { App as AntdApp, Button, Dropdown } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import { useMutation } from "@tanstack/react-query";

import { api, ApiFailure, downloadCsv, useActor, type HostFileExport } from "@/app/lib/client/api";
import { businessDateKey } from "@/shared/time/zh-cn";

/**
 * 整卷导出（US-42 两档）。
 *
 * 两档的差别与判定：
 *   · **脱敏档**（默认）—— 人人可导，当事人证件号/联系方式只留尾四位；
 *   · **明文档**（`?plain=1`）—— 需要 `can_read_plain`。前端只是**不摆**这个入口
 *     （`disabled`），真正的门在服务端（`requirePrivilege` → 403）：
 *     前端禁用不算拦得住手写请求，这与本仓"前端不给控件 ≠ 拦得住"的既有口径一致。
 *
 * 为什么与当事人列表页那个导出菜单分开写：它们的**数据源不同**（一个是当事人列表、
 * 一个是某条案卷的整卷），但两档语义、`can_read_plain` 门、`EXPORT` 审计与
 * 下载实现都是同一份（`downloadCsv` / `exportHostFile`）—— 这里没有第二套口径。
 */
export function ExportFileButton({
  host,
  hostId,
  code,
}: {
  host: "matter" | "risk_matter";
  hostId: string;
  /** 案卷编号：进文件名，导出多份时不至于互相覆盖 */
  code: string;
}) {
  const { message } = AntdApp.useApp();
  const { data: actor } = useActor();
  const base = host === "matter" ? "matters" : "risk-matters";
  const canPlain = Boolean(actor?.privileges.canReadPlain);

  const mut = useMutation({
    mutationFn: (plain: boolean) =>
      api.get<HostFileExport>(`/api/${base}/${hostId}/export${plain ? "?plain=1" : ""}`),
    onSuccess: (r) => {
      // 文件名里的日期戳：**业务日**（上海），不是 UTC 日。
      // 上海时间 00:00–08:00 导出时，UTC 切片会写成前一天 ——
      // 与 `closing_date` / `discover_date` 是同一个错（MATT-69 / MATT-79）。
      const stamp = businessDateKey(new Date());
      downloadCsv(`${code}-整卷-${r.plain ? "明文" : "脱敏"}-${stamp}.csv`, r.csv);
      message.success(
        `已导出 ${r.rows} 行${r.truncated ? "（有区段超过 1000 行，只导出了前 1000 行）" : ""}`,
      );
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "导出失败"),
  });

  return (
    <Dropdown
      trigger={["click"]}
      menu={{
        items: [
          { key: "masked", label: "导出整卷（脱敏）" },
          {
            key: "plain",
            // 「为什么不能点」写在**那个禁用项自己**身上，不挂在整颗按钮上：
            // 按钮同时服务两档，挂上去会让一个能导脱敏档的人以为整个导出都用不了
            label: canPlain
              ? "导出整卷（含明文证件号）"
              : "导出整卷（含明文证件号）· 需要「明文导出」权限",
            disabled: !canPlain,
          },
        ],
        onClick: ({ key }) => mut.mutate(key === "plain"),
      }}
    >
      <Button icon={<DownloadOutlined />} loading={mut.isPending}>
        导出
      </Button>
    </Dropdown>
  );
}
