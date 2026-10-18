/**
 * 服务入口
 */
const express = require('express');
const config = require('./config');
const logger = require('./utils/logger');
const db = require('./models/db');
const { redis } = require('./utils/redis');
const { CODES, fail } = require('./utils/response');
const { uploadDir, publicPrefix } = require('./models/storage');

const authRoutes = require('./routes/auth');
const homeworkRoutes = require('./routes/homework');
const quotaRoutes = require('./routes/quota');
const uploadRoutes = require('./routes/upload');
const textbookRoutes = require('./routes/textbook');
const mistakeRoutes = require('./routes/mistake');
const planRoutes = require('./routes/plan');
const parentRoutes = require('./routes/parent');

const app = express();

app.disable('x-powered-by');

/**
 * 反向代理：Nginx 转发后靠 X-Forwarded-For 还原真实客户端 IP。
 *
 * 不设置的话 req.ip 永远等于代理地址（127.0.0.1），
 * 而 login 限流正是以 req.ip 为键 —— 结果变成全站用户共用同一个额度。
 *
 * 默认只信任 1 跳（直接对端就是 Nginx）。业务端口仅绑定回环 / 内网，
 * 外部无法绕过 Nginx 直连伪造 X-Forwarded-For。
 * 若链路中间还有一层（如 CDN → Nginx → 应用），用 TRUST_PROXY 调大跳数。
 */
const trustProxy = (process.env.TRUST_PROXY || '').trim();
if (trustProxy) {
  app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
} else {
  app.set('trust proxy', 1);
}

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

/**
 * 静态资源：本地存储的作业图片
 * 生产建议换成 CDN，并把 uploadDir 指向对象存储的本地缓存目录。
 */
app.use(
  publicPrefix,
  express.static(uploadDir, {
    maxAge: '7d',
    // 禁止把上传目录当静态站点遍历出目录列表
    index: false,
    dotfiles: 'ignore',
  })
);

/** 访问日志 */
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    const cost = Date.now() - t0;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]({
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      cost,
      uid: req.uid,
    }, 'request');
  });
  next();
});

/** 健康检查（含依赖探活） */
app.get('/api/v1/health', async (req, res) => {
  const health = { status: 'ok', env: config.env, db: false, redis: false, uptime: Math.round(process.uptime()) };
  try {
    await db.ping();
    health.db = true;
  } catch (e) { /* 保持 false */ }
  try {
    health.redis = (await redis.ping()) === 'PONG';
  } catch (e) { /* 保持 false */ }

  const allOk = health.db && health.redis;
  health.status = allOk ? 'ok' : 'degraded';
  res.status(allOk ? 200 : 503).json({ code: 0, msg: 'ok', data: health });
});

/** 业务路由 */
app.use('/api/v1', authRoutes);
app.use('/api/v1', homeworkRoutes);
app.use('/api/v1', quotaRoutes);
app.use('/api/v1', uploadRoutes);
app.use('/api/v1', textbookRoutes);
app.use('/api/v1', mistakeRoutes);
app.use('/api/v1', planRoutes);
app.use('/api/v1', parentRoutes);

/** 404 */
app.use((req, res) => {
  fail(res, CODES.NOT_FOUND, '接口不存在', 404);
});

/** 统一错误处理 */
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const code = err.code && Number.isInteger(err.code) ? err.code : CODES.SERVER_ERROR;

  // 已知业务错误只记 warn，未知错误记 error 并带堆栈
  if (code === CODES.SERVER_ERROR) {
    logger.error({ err: err.message, stack: err.stack, url: req.originalUrl, uid: req.uid }, '服务器错误');
    return fail(res, code, config.isProd ? '服务异常，请稍后再试' : err.message);
  }

  logger.warn({ code, msg: err.message, url: req.originalUrl, uid: req.uid }, '业务错误');
  fail(res, code, err.message);
});

/** 启动 */
async function start() {
  try {
    await db.ping();
    logger.info('数据库连接正常');
  } catch (e) {
    logger.error({ err: e.message }, '数据库连接失败，服务仍启动但接口会报错');
  }

  const server = app.listen(config.port, () => {
    logger.info(`服务已启动: http://127.0.0.1:${config.port} (${config.env})`);
  });

  /** 优雅退出，避免请求被硬切 */
  const shutdown = (signal) => {
    logger.info(`收到 ${signal}，准备关闭服务`);
    server.close(async () => {
      await db.pool.end().catch(() => {});
      redis.disconnect();
      logger.info('服务已关闭');
      process.exit(0);
    });
    // 兜底：10 秒未关闭则强制退出
    setTimeout(() => process.exit(1), 10000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  start();
}

module.exports = app;
