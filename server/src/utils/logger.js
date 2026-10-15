/**
 * 日志：结构化输出，生产环境 JSON 便于采集，开发环境美化可读
 */
const pino = require('pino');
const config = require('../config');

const logger = pino({
  level: config.log.level,
  transport: config.isProd
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
  // 敏感字段脱敏，避免密钥写进日志
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'aiApiKey',
      'password',
      'secret',
      '*.apiKey',
      '*.secret',
    ],
    censor: '[REDACTED]',
  },
});

module.exports = logger;
