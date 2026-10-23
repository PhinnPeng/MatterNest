import { dateTime } from "@/app/lib/client/format";
import { Tooltip } from "antd";

/**
 * 到期标记（规则 3 的可视化落点：临期与逾期必须一眼扫得到）。
 *
 * 逾期写成"逾期 N 天"而不是只把数字标红——同状态标记那条理由：**颜色不能是唯一通道**
 * （色觉障碍与灰阶打印都会让"红色=逾期"失效，而期限是要被引用和被扫读的东西）。
 *
 * 分档阈值 3/7 天与节点提醒默认档 `{7,3,1}` 同源，但这里**不读那一列**：
 * 列表要的是"这条现在危不危险"的一次性判断，每行再解析数组会把渲染变成 O(行×档)。
 * 真按节点档位发消息是 M5 扫描器的事（那张表也是它唯一的写入口）。
 *
 * ## 形态照 canon 原型的 `.pill`（点 + 词）
 *
 * `matters.html` 的「最近期限」是 `.pill over|due|gray`：一个 6px 圆点加一句话，
 * 与状态列同一种语言。原先这里是纯色文字，缺那个点——同一个语义在两张表里长成两种样子。
 *
 * 颜色**只用三档**，与原型逐字一致：逾期红、7 日内黄、其余灰。
 * 不再给 3–7 天单开一档蓝色：原型把"7 天内"当作一个整体（"剩 2 天"与"剩 6 天"同为黄点），
 * 而多出来的第四种颜色没有对应的词，读者只能靠猜。
 * 阈值 3/7 仍参与**文案**（"今天"/"剩 N 天"），只是不再分成第四种颜色。
 */
export function DeadlineMark({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span className="pill gray">未定</span>;

  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  const cls = days < 0 ? "pill over" : days <= 7 ? "pill due" : "pill gray";
  const label =
    days < 0
      ? `逾期 ${-days} 天`
      : days === 0
        ? "今天"
        : days <= 7
          ? `剩 ${days} 天`
          : dateTime(iso);

  return (
    <Tooltip title={dateTime(iso)}>
      <span className={cls} data-days={days}>
        <i />
        {label}
      </span>
    </Tooltip>
  );
}
