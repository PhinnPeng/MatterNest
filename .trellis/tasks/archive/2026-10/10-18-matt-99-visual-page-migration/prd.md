# 视觉重构 ② 页面迁移：不依赖新接口的 11 个路由换成 canon 外观

## Goal

Paca MATT-99。把不需要新接口的页逐页换成 canon 外观，行为零改动。对表：workbench/notifications/matters+matter-detail/risk-matters+risk-detail/parties+party-detail/archive/users/login 及四张弹层成功态。纪律：指标带数字必须来自既有接口的聚合（不许前端按当页现算，那等于绕过 scopedWhere）；操作列快捷动作必须打已有写接口，其中「程序」当前无编辑接口（PATCH 白名单不含 procedure/litigationRole），要么补白名单要么降级为不可点，不留点了没反应的按钮。验收：既有 40 个 spec.ts 全绿是「行为不变」的判据。

## Requirements

- TBD

## Acceptance Criteria

- [ ] TBD

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
