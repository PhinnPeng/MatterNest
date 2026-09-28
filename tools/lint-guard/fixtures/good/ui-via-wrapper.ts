/**
 * 合法：antd 顶层取组件与类型 + 官方图标 + 我们自己的约定层。
 * 这条 fixture 是"防规则过宽"的——`antd/locale/*` 与顶层的 `TableColumnsType`/`FormRule`
 * 都是官方推荐写法，一旦 UI_PATTERNS 写成 `antd/*` 全站就没有合法入口了。
 */
import { Button, ConfigProvider, Table } from "antd";
import type { FormRule, TableColumnsType } from "antd";
import zhCN from "antd/locale/zh_CN";
import { SearchOutlined } from "@ant-design/icons";
import dayjs from "dayjs";

import { DataTable } from "@/app/components/ui/data-table/DataTable";
import { INK } from "@/app/theme/brand";

export type Probe = { columns: TableColumnsType<unknown>; rules: FormRule[] };

export const probe = [Button, ConfigProvider, Table, zhCN, SearchOutlined, DataTable, dayjs];
export const style = { color: INK.muted, background: "#fff" };
