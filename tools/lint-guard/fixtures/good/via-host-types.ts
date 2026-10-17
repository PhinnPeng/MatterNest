/**
 * 合法：宿主集合从唯一源取，两种遍历都走 `HOST_TYPES`。
 *
 * 这条 fixture 同时证明规则**没有过宽**，三种常见形态都放过：
 *   · `HOSTS[host]` 的**对象**映射（不是数组字面量）；
 *   · 单个 `"matter"` 字面量（大量合法用途：DTO 标注、`HOSTS` 的键）；
 *   · 其它值的数组（`["matter_node", "risk_matter_node"]` 是节点域，不是宿主集合）。
 */
import { HOST_TYPES } from "@/shared/enums/targets";

export const hosts = HOST_TYPES;

export function eachHost(fn: (h: (typeof HOST_TYPES)[number]) => void) {
  for (const h of HOST_TYPES) fn(h);
}

export function pairsFor(host: "matter" | "risk_matter") {
  const table = { matter: "matter", risk_matter: "risk_matter" } as const;
  return table[host];
}

/** 节点域是另一份值域，不是"宿主集合" —— 不该被这条规则拦下 */
export const nodeKinds = ["matter_node", "risk_matter_node"] as const;
