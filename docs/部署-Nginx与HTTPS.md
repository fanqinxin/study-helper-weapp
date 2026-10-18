# 部署 · Nginx 与 HTTPS（rstu.top）

后端已经在 Docker 里跑起来了（`127.0.0.1:3000`），这一步把它用 HTTPS 暴露给微信。
配置文件：`deploy/nginx/rstu.top.conf`

---

## 一、先确认三件事

| 检查项 | 怎么确认 | 不满足的后果 |
| --- | --- | --- |
| 域名解析 | `dig +short rstu.top` 返回本机公网 IP | Nginx 收到请求但证书/回调全乱 |
| **ICP 备案** | 阿里云/腾讯云备案控制台查状态 | **微信不允许把未备案域名配成合法域名**，小程序直接调不通 |
| 安全组放行 80 / 443 | 云厂商控制台入方向规则 | 证书签不下来、HTTPS 访问超时 |

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

## 三、签发证书

### 关键顺序：先签证书，再放配置

配置里写了 `ssl_certificate .../fullchain.pem`，**文件不存在时 `nginx -t` 会直接失败**。
所以首次部署必须先把证书拿到手，再启用完整配置。

```bash
apt install -y certbot        # 或 yum install -y certbot

# 首次签发：standalone 模式会自己占用 80 端口，所以先停 nginx
systemctl stop nginx
certbot certonly --standalone \
  -d rstu.top -d www.rstu.top \
  --agree-tos -m 你的邮箱@example.com --no-eff-email

# 证书落在这里
ls /etc/letsencrypt/live/rstu.top/
# fullchain.pem  privkey.pem  chain.pem
```

> 如果 80 端口被占用/被封，改用 DNS-01 验证：
> `certbot certonly --manual --preferred-challenges dns -d rstu.top`
> 按提示去 DNS 加一条 TXT 记录即可。

> **只签主域名的情形**：上面的命令同时签了 `www.rstu.top`。如果 `www` 没做解析，
> certbot 会因为其中一条验证失败而**整单失败**。不需要 www 的话，
> 把命令里的 `-d www.rstu.top` 和配置里所有 ` www.rstu.top` 一起删掉。

### 之后续期

配置里已经放好了 ACME 校验路径（`/var/www/certbot`），续期可以走 webroot，不用停服务：

```bash
mkdir -p /var/www/certbot
certbot renew --webroot -w /var/www/certbot --deploy-hook "systemctl reload nginx"
```

certbot 装完自带 timer，`systemctl list-timers | grep certbot` 能看到。
手动验证一次续期流程：`certbot renew --dry-run`。

---

## 四、启用站点配置

```bash
cp deploy/nginx/rstu.top.conf /etc/nginx/conf.d/rstu.top.conf
mkdir -p /var/log/nginx

# 先校验，通过再重载
nginx -t && systemctl reload nginx
```

`nginx -t` 报错时不要 `reload`——旧配置还在跑，服务不会中断，修完再试。

---

## 五、验证

```bash
# 1. HTTP 是否正确跳转
curl -I http://rstu.top/api/v1/health
# 期望：301，Location: https://rstu.top/api/v1/health

# 2. HTTPS 是否通，后端依赖是否正常
curl -s https://rstu.top/api/v1/health | jq
# 期望：{"code":0,"msg":"ok","data":{"status":"ok","db":true,"redis":true,...}}

# 3. 证书链是否完整（小程序对证书链要求严格）
curl -vI https://rstu.top 2>&1 | grep -i "SSL certificate verify"
# 期望：SSL certificate verify ok

# 4. 安全响应头是否生效
curl -sI https://rstu.top/api/v1/health | grep -iE "strict-transport|nosniff|x-frame"
```

第 3 步如果报 `unable to verify the first certificate`，说明服务器没发中间证书——
用 `fullchain.pem` 而不是 `cert.pem` 就能解决（本配置用的就是 fullchain）。

---

## 六、微信侧的配置（必做）

### 1. 服务器域名

微信公众平台 → 开发 → 开发管理 → 开发设置 → 服务器域名，三个都要填同一个域名：

| 类型 | 填什么 |
| --- | --- |
| request 合法域名 | `https://rstu.top` |
| uploadFile 合法域名 | `https://rstu.top` |
| downloadFile 合法域名 | `https://rstu.top` |

限制：必须是 HTTPS、必须是 443 端口、不能带路径、不能用 IP、**必须已备案**。
每月只能改 5 次，想清楚再提交。

### 2. 小程序代码

`miniprogram/config/index.js` 里把环境切到 prod（`prod.baseUrl` 已配好 `https://rstu.top/api/v1`）：

```js
const CURRENT = 'prod';
```

开发阶段仍用 `dev` + 开发者工具勾选「不校验合法域名」。

---

## 七、常见问题

**502 Bad Gateway**
后端没起来或没监听 3000。查 `docker compose ps`、`docker compose logs -f api`，
再 `curl http://127.0.0.1:3000/api/v1/health` 直接从宿主机确认。

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
按顺序排查：域名是否备案 → 是否 HTTPS → 是否 443 端口 → 是否在微信后台填过 → 是否刚改过域名（有 5–10 分钟生效延迟）。

**访问 https://IP 而不是域名**
证书只对域名签发，用 IP 访问必然证书错误。这是预期行为。

---

## 八、后续可以做的优化

- 图片走 CDN：`/static/uploads/` 目前由 Node 提供，量大后建议 Nginx 直接读卷或上 OSS
- 加 `limit_req` 防刷：注意运营商 NAT 会让大量用户共享出口 IP，阈值别设太低
- HTTP/2：nginx ≥ 1.25.1 时在配置里打开 `http2 on;`
- 日志切割：`/etc/logrotate.d/nginx` 确认已按月轮转
