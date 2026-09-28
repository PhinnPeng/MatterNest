"use client";

"use client";

import * as React from "react";
import { cn } from "cn";

/**
 * 密集表格原语。
 *
 * ⚠ **这版密度契约是刻意偏离 shadcn registry 默认的，别再被 `shadcn add -o` 覆盖回去。**
 * 2026-09-27 那次 `add -y -o ... table ...` 把自写版换成了官方版，`DataTable` 没跟着复核，
 * 结果在 1440×900 实测出四件事：表头无底槽（`thead` 背景透明）、表头与正文同为
 * `14px / text-foreground`（整张表没有视觉锚点）、单元格内边距掉到 `p-2`、
 * 「程序」「等级」两列被 auto layout 挤到 45px。这四条都是可量的回归，不是审美分歧。
 * 密度契约本身由 `table-density.spec.ts` 守——它会读这份文件的类名，覆盖回去当场红。
 *
 * 四条口径：
 *   ① **表头弱于正文**（`text-xs` + `text-muted-foreground` + `bg-muted/40` 底槽）：
 *      列名是元信息，扫读时眼睛要先落到数据上；
 *   ② 列宽交给用它的地方：只有 fixed 布局才**尊重** `<colgroup>` 给的宽度，
 *      但 `table-fixed` **不能写在这个原语里**——详情页与配置页也用它，它们没有 colgroup，
 *      fixed 布局会把所有列平均切，节点名那种长列反而被挤扁（实测过）。
 *      所以是 `DataTable` 自己传 `table-fixed`，原语只管密度；
 *   ③ 单元格 `px-3`（12px）而不是 `p-2`（8px）：中文列名与 14px 正文之间 8px 会糊；
 *   ④ 行 hover 用**主色 4%** 而不是官方的 `bg-muted/50`：灰底 hover 在纸色背景上几乎看不见，
 *      而"这一行是我正要点的"是这张表最需要反馈的瞬间（主题三条里"主色只出现在三处"的第三处）。
 */

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("bg-muted/40 [&_tr]:border-b", className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b border-border/70 transition-colors hover:bg-primary/[0.04] data-[state=selected]:bg-primary/[0.07]",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-9 overflow-hidden px-3 text-left align-middle text-xs font-medium text-muted-foreground whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "overflow-hidden px-3 py-2 align-middle text-sm whitespace-nowrap text-ellipsis [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
