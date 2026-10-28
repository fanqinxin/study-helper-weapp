# 部署 · Nginx 与 HTTPS（sh-api.rstu.top）

后端已经在 Docker 里跑起来了，这一步把它用 HTTPS 暴露给微信。
配置文件：`deploy/nginx/sh-api.rstu.top.conf`

> **为什么用子域名**：`sh-api.rstu.top` 只承载接口，主域名 `rstu.top` 和 `www.rstu.top` 保持空闲，
> 以后加官网、H5 活动页或管理后台都不冲突。**子域名继承主域名的 ICP 备案，不需要单独备案**，
> 但前提是主域名 `rstu.top` 本身已经备案。

---

## 一、先确认三件事

| 检查项 | 怎么确认 | 不满足的后果 |
| --- | --- | --- |
| 子域名解析 | `dig +short sh-api.rstu.top` 返回本机公网 IP | Nginx 收到请求但证书/回调全乱 |
| **ICP 备案** | 阿里云/腾讯云备案控制台查 `rstu.top` 的状态 | **微信不允许把未备案域名配成合法域名**，小程序直接调不通 |
| 安全组放行 80 / 443 | 云厂商控制台入方向规则 | HTTPS 访问超时、证书校验失败 |

DNS 只需要加一条记录，**只加 `sh-api` 这一条主机记录，不要动 `@` 和 `www`**：

| 记录类型 | 主机记录 | 记录值 |
| --- | --- | --- |
| A | `sh-api` | 服务器公网 IP |

> `.top` 是工信部批复的顶级域，可以备案。但备案通常要 7–20 个工作日，是和开发并行的长周期事项——**没有备案，后面所有微信侧配置都做不了**，建议先确认这个。

---

## 二、装 Nginx

```bash
# Debian / Ubuntu
apt update && apt install -y nginx

# CentOS / Rocky
yum install -y nginx && systemctl enable --now nginx
```

先关掉默认站点，避免它抢占 80 端口的 `default_server`：

```bash
rm -f /etc/nginx/sites-enabled/default        # Debian/Ubuntu
# CentOS 改 /etc/nginx/nginx.conf 里自带的 server 块
```

---

## 三、部署证书（阿里云泛域名证书）

当前用的是阿里云签发的 **`*.rstu.top` 泛域名证书**，一张证书覆盖所有一级子域，
所以以后再加 `admin.rstu.top`、`h5.rstu.top` 都不用重新申请。

### 1. 下载并上传

阿里云控制台 → 数字证书管理服务 → 证书管理 → 下载 → 选 **Nginx** 格式，
解压后得到一个目录（目录名自带 `*`）和两个必需文件：

```
*.rstu.top_rstu.top_EC256/
  ├── fullchain.cer     ← 证书 + 中间证书链，Nginx 用这个
  └── private.key       ← 私钥
```

上传到配置里写的路径：

```bash
mkdir -p '/etc/nginx/ssl'
scp -r '*.rstu.top_rstu.top_EC256' root@服务器:/etc/nginx/ssl/

# 权限收紧：私钥不能让其他用户读到
chmod 700 '/etc/nginx/ssl/*.rstu.top_rstu.top_EC256'
chmod 600 '/etc/nginx/ssl/*.rstu.top_rstu.top_EC256/private.key'
```

> 目录名里的 `*` 是阿里云打包时带上的。Nginx 不做通配展开、按字面路径打开，
> 所以能直接用。但 `cp`、`rsync`、备份脚本会把它当通配符展开，命令行里记得用引号包起来。
> 嫌麻烦可以改名，例如 `mv '/etc/nginx/ssl/*.rstu.top_rstu.top_EC256' /etc/nginx/ssl/rstu.top`，
> 再同步改配置里的两行 `ssl_certificate`。

### 2. 关键顺序：先放证书，再启用配置

配置里写了 `ssl_certificate`，**文件不存在时 `nginx -t` 会直接失败**，
所以必须先把证书放到位，再放站点配置。

### 3. 到期续期

阿里云免费 DV 证书通常是 **3 个月或 1 年**，到期不会自动续，需要手动重新签发：

1. 控制台重新申请证书（泛域名证书要重新做 DNS 验证）
2. 下载新的 Nginx 包，覆盖 `/etc/nginx/ssl/` 下的两个文件
3. `nginx -t && systemctl reload nginx`

建议在日历上设个到期前 15 天的提醒。证书过期后小程序所有请求会直接失败，
而且错误信息只有一句「网络请求失败」，很难往证书上想。

---

## 四、启用站点配置

```bash
cp deploy/nginx/sh-api.rstu.top.conf /etc/nginx/conf.d/sh-api.rstu.top.conf
mkdir -p /var/log/nginx

# 先校验，通过再重载
nginx -t && systemctl reload nginx
```

`nginx -t` 报错时不要 `reload`——旧配置还在跑，服务不会中断，修完再试。

### 上游地址要对齐

配置里 `upstream` 写的是 `172.17.0.29:3000`。这个地址必须和 `docker-compose.yml`
里的端口映射对得上，否则一定 502：

| compose 的 `ports` | Nginx 的 `upstream` 应该写 |
| --- | --- |
| `127.0.0.1:3000:3000`（默认，只监听回环） | `127.0.0.1:3000` |
| `3000:3000`（监听所有网卡） | 宿主机 IP 或 `127.0.0.1` |
| 直接写容器 IP，如 `172.17.0.x` | **不要这样**，容器重建后 IP 会变 |

验证方法：

```bash
docker compose ps                     # 看 api 的端口映射
curl -s http://127.0.0.1:3000/api/v1/health   # 宿主机上直连后端
```

如果 `127.0.0.1:3000` 通、`172.17.0.29:3000` 不通，就把 upstream 改回 `127.0.0.1:3000`。

---

## 五、验证

```bash
# 1. HTTP 是否正确跳转
curl -I http://sh-api.rstu.top/api/v1/health
# 期望：301，Location: https://sh-api.rstu.top/api/v1/health

# 2. HTTPS 是否通，后端依赖是否正常
curl -s https://sh-api.rstu.top/api/v1/health | jq
# 期望：{"code":0,"msg":"ok","data":{"status":"ok","db":true,"redis":true,...}}

# 3. 证书链是否完整（小程序对证书链要求严格）
curl -vI https://sh-api.rstu.top 2>&1 | grep -i "SSL certificate verify"
# 期望：SSL certificate verify ok

# 4. 证书覆盖的域名对不对
echo | openssl s_client -connect sh-api.rstu.top:443 -servername sh-api.rstu.top 2>/dev/null \
  | openssl x509 -noout -subject -dates

# 5. 安全响应头是否生效
curl -sI https://sh-api.rstu.top/api/v1/health | grep -iE "strict-transport|nosniff|x-frame"
```

第 3 步如果报 `unable to verify the first certificate`，说明服务器没发中间证书——
必须用 `fullchain.cer`（含证书链）而不是只有站点证书的文件。

---

## 六、微信侧的配置（必做）

### 1. 服务器域名

微信公众平台 → 开发 → 开发管理 → 开发设置 → 服务器域名，三个都填**子域名**：

| 类型 | 填什么 |
| --- | --- |
| request 合法域名 | `https://sh-api.rstu.top` |
| uploadFile 合法域名 | `https://sh-api.rstu.top` |
| downloadFile 合法域名 | `https://sh-api.rstu.top` |

限制：必须是 HTTPS、必须是 443 端口、不能带路径、不能用 IP、**必须已备案**。
每月只能改 5 次，想清楚再提交。

> 填 `https://sh-api.rstu.top`，**不要填** `https://rstu.top` 或 `https://www.rstu.top`——
> 微信的域名校验是精确匹配，主域名和子域名不互通。

### 2. 小程序代码

`miniprogram/config/index.js` 里把环境切到 prod（`prod.baseUrl` 已配好 `https://sh-api.rstu.top/api/v1`）：

```js
const CURRENT = 'prod';
```

开发阶段仍用 `dev` + 开发者工具勾选「不校验合法域名」。

---

## 七、常见问题

**502 Bad Gateway**
后端没起来，或 `upstream` 地址与 compose 端口映射不一致（见第四节）。查 `docker compose ps`、
`docker compose logs -f api`，再 `curl http://127.0.0.1:3000/api/v1/health` 从宿主机确认。

**413 Request Entity Too Large**
请求体超了 `client_max_body_size`。当前设的 10m，后端单图上限 3MB。
要放宽就同时调整 `UPLOAD_MAX_SIZE_MB` 和 Nginx 这两处，别只改一边。

**504 Gateway Timeout**
AI 批改慢。当前 `proxy_read_timeout 180s`，对应后端 `AI_TIMEOUT_MS=60000` × 最多 2 次重试。
如果换了更慢的模型，两处要同步调。

**上传的图片 404**
图片落在 Docker 具名卷 `uploads-data` 里，路径 `/app/uploads`。
确认 API 容器挂了这个卷（`docker compose config | grep -A3 uploads`）。

**HTTPS 能开但微信仍报「不在合法域名列表中」**
按顺序排查：域名是否备案 → 是否 HTTPS → 是否 443 端口 → 是否在微信后台填过 **sh-api 子域** → 是否刚改过域名（有 5–10 分钟生效延迟）。

**浏览器提示证书无效 / 证书域名不匹配**
`openssl x509 -noout -subject` 看证书的 `DNS:* .rstu.top` 是否覆盖 `sh-api.rstu.top`（一级子域，覆盖）。
若显示的是别的域名，说明上传的证书包拿错了。

**访问 https://IP 而不是域名**
证书只对域名签发，用 IP 访问必然证书错误。这是预期行为。

**主域名 rstu.top 打不开**
预期行为。本配置只服务 `sh-api.rstu.top`，主域和 `www` 没有解析也没有 server 块。
以后要做官网时，另加一个 server 块即可（泛域名证书已经覆盖，不用重新申请），不影响接口。

---

## 八、后续可以做的优化

- 图片走 CDN：`/static/uploads/` 目前由 Node 提供，量大后建议 Nginx 直接读卷或上 OSS
- 加 `limit_req` 防刷：注意运营商 NAT 会让大量用户共享出口 IP，阈值别设太低
- HTTP/2：nginx ≥ 1.25.1 时在配置里打开 `http2 on;`
- OCSP stapling：当前关闭（配置里注释了），要开需要把中间证书链单独存一份并配 `ssl_trusted_certificate`
- 日志切割：`/etc/logrotate.d/nginx` 确认已按月轮转
- 证书到期提醒：泛域名证书不会自动续，建议加个日历提醒或监控探测
