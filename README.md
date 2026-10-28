# 小学生同步学习小程序

课文同步练习 / 作业上传 AI 批改 / 错题巩固 / 学习计划 / 识字小游戏 + 家长端周报。

## 目录结构

```
miniprogram/        原生微信小程序（孩子端 + 家长端）
server/             Node.js + Express + MySQL + Redis 后端
  Dockerfile        后端镜像（api 与 worker 共用）
  docker-entrypoint.sh  启动时修正上传卷属主并降权运行
  .env.docker.example   Docker 部署环境变量模板
  data/textbook/    教材种子数据（JSON，运营内容）
  scripts/seed.js   教材/课文/题库灌库脚本（幂等）
docker/initdb/      MySQL 容器首次初始化脚本
docker-compose.yml  一键编排 api / worker / mysql / redis
.github/workflows/  GitHub Actions：质检 + 构建推送镜像到阿里云
deploy/nginx/       Nginx 站点配置（sh-api.rstu.top · HTTPS 反向代理）
docs/上线指南.md     体验版发布、隐私保护指引配置、真机验收清单、主体升级路径
docs/部署-Nginx与HTTPS.md  证书部署、微信域名配置、排障
docs/CI-CD说明.md    CI 变量配置、标签规则、回滚操作
docs/               开发交底文档
```

## 镜像仓库

后端镜像由 GitHub Actions 自动构建推送（工作流：`.github/workflows/docker-build.yml`）到：

```
registry.cn-shenzhen.aliyuncs.com/fanqx/study-helper-server
```

| 事件 | 是否构建 | 推送标签 |
|---|---|---|
| 推送到 `main` | ✅ | `latest`、`main`、`main-<短SHA>` |
| 打标签（如 `v1.0.0`） | ✅ | `v1.0.0`、`v1.0.0-<短SHA>` |
| 提 PR 到 `main` | ❌ 只跑质检 | — |
| 手动触发（Actions → Run workflow） | 勾选 `push_image` 才构建 | 按分支名推导，可自定义 |

`latest` 只跟随 `main` 移动 —— 给历史版本补打 tag 不会回退线上镜像。
质检（verify）会检查后端 JS 语法、compose 结构、LF 行尾、小程序结构，任一项失败即中断构建。

首次使用需在仓库 **Settings → Secrets and variables → Actions** 添加两个密钥：

| Secret | 值 |
|---|---|
| `REGISTRY_USER` | 阿里云账号 / RAM 子账号 |
| `REGISTRY_PASSWORD` | 容器镜像服务的固定密码 |

完整说明（标签策略、回滚步骤、常见错误处理）见 [`docs/CI-CD说明.md`](docs/CI-CD说明.md)。

## 方式一：Docker 部署（推荐）

需要 Docker Engine 20.10+ 与 Compose v2。

```bash
# 1. 准备环境变量
cp server/.env.docker.example .env
vim .env          # 必改：WX_APPID / WX_SECRET / AI_API_KEY / JWT_SECRET
                  #       以及 DB_ROOT_PASSWORD / DB_PASSWORD

# 2. 构建并启动（mysql、redis、api、worker）
docker compose up -d --build

# 3. 首次部署：建表（迁移是一次性任务，默认不随 up 启动）
docker compose --profile tools run --rm migrate

# 4. 首次部署：灌教材与题库（不灌则「课文」页是空的）
docker compose --profile tools run --rm seed

# 5. 查看状态与日志
docker compose ps
docker compose logs -f api
curl http://127.0.0.1:3000/api/v1/health
```

> 教材数据是运营内容，不进表结构迁移。维护方式见 [`docs/教材数据维护.md`](docs/教材数据维护.md)。
> 改了 JSON 只需重跑 `seed`，脚本按「教材 + 课文 seq + 题干」更新，不会产生重复数据。

**用 CI 构建好的镜像部署**（服务器上不构建，直接拉）：

```bash
# .env 里指定镜像来源
echo 'IMAGE_TAG=registry.cn-shenzhen.aliyuncs.com/fanqx/study-helper-server:latest' >> .env

docker login registry.cn-shenzhen.aliyuncs.com
docker compose pull api worker
docker compose up -d --no-build api worker
```

常用运维命令：

```bash
docker compose restart api            # 改完 .env 后重启
docker compose up -d --build api      # 代码变更后重建
docker compose --scale worker=3       # 批改量大时横向扩消费者
docker compose exec mysql mysql -ustudy -p study_helper   # 进库排查
docker compose down                   # 停止（保留数据卷）
docker compose down -v                # 停止并删数据卷（慎用）
```

编排要点，便于排查：

| 服务 | 作用 | 说明 |
|---|---|---|
| `mysql` | 数据库 | `mysql:8.0`，utf8mb4 + `+08:00` 时区；数据在 `mysql-data` 卷 |
| `redis` | 额度计数 / 队列 / 幂等锁 | `redis:7-alpine`，开启 AOF；数据在 `redis-data` 卷 |
| `api` | HTTP 服务 | 仅监听 `127.0.0.1:3000`，生产由外层 Nginx 反代 |
| `worker` | 批改队列消费者 | 与 api 同镜像，`command` 不同；与 api 共享上传目录 |
| `migrate` | 建表任务 | `profiles: tools`，需显式 `--profile tools run` 触发 |
| `seed` | 教材数据灌库 | `profiles: tools`；幂等，可反复执行 |

镜像设计说明：

- **一个镜像两种角色**：`api` 与 `worker` 用同一个 `study-helper-server:latest`，只靠 `command` 区分，构建只做一次、层完全复用
- **多阶段构建**：builder 阶段装依赖，runner 阶段只搬运 `node_modules` 与源码，镜像里没有 devDependencies
- **入口脚本降权运行**：容器以 root 启动仅为修正上传卷属主，随后由 `su-exec` 降权到 `node` 用户执行 Node 进程；最终业务进程不是 root
- **tini 作为 PID 1**：确保 `SIGTERM` 能传到 node，`homeworkWorker.js` 的优雅退出才生效
- **内网隔离**：`mysql` / `redis` 不映射到宿主机端口，只在 `sh-net` 内网可见；需要临时直连时用 `docker compose exec`
- **数据卷**：`mysql-data`、`redis-data`、`uploads-data` 三个具名卷，`down` 不会丢数据

一个容易踩的坑已在内置处理：**Docker 具名卷首次挂载时属主是 root**，非 root 进程无法写入 `/app/uploads`，上传图片会直接报 `EACCES`。`server/docker-entrypoint.sh` 会在启动时检测并修正该目录属主，再降权运行，无需手工 `chown` 卷。

生产上线还需注意：

1. **`.env` 不要入库**（已在 `.gitignore` 中排除），`NODE_ENV=production` 时后端会强制校验 `WX_APPID`、`WX_SECRET`、`AI_API_KEY`、`AI_BASE_URL`、`DB_PASSWORD`、`JWT_SECRET`，缺一项直接启动失败
2. **数据库迁移是手工触发的**，容器重建不会自动执行，避免误改生产表结构
3. **建表不再依赖 `CREATE DATABASE` 权限**：`sql/schema.sql` 里的库名是 `__DB_NAME__` 占位符，由 `migrate.js` 替换为 `DB_NAME`；库由 MySQL 容器的 `MYSQL_DATABASE` 创建，应用账号无建库权限也能正常迁移
4. **建议补交 `package-lock.json`**：目前仓库没有该文件，Dockerfile 已兼容回退到 `npm install`，但入库后才能稳定走 `npm ci` 做可复现构建
5. `uploads` 走容器本地盘；多机横向扩展或需要 CDN 时，在 `.env` 填 `OSS_*` 改走对象存储
6. 小程序需在微信后台配置正式域名（HTTPS），并同步修改 `miniprogram/config/index.js`

## 对外暴露：Nginx + HTTPS

后端用容器部署，正式环境由 Nginx 终结 TLS 反向代理，业务端口不对公网开放。

接口走子域名 `sh-api.rstu.top`，主域名 `rstu.top` 与 `www` 保持空闲（留给以后可能的官网 / H5，子域名继承主域备案，不用单独备案）。使用的是阿里云签发的泛域名证书 `*.rstu.top`，一级子域直接覆盖，不需要单独申请。

```bash
cp deploy/nginx/sh-api.rstu.top.conf /etc/nginx/conf.d/sh-api.rstu.top.conf
nginx -t && systemctl reload nginx
curl -s https://sh-api.rstu.top/api/v1/health
```

小程序要求 HTTPS + 443 端口 + 已备案域名，且必须在微信后台配置 `request` / `uploadFile` / `downloadFile` 三个合法域名。**微信的域名校验是精确匹配，主域名与子域名不互通** —— 三处都要填 `https://sh-api.rstu.top`。证书与 DNS、微信侧配置、502/413/504 排障见 [`docs/部署-Nginx与HTTPS.md`](docs/部署-Nginx与HTTPS.md)。

> 走 Nginx 后后端会自动信任 1 跳代理来还原真实 IP（`TRUST_PROXY` 可调）。不开这个，login 限流会把全站用户当成同一个 IP。

## 方式二：本地直接跑（开发调试）

```bash
cd server
npm install
cp .env.example .env      # 填写微信 appid/secret、MySQL、Redis、AI Key
npm run check             # 模块引用自检（相对路径 + 依赖声明），启动前先跑这个
npm run migrate           # 建表（可重复执行）
npm run seed:check        # 只校验教材数据，不连库
npm run seed              # 灌教材 / 课文 / 题库（幂等）
npm run dev               # API 服务，默认 :3000
npm run worker            # 批改任务队列消费者（另开终端）
```

> `npm run check` 会扫描所有 `require`：相对路径写错、包没写进 `dependencies` 都会报出来。这类问题 `node --check` 查不到，只会在容器启动时炸。

验证：`curl http://127.0.0.1:3000/api/v1/health`（返回 `status: ok` 表示 DB 与 Redis 均连通）

## 小程序启动

1. 微信开发者工具导入 `miniprogram/` 目录
2. 详情 → 本地设置 → 勾选「不校验合法域名」（开发阶段）
3. `config/index.js` 已默认指向 `http://127.0.0.1:3000/api/v1`；上线前改为正式域名

## 关键说明

- **AI 模型可配置**：`.env` 里 `AI_PROVIDER`（qwen / hunyuan / openaiCompat）+ 对应 Key，业务代码不感知具体模型
- **额度体系**：免费 20 次/周（周一重置），只约束 AI 批改与目录识别；做题/游戏/错题本不消耗；扣减采用事务 + 行锁，失败自动幂等退款
- **批改流程**：上传图片（`/upload/image`）→ 提交分析（`/homework/analyze`，先扣额度再投队列）→ 轮询状态（`/homework/:id/status`）→ 取报告
- **家长端**：孩子出示邀请码 → 家长绑定 → `/parent/overview`、`/parent/report` 按孩子 uid 聚合（服务端校验同 family_id）
- **支付**：`/order/create` 为 Phase 4 占位，加油包档位已在 `server/src/config/index.js` 配好
