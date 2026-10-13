# MatterNest 应用镜像（MATT-71）
#
# ## 为什么是 standalone
#
# `next.config.ts` 里已经是 `output: "standalone"`（技术选型 §13.1 自托管路线）。
# 这份 Dockerfile 只是把那个既成事实接上镜像：产物落在 `.next/standalone/server.js`，
# **不带** `node_modules` 全量（除 `node_modules/.pnpm` 里被 trace 出来的那些），
# 镜像因此小一个量级。
#
# ## 刻意不做的事
#
# · **不装 devDependencies 进运行镜像**（`--prod` 那一层）。`pnpm install --frozen-lockfile`
#   只在 deps 阶段装全量，运行时靠 standalone 自带的精简 `node_modules`。
# · **不 COPY `.env`**。任何密钥不入镜像（技术选型 §6）：运行时由 compose 注入。
# · **不以 root 运行**。`nextjs` 用户（uid 1001）是 `node:alpine` 的官方约定。
#
# 构建上下文必须是**仓库根**（`docker-compose.yml` 里写的是 `context: ..`）——
# 因为 `COPY package.json pnpm-lock.yaml ./` 与 `COPY . .` 都按仓库根解析。

# ── 1. 依赖：只装一次，被 builder 与 runner 复用 ────────────────────────────
FROM node:22-alpine AS deps

# pnpm 10 的官方 standalone 安装方式。corepack 在 node:22-alpine 里已内置，
# 但沙箱镜像不带 corepack shim，所以先 enable。
RUN corepack enable

WORKDIR /app

# 只复制清单文件 → 依赖层的缓存不会因为改一行业务代码而失效。
COPY package.json pnpm-lock.yaml ./

# ⚠ `--frozen-lockfile` 是门禁而不是建议：lockfile 与 package.json 不一致时
#   直接构建失败，而不是静默解析出一棵与本机开发不同的依赖树。
RUN pnpm install --frozen-lockfile

# ── 2. 构建 ─────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

RUN corepack enable
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 本仓没有任何 Dockerfile / compose 之外的构建期 env 需求；真实密钥一律运行时注入。
ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm build

# ── 3. 运行 ─────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    # standalone server 监听全网卡；只写 127.0.0.1 会让容器外（nginx）连不上。
    HOSTNAME=0.0.0.0 \
    PORT=3000

# 官方约定的非 root 用户（uid/gid 1001）。
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 --ingroup nodejs nextjs

# standalone 产物 + 它**不会**自带的两份东西，必须手工搬：
#   · `.next/static` —— hashed 静态资源，缺了页面样式全丢
#   · `public/`      —— 本仓当前**没有**这个目录（MATT-71 时点核实）。
#     写成 `COPY --from=builder /app/public ./public` 会在今天直接构建失败，
#     所以先建一个空目录占位；将来真出现 `public/` 再把这行换回 COPY。
RUN mkdir -p public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

# 单副本（MATT-35）：不起 cluster，多进程只会让人误以为已经支持多副本。
CMD ["node", "server.js"]