"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, SearchIcon } from "lucide-react";
import { cn } from "cn";

import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { ALL } from "@/app/lib/client/options";

/**
 * 两张列表共用的筛选条。抽出来的理由不是"少写一遍"，而是**两页必须给同一个口径**：
 * 关键词命中哪些列、翻页时筛选是否保留、"含归档"放在哪儿——两处不一致会让人怀疑数据。
 *
 * 关键词做 500ms 去抖：每敲一个字就发一次带 LIKE 的查询，在内网那种小机上比慢查询更糟的是
 * 它会让分页条闪个不停，看起来像结果在漂。
 */
export function ListToolbar({
  keyword,
  onKeyword,
  status,
  onStatus,
  statusOptions,
  sortBy,
  sortDir,
  onSort,
  sortOptions,
  includeArchived,
  onIncludeArchived,
  actions,
  busy,
}: {
  keyword: string;
  onKeyword: (v: string) => void;
  status: string;
  onStatus: (v: string) => void;
  statusOptions: { value: string; label: string }[];
  sortBy: string;
  sortDir: "asc" | "desc";
  onSort: (key: string, dir: "asc" | "desc") => void;
  sortOptions: { value: string; label: string }[];
  includeArchived?: boolean;
  onIncludeArchived?: (v: boolean) => void;
  actions?: React.ReactNode;
  busy?: boolean;
}) {
  const [text, setText] = useState(keyword);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [open, setOpen] = useState(false);

  // 外部（浏览器后退、清了 URL 参数）改了关键词时要跟着回显
  useEffect(() => setText(keyword), [keyword]);

  useEffect(() => {
    if (text === keyword) return;
    timer.current = setTimeout(() => onKeyword(text.trim()), 500);
    return () => clearTimeout(timer.current);
  }, [text, keyword, onKeyword]);

  const dir: "asc" | "desc" = sortDir;
  const flip = () => onSort(sortBy, dir === "asc" ? "desc" : "asc");

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
      <div className="relative w-64 max-w-full">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // 回车立即提交：去抖是便利，不该拦住"我就是现在要搜"
            if (e.key === "Enter") {
              e.preventDefault();
              clearTimeout(timer.current);
              onKeyword(text.trim());
            }
          }}
          placeholder="案号 / 名称 / 案由"
          aria-label="关键词"
          className="pl-7"
        />
      </div>

      <Select
        value={status || ALL}
        onValueChange={(v) => onStatus(v === ALL ? "" : v)}
        open={open}
        onOpenChange={setOpen}
      >
        <SelectTrigger className="w-36" aria-label="状态">
          <SelectValue placeholder="全部状态" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>全部状态</SelectItem>
          {statusOptions.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="flex items-center gap-1">
        <Select value={sortBy} onValueChange={(v) => onSort(v, dir)}>
          <SelectTrigger className="w-32" aria-label="排序列">
            <SelectValue placeholder="排序" />
          </SelectTrigger>
          <SelectContent>
            {sortOptions.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          onClick={flip}
          aria-label={dir === "asc" ? "当前升序，点切降序" : "当前降序，点切升序"}
          title={dir === "asc" ? "升序" : "降序"}
        >
          {dir === "asc" ? <ArrowUpIcon /> : <ArrowDownIcon />}
        </Button>
      </div>

      {onIncludeArchived ? (
        <label
          className={cn(
            "flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-muted",
            includeArchived && "text-primary",
          )}
        >
          <input
            type="checkbox"
            className="size-3.5 accent-(--primary)"
            checked={Boolean(includeArchived)}
            onChange={(e) => onIncludeArchived(e.target.checked)}
          />
          含已归档
        </label>
      ) : null}

      {busy ? (
        <span className="text-[0.68rem] text-muted-foreground motion-safe:animate-pulse motion-reduce:animate-none">
          查询中
        </span>
      ) : null}

      <div className="ml-auto flex items-center gap-2">{actions}</div>
    </div>
  );
}
