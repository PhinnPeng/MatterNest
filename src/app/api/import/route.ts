import { importRequestSchema } from "@/shared/schema/import";
import { ImportFileError, runImport } from "@/app/lib/server/services/import";
import { canImport } from "@/app/lib/server/scope/guards";
import { UnassignableAssigneeError } from "@/app/lib/server/services/selectable-users";
import { body, fail, importForbidden, json, withActor } from "@/app/lib/server/http";

/**
 * 批量导入（F7-4 / M7 US-M7-1 / MATT-44）。
 *
 * ## 请求体是 JSON（`{hostType, fileName, csv}`），不是 multipart
 *
 * 导入要处理的是**文本**，而浏览器读文件本来就要过一次 `FileReader`；走 multipart 只是
 * 让服务端再解一层边界，同时把"文件多大"这件事交给框架的 body 缓冲。JSON + schema 里的
 * 长度上限（`MAX_IMPORT_CSV_CHARS`）让"太大"在**校验层**变成 400，而不是在运行时变成 OOM。
 *
 * ## 两类失败分得很清楚
 *
 * · **文件级**（表头不认识、必填列缺失、编码不是 UTF-8、行数超上限）→ **400**，
 *   带上 `problem.code`。这不是"逐行跳过"能救的：不知道哪一列是什么，任何一行都无从解释。
 * · **行级**（取值不合法、处理人查不到、内容重复、本企业名…）→ **200**，
 *   结果里 `importedRows / errorRows` 分开，逐行进错误报告（`reportRef` 可下载）。
 *   这正是 Q42=A 的裁定：导入的是历史烂账，全有全无会永远导不进去。
 *
 * 未预期的错误**故意不兜**：让它 500 冒泡，批次停在 `running`，已提交的行都在，
 * 用户重传即可（内容键会把它们跳过）。把未知错误逐行吞成"错误行"会掩盖真因。
 */
export async function POST(req: Request) {
  const parsed = await body(req, importRequestSchema);
  if (!parsed.ok) return parsed.res;
  return withActor(async (actor) => {
    if (!canImport(actor)) return importForbidden();
    try {
      return json(await runImport(actor, parsed.data));
    } catch (e) {
      if (e instanceof ImportFileError) return fail(400, e.problem.code, e.problem.message);
      // 与建案/建事项同形：被指派者不合格是**可预期**的请求问题，不是 500。
      // 逐行路径已在服务层把它翻成报告条目；这一条兜的是"整批一次性断言"那种走法。
      if (e instanceof UnassignableAssigneeError) return fail(422, "not_selectable", e.message);
      throw e;
    }
  });
}
