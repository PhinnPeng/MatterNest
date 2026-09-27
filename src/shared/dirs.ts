/**
 * src/shared 的五个子目录名——骨架阶段的唯一纯 TS 模块，作用是：
 * 1) 让 `src/shared/` 有第一个可编译、可测试的纯 TS 文件（tsc 与 vitest 的配置因此被验证过）；
 * 2) 把 README 里那张表变成可断言的代码，目录漂移时测试会红。
 *
 * 本文件（以及整个 src/shared）**不得** import next / react / Node API —— 禁令①。
 */
export const SHARED_DIRS = ["enums", "schema", "ids", "time", "crypto"] as const;

export type SharedDir = (typeof SHARED_DIRS)[number];

export function firstSharedDir(): SharedDir | undefined {
  return SHARED_DIRS[0];
}
