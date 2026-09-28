/**
 * 故意写坏：禁令⑦ 的第二半 —— 色值不在唯一源里定义。
 * check.mjs 会以 `src/app/components/` 下的虚拟路径喂给仓库 config，
 * 断言下面**四处**全部被拦（少一处就说明某个 selector 写坏了而测试仍然绿）。
 */
export const primary = "#2f5fe0"; // 1/4 十六进制
export const paper = "#f7f8fa"; // 2/4 十六进制
export const rule = "1px solid #eceef3"; // 3/4 拼在长字符串里
export const hover = "rgba(47,95,224,0.045)"; // 4/4 手写半透明
