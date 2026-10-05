import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { readActor, type Actor } from "./auth/auth";

/**
 * `/api/**` 的统一出口（禁令⑤：业务读写一律走这里，且**每个 handler 内部**自己判权限）。
 *
 * 三条错误口径直接来自规格件，别在页面里另发明一套：
 *   · 未登录 401；**无权可见 404**（不是 403）—— 权限草案 §1 元规则 3：
 *     403 等于告诉对方"这条存在但你不能看"，案号枚举探测就此得到确认；
 *   · 校验失败 400，并把 `issues[].path` 原样带回，前端按「第几张卡 · 哪个字段」定位；
 *   · 响应永远是 JSON（Server Function 不做第二套权限判断）。
 */

export type ApiError = {
  error: string;
  message: string;
  issues?: { path: string; message: string }[];
};

/**
 * 出口序列化：**BigInt → string**，一次做掉。
 *
 * 为什么不在每个服务函数里手转：详情接口嵌套六层表、三十多个 id 列，手转必漏
 * —— 本轮第一次真实 HTTP 冒烟就在 `/api/matters/[id]` 上 500（`Do not know how to
 * serialize a BigInt`），因为 `nodeTypeId` 少转了一个。漏一个的形态是"列表能开、详情打不开"，
 * 恰好是最难被 review 抓住的那类。
 *
 * 这正是 master P1-19 要的边界：`bigint` 只在服务层与 SQL 里存在，跨过这条线一律 string。
 * （JS `Number` 的安全上界是 2^53-1，雪花值转 number 会静默丢低位，所以只能转 string。）
 */
function toWire(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(toWire);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = toWire(val);
    return out;
  }
  return v;
}

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(toWire(data), { status });
}

export function fail(status: number, error: string, message: string): NextResponse {
  return json({ error, message } satisfies ApiError, status);
}

/** 不可见与不存在给**同一个** 404，措辞也不区分（见上面的元规则 3） */
export const notFound = (): NextResponse =>
  fail(404, "not_found", "没有找到这条记录，或你没有访问它的权限");

export const unauthorized = (): NextResponse =>
  fail(401, "unauthenticated", "会话已失效或未登录，请重新登录");

/** 归档终态、状态偏离等"要问清原因"的动作（修订稿 §3.3 第 3 条、§6.3） */
export const reasonRequired = (): NextResponse =>
  fail(422, "reason_required", "这个动作必须填写原因，填写后才能提交");

/**
 * 护栏 1 拒绝（权限草案 §2.2）：这条你**看得见**，但改状态/改归属轮不到你。
 *
 * 给 403 而不是 404 是有意的：404 的口径是"不可见或不存在"（元规则 3），
 * 而这里对方本来就看得见这条宿主 —— 报 404 会让协办人以为案子被删了，
 * 反复去找负责人确认。两种 4xx 的分工就是"能不能看见"与"能不能改归属"。
 */
export const attributionRequired = (): NextResponse =>
  fail(403, "attribution_required", "只有负责人或具备全局范围的角色能改这条记录的归属与状态");

/**
 * 路径参数里的 id → BigInt，不合法给 **400**（不是 500）。
 *
 * 为什么单独一个函数：`BigInt("undefined")` 抛的是 SyntaxError，会从 handler 一路冒到
 * 全局错误处理，于是"手打一个 `/api/matters/undefined`"变成 500。本轮冒烟打错 URL 时
 * 真实撞到了这一条 —— 5xx 会污染错误率监控，也会让人以为服务端坏了。
 *
 * 不给 404：那是"这条记录不可见或不存在"的答复；URL 写法不对根本不是访问判断，
 * 混用会把"前端路由 bug"伪装成"权限收窄"。
 */
export function pathId(
  raw: string | undefined,
): { ok: true; id: bigint } | { ok: false; res: NextResponse } {
  if (raw === undefined || !/^\d{1,19}$/.test(raw)) {
    return { ok: false, res: fail(400, "bad_id", "路径里的 id 必须是纯数字字符串") };
  }
  try {
    return { ok: true, id: BigInt(raw) };
  } catch {
    return { ok: false, res: fail(400, "bad_id", "路径里的 id 超出可表示范围") };
  }
}

/**
 * 取 body 并过 Zod。
 *
 * 注意**不用** `req.json()` 的裸值：所有字段先当不可信输入过 schema，
 * 未知键由 schema 自己决定拒绝还是剥离（禁令⑧ 的表单同源要求）。
 */
export async function body<T>(
  req: Request,
  schema: ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; res: NextResponse }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, res: fail(400, "bad_json", "请求体不是合法 JSON") };
  }
  try {
    return { ok: true, data: schema.parse(raw) };
  } catch (e) {
    if (e instanceof ZodError) {
      return {
        ok: false,
        res: json(
          {
            error: "validation_failed",
            message: "表单有字段没通过校验，请检查标出的位置",
            issues: e.issues.map((i) => ({
              path: i.path.map(String).join("."),
              message: i.message,
            })),
          } satisfies ApiError,
          400,
        ),
      };
    }
    throw e;
  }
}

/** 查询串过 Zod（分页/排序/筛选白名单，复用 `@/shared/schema/list-query`） */
export async function query<T>(
  req: Request,
  schema: ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; res: NextResponse }> {
  const rec: Record<string, string> = {};
  new URL(req.url).searchParams.forEach((v, k) => {
    if (v !== "") rec[k] = v;
  });
  try {
    return { ok: true, data: schema.parse(rec) };
  } catch (e) {
    if (e instanceof ZodError) {
      return {
        ok: false,
        res: json(
          {
            error: "validation_failed",
            message: "查询条件不合法",
            issues: e.issues.map((i) => ({
              path: i.path.map(String).join("."),
              message: i.message,
            })),
          } satisfies ApiError,
          400,
        ),
      };
    }
    throw e;
  }
}

/**
 * 鉴权包装：拿不到 actor 直接 401，绝不带着 null 往下走。
 * 每个 handler 都要用它（或 `requirePrivilege`），这是禁令⑤ 的落点。
 */
export async function withActor<T>(
  handler: (actor: Actor) => Promise<T> | T,
): Promise<T | NextResponse> {
  const actor = await readActor();
  if (!actor) return unauthorized();
  return handler(actor);
}

/** 特权开关判定：撤销归档、明文查看等"影响别人或不可逆"的动作（权限草案 §2.1） */
export function requirePrivilege(
  actor: Actor,
  key: keyof Actor["privileges"],
  label: string,
): NextResponse | undefined {
  if (actor.privileges[key]) return undefined;
  return fail(403, "privilege_required", `这个动作需要「${label}」权限，当前角色未持有`);
}
