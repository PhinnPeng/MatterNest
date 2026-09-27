# worker

独立进程（技术选型 §5）：`node-cron` 跑四件——节点提醒扫描、规则 4 的 30 天无更新扫描、outbox 投递、云之家在职同步。

- 每条任务必须包 `withSingleFlight()`（内部 `pg_try_advisory_lock`）。**这不是保险，是多副本下的功能正确性前提**：outbox 双派＝双发通知（C1，经 §13.2 继承）。
- 必须处理 SIGTERM，留 10–30s drain，否则 outbox 投递会被掐断（§13.3-4 / 部署级 b）。
- 一次性补跑：`docker compose run worker --task <name>`（C2 作废 Nitro `task run` 后的替代路径）。
- 依赖方向：`worker/** → src/shared/** + src/app/lib/server/**`（可 import Node API）。

内容在 W0-5（进程与 compose）与 W5-1（三件任务）进来。
