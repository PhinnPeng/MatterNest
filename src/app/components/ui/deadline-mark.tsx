import { INK } from "@/app/theme/brand";
import { Tooltip } from "antd";

import { dateTime } from "@/app/lib/client/format";
import { DEADLINE_TONE } from "@/app/theme/antd";

/**
 * 到期标记（规则 3 的可视化落点：临期与逾期必须一眼扫得到）。
 *
 * 逾期写成"逾期 N 天"而不是只把数字标红——同状态标记那条理由：**颜色不能是唯一通道**
 * （色觉障碍与灰阶打印都会让"红色=逾期"失效，而期限是要被引用和被扫读的东西）。
 *
 * 分档阈值 3/7 天与节点提醒默认档 `{7,3,1}` 同源，但这里**不读那一列**：
 * 列表要的是"这条现在危不危险"的一次性判断，每行再解析数组会把渲染变成 O(行×档)。
 * 真按节点档位发消息是 M5 扫描器的事（那张表也是它唯一的写入口）。
 */
export function DeadlineMark({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span style={{ color: INK.muted, fontSize: 12 }}>未定</span>;

  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  const bucket = days < 0 ? "overdue" : days <= 3 ? "soon" : days <= 7 ? "near" : "later";
  const label =
    bucket === "later"
      ? dateTime(iso)
      : days < 0
        ? `逾期 ${-days} 天`
        : days === 0
          ? "今天"
          : `剩 ${days} 天`;

  return (
    <Tooltip title={dateTime(iso)}>
      <span
        data-days={days}
        style={{
          color: DEADLINE_TONE[bucket].color,
          fontVariantNumeric: "tabular-nums",
          fontSize: 13,
        }}
      >
        {label}
      </span>
    </Tooltip>
  );
}
