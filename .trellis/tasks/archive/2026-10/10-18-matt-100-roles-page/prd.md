# 视觉重构 ③ 角色权限页 + GET /api/roles（只读）

## Goal

Paca MATT-100。/roles 路由今天不存在。建只读角色权限页 + 只读接口。接口返回 5 内置角色的 code/name/dataScope/四项特权/持有人数与成员摘要，范围标签用 DATA_SCOPE_LABELS。⚠ 权限门需先点头：建议登录即可读角色定义、成员清单按 canManageUser 收窄。页面主从布局 264px + 1fr，两栏等高照 research-master-detail-equal-height.md（不写 align-items:start、不写死高度）。数据源 mn_role + mn_role_join；库里只有 admin 一人（截图里其他人是原型编的，以库为准）。不做角色编辑能力。

## Requirements

- TBD

## Acceptance Criteria

- [ ] TBD

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
