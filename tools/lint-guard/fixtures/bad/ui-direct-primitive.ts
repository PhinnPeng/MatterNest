/**
 * 故意写坏：禁令⑦ —— 业务组件直连原语包。
 * `tools/lint-guard/check.mjs` 会以 `src/app/components/` 下的虚拟路径喂给仓库 config，
 * 断言这三种 import 全部被拦。
 */
import { Select as RadixSelect } from "radix-ui";
import { useReactTable } from "@tanstack/react-table";
import { cva } from "class-variance-authority";

export const probe = [RadixSelect, useReactTable, cva];
