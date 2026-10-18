# 视觉重构 ④ 功能配置 14 细项页 + /api/config/[kind] CRUD

## Goal

Paca MATT-101。今天 /config 是 149 行只读字典页。14 细项分三档：5 个有可写表（案件状态/事项状态/风险等级/标签/费用项目）建 CRUD + 弹层；7 个闭集枚举页面上明写「改动要走迁移」；2 个无实体项（节点通知状态/时间）同上。新增 shared/schema/config.ts（前后端同一份）+ /api/config/[kind]，写门 canManageConfig，同批改掉 config-view.tsx 里「一期不做配置编辑」那句注释。状态表三条硬约束（恰好一初始态/一归档态/至多一结案态，partial unique index 兜底）要在服务层先判；停用被规则引用的状态要明确拒绝。与 #72 的关系：落完后 #72 只剩 P12。不做 mn_node_type_config（P15）。

## Requirements

- TBD

## Acceptance Criteria

- [ ] TBD

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
