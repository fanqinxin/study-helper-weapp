/**
 * Redis 客户端（额度并发控制 / 批改任务状态 / 幂等锁）
 */
const Redis = require('ioredis');
const config = require('../config');
const logger = require('./logger');

const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  db: config.redis.db,
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    if (times > 5) {
      logger.error('Redis 重连次数超限，停止重试');
      return null;
    }
    return Math.min(times * 200, 2000);
  },
});

redis.on('error', (e) => logger.error({ err: e.message }, 'Redis 错误'));
redis.on('connect', () => logger.info('Redis 已连接'));

const KEY = {
  /** 批改任务状态：quota:task:{homeworkId} */
  task: (id) => `task:${id}`,
  /** 幂等锁：lock:analyze:{uid}:{hash} */
  analyzeLock: (uid, hash) => `lock:analyze:${uid}:${hash}`,
  /** 单用户并发批改限制 */
  userConcurrency: (uid) => `concurrency:uid:${uid}`,
  /** 接口限流 */
  rateLimit: (key) => `rl:${key}`,
};

/**
 * 简单的固定窗口限流
 * @returns {Promise<boolean>} true=放行 false=超限
 */
async function rateLimit(key, limit, windowSec) {
  const k = KEY.rateLimit(key);
  const n = await redis.incr(k);
  if (n === 1) await redis.expire(k, windowSec);
  return n <= limit;
}

/**
 * 获取幂等锁。成功返回 true，说明可以继续；false 表示已有同请求在处理。
 * 注意：锁需在 finally 中通过 releaseLock 释放。
 */
async function acquireLock(key, ttlSec = 30) {
  const r = await redis.set(key, '1', 'EX', ttlSec, 'NX');
  return r === 'OK';
}

async function releaseLock(key) {
  await redis.del(key).catch(() => {});
}

/** 任务状态读写 */
async function setTaskStatus(homeworkId, status, ttlSec = 3600) {
  await redis.set(KEY.task(homeworkId), String(status), 'EX', ttlSec);
}

async function getTaskStatus(homeworkId) {
  const v = await redis.get(KEY.task(homeworkId));
  return v === null ? null : Number(v);
}

module.exports = {
  redis,
  KEY,
  rateLimit,
  acquireLock,
  releaseLock,
  setTaskStatus,
  getTaskStatus,
};
