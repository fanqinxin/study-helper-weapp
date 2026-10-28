# syntax=docker/dockerfile:1

# ============================================================
# 小学生同步学习小程序 · 后端镜像
#
# 一个镜像同时支持两种角色，由 compose 指定 command 区分：
#   - API 服务：  node src/app.js
#   - 队列消费者：node src/jobs/homeworkWorker.js
# 好处是依赖只装一次、构建只做一次，两个容器镜像层完全复用。
# ============================================================

# ---------- 构建阶段：安装依赖 ----------
FROM node:20-alpine AS builder

WORKDIR /app

# 先只拷贝清单文件，让依赖层在源码变更时仍能命中缓存
COPY package*.json ./

# 依赖安装层：
# - 有锁文件时用 npm ci（可复现构建）；没有则回退 npm install
# - 项目当前尚未提交 package-lock.json，这段兼容是必需的，否则构建直接失败
#   建议尽快执行一次 npm install 并把锁文件入库，之后即可稳定走 npm ci
RUN if [ -f package-lock.json ]; then \
      echo "[build] 检测到 package-lock.json → npm ci"; \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      echo "[build] 未找到 package-lock.json → 回退 npm install"; \
      npm install --omit=dev --no-audit --no-fund; \
    fi \
    && npm cache clean --force

# ---------- 运行阶段 ----------
FROM node:20-alpine AS runner

ENV NODE_ENV=production \
    TZ=Asia/Shanghai

# 构建元信息，由 CI 通过 --build-arg 注入；本地构建时留默认值。
# 写入 OCI 标准 label，方便 docker inspect 反查镜像来源与构建时间。
ARG BUILD_DATE=""
ARG VCS_REF=""
ARG BUILD_VERSION=""

LABEL org.opencontainers.image.title="study-helper-server" \
      org.opencontainers.image.description="小学生同步学习小程序后端（api / worker 共用镜像）" \
      org.opencontainers.image.created="$BUILD_DATE" \
      org.opencontainers.image.revision="$VCS_REF" \
      org.opencontainers.image.version="$BUILD_VERSION" \
      org.opencontainers.image.licenses="UNLICENSED"

# tini 负责转达信号，避免 node 收不到 SIGTERM 导致优雅退出失效
# wget 用于容器健康检查；su-exec 用于入口脚本里从 root 降权到 node
RUN apk add --no-cache tini wget su-exec \
    && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
    && echo $TZ > /etc/timezone

WORKDIR /app

# 从构建阶段搬运依赖，源码单独拷贝（改代码不必重装依赖）
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package*.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node sql ./sql
# 运营脚本与教材数据：seed.js 需要读 data/textbook 下的 JSON，
# 这两项目录很小（纯文本），进镜像后可直接 compose exec 执行灌库
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node data ./data

# 入口脚本负责修正上传目录属主后降权执行
COPY --chown=root:root docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 上传目录：本地存储模式下的图片落盘位置，compose 会挂卷进来。
# 卷首次挂载属主是 root，所以这里保留 root 属主，由入口脚本启动时修正。
RUN mkdir -p /app/uploads && chown node:node /app/uploads

# 说明：不在这里写 USER node —— 入口脚本需要 root 权限去修卷属主，
# 之后通过 su-exec 自行降权；最终进程仍以 node 身份运行。
EXPOSE 3000

# 容器内探活；worker 容器不做 HTTP 检查，compose 里单独覆盖
# 注意路径是 /api/v1/health（与 app.js 中注册的一致）；
# 该接口在依赖不可用时返回 503，wget 会以非 0 退出，正好达到探活目的
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:3000/api/v1/health || exit 1

# tini 作为 PID 1，向上转发信号
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]

CMD ["node", "src/app.js"]
