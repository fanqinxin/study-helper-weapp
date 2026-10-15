#!/bin/sh
# ============================================================
# 容器入口脚本
#
# 解决两个实际问题：
#  1) Docker 具名卷首次挂载时属主是 root，而非 root 运行的 node 用户
#     无法写入 /app/uploads，导致上传图片直接失败（EACCES）。
#     这里先以 root 修好属主，再用 gosu 降权到 node 启动。
#  2) worker 容器没有 HTTP 端口，但共用同一镜像的 HEALTHCHECK，
#     因此由各自 compose 配置覆盖，这里不做分支处理。
#
# 若容器本身就以非 root 启动（如 K8s securityContext 限制），
# 则跳过 chown，交给编排层保证卷权限。
# ============================================================
set -e

UPLOAD_DIR="${UPLOAD_DIR:-/app/uploads}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$UPLOAD_DIR"
  # 只在属主不对时才 chown，避免大目录每次启动全量遍历
  if [ "$(stat -c '%u' "$UPLOAD_DIR")" != "$(id -u node)" ]; then
    echo "[entrypoint] 修正 $UPLOAD_DIR 属主为 node"
    chown -R node:node "$UPLOAD_DIR"
  fi
  # 以 node 身份执行真正的启动命令
  exec su-exec node "$@"
fi

echo "[entrypoint] 以非 root 用户 $(id -un) 启动"
exec "$@"
