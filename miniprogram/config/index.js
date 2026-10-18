/**
 * 环境配置
 *
 * 注意：baseUrl 必须是已备案的 https 域名，
 * 并在微信公众平台「开发设置 → 服务器域名」中配置为 request 合法域名。
 */

const ENV = {
  // 本地联调：微信开发者工具需勾选「不校验合法域名」
  dev: {
    baseUrl: 'http://127.0.0.1:3000/api/v1',
    debug: true,
  },
  // 生产：Nginx 反向代理到后端，证书与域名配置见 docs/部署-Nginx与HTTPS.md
  prod: {
    baseUrl: 'https://rstu.top/api/v1',
    debug: false,
  },
};

// 切换环境改这里
const CURRENT = 'dev';

module.exports = {
  ...ENV[CURRENT],
  env: CURRENT,
  timeout: 30000,
  /** 图片压缩上限：1MB，超出会先压缩再上传 */
  imageMaxSize: 1024 * 1024,
  imageMaxWidth: 1600,
  /** 批改轮询间隔与超时 */
  pollInterval: 2000,
  pollTimeout: 90000,
  /** 单次最多上传图片数 */
  maxUploadCount: 9,
};
