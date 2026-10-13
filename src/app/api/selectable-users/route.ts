import { listUsersForCreate } from "@/app/lib/server/services/selectable-users";
import { json, withActor } from "@/app/lib/server/http";

/**
 * `GET /api/selectable-users` —— **创建表单专用**的选人面（IQ-14 的创建期例外）。
 *
 * ## 这是那条"不提供裸用户列表"规则唯一被放开的入口，且放开是有裁定的
 *
 * 权限草案 §4.1 挡的是"往**已有案卷**里加人"这个动作（那是权限外溢），
 * 不是"新建时填一个处理人"。裁定原文（IQ-14）说得很直白：首次上报的业务同事
 * **共现集为空**——不放开的话，「处理人可选填」对新上报人根本不可用（一个同事都选不到）；
 * 而十人组织的花名册没有保密价值，防枚举在这里是空转。
 *
 * ## 边界写进代码，因为这是唯一容易越界的地方
 *
 * · **只给创建表单用**。给已有宿主加人一律走 `/api/{host}/{id}/selectable-users`
 *   （带宿主上下文 + 共现收窄）。这一点没法在类型上强制，所以写在路径名与注释里。
 * · `pending`（待开通）账号仍然排除——那是"绕批防线"，裁定明文保留。
 * · 停用与软删排除，与写路径的 `findUnassignable` **同源判据**（不是各写一套）。
 *
 * 不需要额外特权：能创建记录的人就能看到"可以填谁"。这条接口**不含**任何账号状态
 * （不发 `isEnabled`/`activationStatus`/角色），只给 id/显示名/账号名。
 */
export async function GET() {
  return withActor(async () => {
    return json({ users: await listUsersForCreate() });
  });
}
