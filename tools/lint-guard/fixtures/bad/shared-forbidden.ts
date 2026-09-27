// 故意违规：禁令① 必须在这一行报错。tools/lint-guard/check.mjs 断言它报错，
// 以此证明规则真的生效，而不是躺在 eslint.config.mjs 里。
import { readFileSync } from "node:fs";
import { headers } from "next/headers";

export function forbidden(): string {
  return readFileSync(headers() as never as string, "utf8");
}
