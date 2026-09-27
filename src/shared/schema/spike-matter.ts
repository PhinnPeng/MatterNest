import { z } from "zod";
import { listResultSchema } from "./list-query";

/**
 * N7 spike 的行 DTO（**形状照真表来，数据是假的**）。
 *
 * 放 `src/shared/` 而不是服务端模块里，是为了演示本项目的既定口径：
 * **DTO 只有一份**，服务端构造它、客户端消费它都引同一个定义（枚举表 §5.1、禁令⑧）。
 * id 用 `string`——雪花 64 位过 `JSON.stringify` 会静默丢精度（master P1-19）。
 */
export const spikeMatterSchema = z.object({
  id: z.string().regex(/^\d+$/),
  code: z.string(),
  name: z.string(),
  status: z.enum(["pending", "in_progress", "closed", "archived"]),
  risk_level: z.enum(["high", "medium", "low"]),
  owner_name: z.string(),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  updated_at: z.string(),
});

export type SpikeMatter = z.infer<typeof spikeMatterSchema>;

export const spikeMatterListResultSchema = listResultSchema(spikeMatterSchema);
export type SpikeMatterListResult = z.infer<typeof spikeMatterListResultSchema>;
