import { z } from "zod";

/**
 * 节点的**写契约**（2026-10-23 用户裁定）。
 *
 * 必要字段只有三个：名称、描述（可选）、时间。类型不再由用户选 ——
 * 它是模板的概念（预置节点按类型生成），手工节点没有模板可依。
 */
export const nodeWriteSchema = z
  .object({
    name: z.string().trim().min(1, "请填写节点名称").max(128),
    description: z.string().trim().max(2000).optional().or(z.literal("")),
    /**
     * ISO 时间（客户端由 Dayjs 的 `toISOString()` 给出）。
     * 接受 `YYYY-MM-DD` 与完整 ISO 两种形状：脚本与旧数据都还在用日期串。
     */
    startTime: z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/,
        "时间格式应为 YYYY-MM-DD 或 ISO 时间",
      ),
  })
  .strict();

export type NodeWriteInput = z.infer<typeof nodeWriteSchema>;
