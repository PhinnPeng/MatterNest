import { defineConfig } from "drizzle-kit";

/**
 * 迁移管线配置（W0-4，2026-09-27）。
 *
 * 落点按技术选型 §5 注的映射定在 app 层服务端目录内 —— 注意 spec 与 §5 注原文写的是
 * `src/lib/server/db`，而仓库实际层级是 `src/app/lib/server/**`（W0-1 建、ESLint 守卫也挂在这），
 * 那条箭头指着一个不存在的目录，本轮已一并校正。
 *
 * 禁令④ 决定了这里**没有** `push` 脚本；`dbCredentials` 只喂 `generate`/`migrate`，
 * 运行时连接由 `src/app/lib/server/db/client.ts` 自己读 env，不经本文件。
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/app/lib/server/db/schema/index.ts",
  out: "./src/app/lib/server/db/migrations",
  // 迁移文件是唯一事实，不需要连库来推断；关掉 introspection 避免误把线上库当真相
  dbCredentials: {
    host: process.env.PGHOST ?? "127.0.0.1",
    port: Number(process.env.PGPORT ?? 30432),
    database: process.env.PGDATABASE ?? "dev_matternest",
    user: process.env.PGUSER ?? "dev_matternest",
    password: process.env.PGPASSWORD ?? "",
    ssl: false,
  },
  strict: true,
  verbose: true,
});
