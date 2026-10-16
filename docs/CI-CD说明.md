# CI/CD 说明（GitHub Actions）

本文档说明本项目的镜像构建流水线：做了什么、怎么配、怎么用、出问题怎么查。

- 流水线文件：`.github/workflows/docker-build.yml`
- 镜像仓库：阿里云容器镜像服务（个人版），命名空间 `fanqx`
- 镜像地址：`registry.cn-shenzhen.aliyuncs.com/fanqx/study-helper-server`

---

## 一、流水线做了什么

流水线由两个 job 组成，`verify` 先跑，`build` 后跑。

### job 1 · verify（质检，任何事件都跑）

在 `push` 和 `pull_request` 时都会执行，用来拦住"明显提交错的文件"，避免浪费构建时间。

| 序号 | 步骤 | 检查内容 |
| --- | --- | --- |
| 1 | Checkout | 拉取代码 |
| 2 | Setup Node | 安装 Node 20 |
| 3 | 校验后端 JS 语法 | 对 `server/**/*.js` 逐个执行 `node --check` |
| 4 | 校验 compose 结构 | 解析 `docker-compose.yml`，确认 5 个服务 / 3 个卷 / 1 个网络的骨架没被改坏 |
| 5 | 校验 LF 行尾 | 扫描 shell / Dockerfile / yml / sql / js，出现 CRLF 直接失败 |
| 6 | 校验小程序完整性 | 校验 30 个 JSON 可解析，且 `app.json` 里 18 个页面目录都存在对应四件套 |

> 第 5 步很关键：shell 脚本一旦带 CRLF，容器里 `/bin/sh` 会报 `not found`，属于典型的"本地好好的，一上服务器就炸"。

### job 2 · build（构建推送，仅 push 时跑）

`needs: verify` + `if: github.event_name == 'push'`，即：质检通过且不是 PR 时才执行。

| 序号 | 步骤 | 说明 |
| --- | --- | --- |
| 1 | Checkout | 拉取代码 |
| 2 | 准备镜像标签 | 推导本次的 ref 标签，并判断是否要移动 `latest` |
| 3 | Setup Buildx | 启用 BuildKit 与 GitHub Actions 缓存 |
| 4 | 登录镜像仓库 | 用 Secrets 登录 `registry.cn-shenzhen.aliyuncs.com` |
| 5 | 生成 tags | 组装最终 `tags` 列表 |
| 6 | Build & Push | 构建 `./server` 镜像并推送 |
| 7 | 输出摘要 | 把镜像地址与标签写入 Job Summary |

构建时注入的元信息（对应 `server/Dockerfile` 里的 `ARG`）：

```yaml
build-args: |
  BUILD_DATE=${{ github.event.head_commit.timestamp }}
  VCS_REF=${{ github.sha }}
  BUILD_VERSION=${{ steps.meta.outputs.ref_tag }}
```

构建完可用 `docker inspect` 看到 OCI 标签（版本、提交号、构建时间），便于排查线上跑的是哪一版。

---

## 二、一次性配置：仓库 Secrets

打开 GitHub 仓库 → **Settings → Secrets and variables → Actions → New repository secret**，添加两个：

| Secret 名称 | 值 | 说明 |
| --- | --- | --- |
| `REGISTRY_USER` | 阿里云账号名（或已授权的 RAM 子账号） | 用于 `docker login` |
| `REGISTRY_PASSWORD` | 容器镜像服务的**固定密码** | 阿里云"访问凭证"里设置的密码，不是登录密码 |

> 密码不要写进任何文件。流水线里通过 `${{ secrets.REGISTRY_PASSWORD }}` 引用，日志中会自动打码。

---

## 三、触发规则与标签策略

### 触发条件

```yaml
on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:
    branches: [main]
  workflow_dispatch:            # 手动触发
    inputs:
      push_image:               # 勾选才构建推送，默认只跑质检
        type: boolean
        default: false
      image_tag:                # 可选，覆盖按分支推导的标签
        type: string
        default: ''
```

- 推送到 `main` → 跑质检 + 构建推送
- 打 `v*` 形式的 tag（如 `v1.0.0`）→ 跑质检 + 构建推送
- 提 PR 到 `main` → **只跑质检**，不构建不推送
- 手动触发 → 默认**只跑质检**；勾选 `push_image` 才构建推送

### 手动触发怎么用

进仓库 **Actions** 页 → 左侧选 `Build & Push Image` → 右上 **Run workflow**：

| 表单项 | 说明 |
| --- | --- |
| Use workflow from | 选要构建的分支 |
| `push_image` | 勾上才会构建并推送镜像；不勾只做质检（适合验证流水线是否正常） |
| `image_tag` | 可选。留空则按分支名推导；填了就用这个值做标签，例如 `hotfix-20261016` |

典型用途：
- **验证流水线**：不勾 `push_image` 跑一次，确认质检步骤全绿
- **补构建**：代码没变但需要重新出镜像时，直接手动跑
- **出临时镜像**：填 `image_tag` 打一个业务标签，不动 `latest`

> 手动触发时 `latest` 只在选取 `main` 分支时才会移动；选其他分支只推分支名标签。

### 标签推导

| 触发方式 | 推送的标签 | `latest` 是否移动 |
| --- | --- | --- |
| push 到 `main` | `latest`、`main`、`main-<短SHA>` | ✅ 移动 |
| push tag `v1.0.0` | `v1.0.0`、`v1.0.0-<短SHA>` | ❌ 不动 |
| 手动 · 选 `main` | `latest`、`main`、`main-<短SHA>` | ✅ 移动 |
| 手动 · 选其他分支 | `<分支名>`、`<分支名>-<短SHA>` | ❌ 不动 |
| 手动 · 填了 `image_tag` | `<自定义标签>`、`<自定义标签>-<短SHA>` | 仅选 `main` 时移动 |

**为什么这样设计**：`latest` 只跟随 `main`。如果给历史版本补打 tag 也去覆盖 `latest`，线上镜像会被悄悄回退到旧代码 —— 这是很隐蔽的事故。短 SHA 标签则是为了精确回滚。

### 并发控制

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

同一分支连续推送时，取消上一次未完成的构建，避免排队堆积。

---

## 四、日常使用

### 发一版到线上

```bash
git add -A
git commit -m "feat: xxx"
git push origin main
```

推送后到仓库 **Actions** 页看进度，完成后服务器上执行：

```bash
docker compose pull api worker
docker compose up -d --no-build api worker
```

### 打版本标签

```bash
git tag v1.0.0
git push origin v1.0.0
```

### 回滚到某个提交

用短 SHA 标签把服务指回旧镜像：

```bash
# 在服务器 .env 中改成本次要回滚到的提交
IMAGE_TAG=registry.cn-shenzhen.aliyuncs.com/fanqx/study-helper-server:main-1a2b3c4

docker compose pull api worker
docker compose up -d --no-build api worker
```

---

## 五、服务器侧如何用这个镜像

服务器只需要 `docker-compose.yml`、`docker/initdb/`、`.env` 三样东西，不需要源码：

```bash
# 1. 登录镜像仓库
docker login registry.cn-shenzhen.aliyuncs.com

# 2. 指定使用 CI 构建好的镜像
echo 'IMAGE_TAG=registry.cn-shenzhen.aliyuncs.com/fanqx/study-helper-server:latest' >> .env

# 3. 拉镜像并启动（--no-build 表示不再本地构建）
docker compose pull api worker
docker compose up -d --no-build

# 4. 首次部署跑一次建表
docker compose --profile tools run --rm migrate
```

镜像本身是"一个镜像两种角色"：`api` 与 `worker` 用同一个镜像，靠 `command` 区分进程，所以只需构建一次。

---

## 六、常见问题

**Q：构建报 `npm ci` 失败 / 找不到 package-lock.json**
Dockerfile 已做兼容：有锁文件走 `npm ci`，没有则回退 `npm install`。但**建议尽早提交 `server/package-lock.json`**，`npm ci` 才能保证依赖版本可复现。

**Q：登录仓库 401 / denied**
八成是 `REGISTRY_PASSWORD` 填成了阿里云登录密码。要去「容器镜像服务 → 访问凭证」设置并复制固定密码。

**Q：verify 卡在"校验 LF 行尾"**
本地文件是 CRLF。仓库根目录已有 `.gitattributes` 统一 LF，执行一次下面命令再提交即可：

```bash
git add --renormalize .
git commit -m "chore: 统一行尾"
```

**Q：容器起来了但一直 unhealthy**
健康检查打的是 `/api/v1/health`。若改过路由前缀，要同步改 `server/Dockerfile` 里的 `HEALTHCHECK`。

**Q：`docker compose up` 后 api 反复重启**
先看日志 `docker compose logs -f api`。常见原因是 `.env` 里的数据库账号 / 密码与 `docker/initdb/01-init.sql` 不一致，或 MySQL 还没初始化完（`depends_on` 已配置健康检查依赖，正常会自动等待）。

**Q：push 到 main 但没触发流水线**
确认默认分支名。workflow 监听 `main`；若仓库默认分支是 `master`，要么把分支改名（`git branch -M main`），要么同步改 workflow 的 `branches`。

**Q：手动触发了但没构建镜像**
手动触发默认**只跑质检**。要构建得在 Run workflow 表单里勾选 `push_image`。这是有意设计的：手动跑最常见的原因是验证流水线本身，不该顺手推个镜像上去。

**Q：Actions 页面找不到 Run workflow 按钮**
`workflow_dispatch` 只在 workflow 文件**已存在于默认分支**后才生效。确认 `.github/workflows/docker-build.yml` 已经推到 `main`；刚加完需要等页面刷新，或强刷一次。

---

## 七、后续可增强

- 构建成功后自动 SSH 到服务器执行滚动更新
- 接入漏洞扫描（Trivy）与镜像体积检查
- 小程序端增加 CI 校验（如 `miniprogram-ci` 上传体验版）
