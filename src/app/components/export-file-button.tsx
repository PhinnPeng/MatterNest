"use client";

import { App as AntdApp, Dropdown } from "antd";
import { useMutation } from "@tanstack/react-query";

import { api, ApiFailure, downloadCsv, useActor, type HostFileExport } from "@/app/lib/client/api";
import { toExportQuery, type ListState } from "@/app/lib/client/use-list-state";
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
      <button type="button" className="btn sm" disabled={mut.isPending}>
        导出
      </button>
    </Dropdown>
  );
}

/**
 * **列表导出**（F1-20 事项 / F2-23 案件两档）。
 *
 * 与上面那个 `ExportFileButton`（整卷）同一个形状、同一套口径：两条菜单项（脱敏 / 明文）、
 * 明文档要 `can_read_plain`、文件名带业务日戳、`csv` 由服务端拼好。
 * 差别只有数据源：那个导**一条案卷的全部**，这个导**当前筛选出来的那一批行**。
 *
 * ## 为什么把筛选也交给它（而不是调用方传一串拼好的 query）
 *
 * 「导出当前筛选的结果」是这两个端点的语义。若筛选由调用方拼，就会出现
 * "页面加了筛选、导出没跟上"这种**静默**偏差（导出比列表多几行，两边都 200）。
 * 所以这里收的是**列表状态本身**，由 `toExportQuery`（与列表 `toQuery` 同一批键名，
 * 有逐键断言盯着）拼串 —— 调用方没有"忘了带筛选"这个动作可做。
 *
 * ## 两档在这一类列表上内容相同（不是漏做）
 *
 * 案件的加密列（当事人证件号/联系方式）住在 `mn_party`；这是**宿主**列表，一行一案，
 * 装不下一条当事人的多个证件号 —— 所以没有"留尾四位"可做。
 * `plain` 仍是真口径：它决定**谁能调**（服务端 `requirePrivilege` → 403）与
 * **审计里记的档位**（`EXPORT` 载荷的 `plain`）。前端这个禁用项只是省一次必然 403 的往返
 * —— 界面判权永远不是防线。
 */
export function ExportListButton({
  path,
  fileBase,
  state,
}: {
  /** 导出端点：`/api/matters/export` 或 `/api/risk-matters/export` */
  path: string;
  /** 文件名前缀：导出多份时不至于互相覆盖 */
  fileBase: string;
  /** 列表的当前状态（筛选 + 排序）。分页不进导出串，见 `toExportQuery` */
  state: ListState;
}) {
  const { message } = AntdApp.useApp();
  const { data: actor } = useActor();
  const canPlain = Boolean(actor?.privileges.canReadPlain);

  const mut = useMutation({
    mutationFn: (plain: boolean) => {
      const q = new URLSearchParams(toExportQuery(state));
      if (plain) q.set("plain", "1");
      return api.get<HostFileExport>(`${path}?${q}`);
    },
    onSuccess: (r) => {
      // 文件名里的日期戳：**业务日**（上海），不是 UTC 日 —— 与另外三个导出点同一条纪律
      const stamp = businessDateKey(new Date());
      downloadCsv(`${fileBase}-${r.plain ? "明文" : "脱敏"}-${stamp}.csv`, r.csv);
      message.success(
        // 脱敏档不写"证件号只留尾四位"：这两张列表里根本没有那一列，
        // 说了就是编（与 `exportMatters` 的注释同一条理由）
        `已导出 ${r.rows} 行${r.plain ? "（明文档，已记 EXPORT 审计）" : ""}${
          r.truncated ? "；命中超过上限，只导出了前 1000 行" : ""
        }`,
      );
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "导出失败"),
  });

  return (
    <Dropdown
      trigger={["click"]}
      menu={{
        items: [
          { key: "masked", label: "导出列表（脱敏）" },
          {
            key: "plain",
            // 「为什么不能点」写在**那个禁用项自己**身上，不挂在整颗按钮上（与整卷那个同一条理由）
            label: canPlain ? "导出列表（明文）" : "导出列表（明文）· 需要「明文导出」权限",
            disabled: !canPlain,
          },
        ],
        onClick: ({ key }) => mut.mutate(key === "plain"),
      }}
    >
      <button type="button" className="btn sm" disabled={mut.isPending}>
        导出
      </button>
    </Dropdown>
  );
}
