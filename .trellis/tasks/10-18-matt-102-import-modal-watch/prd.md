# 视觉重构 ⑤ 批量导入改弹层（含 dry-run 预检）+「我收藏的」改「我关注的」

## Goal

Paca MATT-102。导入定稿=变体 C，删掉 A/B 与 ?variant= 约 200 行脚手架；入口移到案件页/事项页页头按钮，类型由入口页锁定（matter / risk_matter）；/config/import 保留为「最近导入批次 + 报告找回」，导航移除。新增 POST /api/import?dryRun=1：走同一条解析校验路径、只跳过写库、返回同样 ImportSummary——幂等判定照常参与，否则预检谎报「能导」。预查看三个数（共 X/将导入 Y/有问题 Z）必须同屏，只显示前 N 行（与 SUMMARY_ISSUE_LIMIT 同源）。「我收藏的」改「我关注的」、/watch 入口移进身份区下拉（与退出登录并列），/watch 路由保留、ADR-0003 不动。不做：不重构解析与幂等、不删 /config/import。

## Requirements

- TBD

## Acceptance Criteria

- [ ] TBD

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
