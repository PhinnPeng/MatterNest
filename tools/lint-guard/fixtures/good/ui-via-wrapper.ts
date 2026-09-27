/**
 * 合法：走 `components/ui/` 那一层。
 * 这条 fixture 是"防规则过宽"的——如果哪天 UI_PATTERNS 把 `@/app/components/ui/*` 也拦了，
 * 全站就没有合法的写法了。
 */
import { Select, SelectTrigger } from "@/app/components/ui/select";
import { DataTable } from "@/app/components/ui/data-table/DataTable";
import { PlusIcon } from "lucide-react";

export const probe = [Select, SelectTrigger, DataTable, PlusIcon];
