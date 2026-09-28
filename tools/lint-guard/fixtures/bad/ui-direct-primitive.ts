/**
 * 故意写坏：禁令⑦ —— 把"第二套体系"请回 app 层。
 * `tools/lint-guard/check.mjs` 会以 `src/app/components/` 下的虚拟路径喂给仓库 config，
 * 断言下面**每一个** import 都被拦（一条漏拦就说明那个 group 写错了，比如少了 glob 后缀）。
 */
import { Select as RadixSelect } from "radix-ui";
import { cva } from "class-variance-authority";
import { useReactTable } from "@tanstack/react-table";
import { ProTable } from "@ant-design/pro-components";
import type { ColumnsType } from "antd/es/table";
import zhCN from "antd/lib/locale/zh_CN";
import { PlusIcon } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { format } from "date-fns";

export const probe = [
  RadixSelect,
  cva,
  useReactTable,
  ProTable,
  zhCN,
  PlusIcon,
  useForm,
  zodResolver,
  format,
];
export type ProbeColumns = ColumnsType<unknown>;
