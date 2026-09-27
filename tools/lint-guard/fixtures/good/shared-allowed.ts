// 对照组：纯 TS，禁令① 不应报任何错。check.mjs 断言这个目录 0 error。
export const SHARED_OK: readonly string[] = ["enums", "schema", "ids", "time", "crypto"];

export function first<T>(list: readonly T[]): T | undefined {
  return list[0];
}
