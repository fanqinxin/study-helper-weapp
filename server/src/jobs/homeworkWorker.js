/**
 * 批改任务 Worker（独立进程）
 *
 * 为什么需要它：
 *   接口层用 setImmediate 触发批改只适合单机、低并发。
 *   一旦上量，AI 调用耗时（10-30s）会拖垮 Web 进程，
 *   所以抽出独立 worker，通过 Redis 队列消费。
 *
 * 启动：npm run worker
 * 与 API 服务共享同一套 service，保证逻辑只有一份。
 */
const db = require('../models/db');
const homeworkService = require('../services/homework');
const { redis } = require('../utils/redis');
const logger = require('../utils/logger');

const QUEUE_KEY = 'queue:homework:analyze';
const BLOCK_SECONDS = 5;

let running = true;

/**
 * 生产建议换成 bullmq；这里用最朴素的 LPUSH/BRPOP 队列，
 * 好处是零额外依赖，逻辑一目了然，方便早期调试。
 */
async function consumeOnce() {
  // BRPOP 阻塞等待，超时返回 null，避免空转
  const res = await redis.brpop(QUEUE_KEY, BLOCK_SECONDS);
  if (!res) return false;

  const [, payload] = res;
  let homeworkId;
  try {
    homeworkId = Number(JSON.parse(payload).homeworkId);
  } catch (e) {
    logger.error({ payload }, '队列消息解析失败，已丢弃');
    return true;
  }

  if (!homeworkId) return true;

  try {
    await homeworkService.runAnalyze(homeworkId);
  } catch (e) {
    // runAnalyze 内部已处理失败与退款，这里只兜底记录
    logger.error({ err: e.message, homeworkId }, 'worker 处理批改任务异常');
  }
  return true;
}

async function main() {
  logger.info(`批改 Worker 已启动，监听队列 ${QUEUE_KEY}`);

  try {
    await db.ping();
    logger.info('数据库连接正常');
  } catch (e) {
    logger.error({ err: e.message }, '数据库连接失败，worker 仍启动但会持续报错');
  }

  while (running) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const had = await consumeOnce();
      if (!had) continue;
    } catch (e) {
      logger.error({ err: e.message }, 'worker 循环异常，2 秒后重试');
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  logger.info('批改 Worker 已停止');
  await db.pool.end().catch(() => {});
  redis.disconnect();
  process.exit(0);
}

function shutdown(signal) {
  logger.info(`收到 ${signal}，等待当前任务结束后退出`);
  running = false;
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
  main().catch((e) => {
    logger.error({ err: e.message, stack: e.stack }, 'Worker 启动失败');
    process.exit(1);
  });
}

module.exports = { QUEUE_KEY, consumeOnce };
