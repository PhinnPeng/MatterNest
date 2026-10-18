"use client";

import Link from "next/link";

import { INK } from "@/app/theme/brand";
import { PageHeader } from "@/app/components/page-header";
import { CONFIG_GROUPS, CONFIG_KIND_META, configKindPath } from "@/shared/schema/config";

/**
 * 功能配置（入口页）。
 *
 * ## 这一页是"导航到细项"，不是"读配置"
 *
 * 原先（149 行）它把状态/风险等级/闭集枚举**并排列在同一页**当只读字典读，理由是
 * "并排列出来，'为什么这个能改那个不能改'就不用口头解释"。本票给它真实的编辑能力后，
 * 那个理由不再成立：**能做/不能做的边界移到了各细项页上**（能改的给弹层，不能改的写
 * 「改动要走迁移」），入口页只承担分诊 —— 五张卡片指向 14 个细项。
 *
 * `can_manage_config` 曾经只用于读（旧注如此）；今天它是 `/api/config/[kind]` 的写门，
 * 细项页据此决定给不给「新增」与编辑入口。
 *
 * ## 为什么卡片分组成五张（照 canon-spec 第 10 节）
 *
 * 分组是**界面语汇**（事项/案件/当事人/风险/通知），不是数据库分组；14 个细项一个不多
 * 一个不少地落进这五组，顺序即默认阅读顺序。分组与细项清单都是 `shared/schema/config.ts`
 * 里的 `CONFIG_GROUPS`（接口与页面同源，不在页面里再抄一份）。
 *
 * ## 细则行为什么不带项数、不带来源标记
 *
 * 原型明写"不带项数、不带来源标记"：项数是库里的行数、会变，标在入口上就是一份要维护的
 * 第二事实；来源（配置表 vs 闭集枚举）在细项页里有更精确的说法，入口上标它只会让人
 * 在没打开页面前就先分类。
 */
export function ConfigView() {
  return (
    <>
      <PageHeader title="功能配置" />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: 16,
        }}
      >
        {CONFIG_GROUPS.map((group) => (
          <div key={group.label} className="card">
            <div className="card-h">
              <h2>{group.label}</h2>
            </div>
            <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {group.kinds.map((kind) => (
                <Link
                  key={kind}
                  href={configKindPath(kind)}
                  className="it"
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
                >
                  {CONFIG_KIND_META[kind].label}
                  <i style={{ color: INK.muted, fontStyle: "normal" }} aria-hidden="true">
                    ›
                  </i>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
