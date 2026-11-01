/**
 * 课后练习生成服务
 *
 * 为什么需要它：
 *   内置教材（is_custom=0）由运营预置题库；用户拍目录生成的自定义教材
 *   只有课文结构、没有任何题目。孩子点「开始练习」只会看到"这一课还没有练习题"。
 *   这里按需用文本模型出一套单选，让自定义教材也能练起来。
 *
 * 与教材识别的相同点：
 *   - 长耗时 AI 调用 → 走 Redis 队列 + worker，不占 HTTP 请求
 *   - 扣 1 次额度 → 失败自动退还，流水号固定为 lp-<lessonId>，保证幂等
 *
 * 差异：
 *   教材识别有 textbook.status 落库，这里没有额外表，
 *   用 Redis 键 practice:gen:<lessonId> 标记"正在生成"，过期即视为可重试。
 */
const db = require('../models/db');
const ai = require('../ai');
const quota = require('./quota');
const logger = require('../utils/logger');
const { toInt } = require('../utils/validate');
const { redis } = require('../utils/redis');

/** 出题队列（由 jobs/homeworkWorker.js 消费） */
const PRACTICE_QUEUE = 'queue:lesson:practice';

/** 生成中标记，与「已有题目」互斥 */
const STATUS_KEY = (lessonId) => `practice:gen:${lessonId}`;
const STATUS_TTL_SEC = 10 * 60;

/** 允许的题量档位（与小程序选择器一致，服务端只认这几档） */
const ALLOWED_COUNTS = [5, 10, 15, 20];
const DEFAULT_COUNT = 5;

/** 题量收敛：不合法就回落到默认档，不报错打断流程 */
function normalizeCount(count) {
  const n = toInt(count, { min: 1, max: 100 });
  return ALLOWED_COUNTS.includes(n) ? n : DEFAULT_COUNT;
}

/** 读取课文及其教材信息（带归属校验） */
async function loadLesson(uid, lessonId) {
  const id = toInt(lessonId, { min: 1 });
  if (id === undefined) {
    const e = new Error('课文 ID 不合法');
    e.code = 4000;
    throw e;
  }

  const rows = await db.query(
    `SELECT l.id, l.seq, l.title, l.unit, l.knowledge_points AS kp,
            t.id AS textbookId, t.subject, t.grade, t.name AS textbookName,
            t.is_custom AS isCustom
       FROM lesson l JOIN textbook t ON t.id = l.textbook_id
      WHERE l.id = ? AND (t.is_custom = 0 OR t.owner_uid = ?)`,
    [id, uid]
  );
  if (!rows.length) {
    const e = new Error('课文不存在');
    e.code = 4040;
    throw e;
  }
  return rows[0];
}

async function countQuestions(lessonId) {
  const rows = await db.query('SELECT COUNT(*) AS cnt FROM question WHERE lesson_id = ?', [lessonId]);
  return Number(rows[0] ? rows[0].cnt : 0);
}

/**
 * 发起生成任务
 *
 * 幂等：已有题目直接返回 ready；正在生成直接返回 pending，绝不重复扣费。
 * 题量只认 5/10/15/20 四档，其它值回落默认档（前端传错不该让用户白扣额度）。
 *
 * @param {number} [count] 期望题量
 */
async function createPractice(uid, lessonId, count) {
  const lesson = await loadLesson(uid, lessonId);
  const id = Number(lesson.id);
  const wantCount = normalizeCount(count);

  const existing = await countQuestions(id);
  if (existing > 0) {
    return { lessonId: id, status: 'ready', count: existing };
  }

  const running = await redis.get(STATUS_KEY(id));
  if (running) {
    return { lessonId: id, status: 'pending', count: 0 };
  }

  // NX 占位：并发连点时只有一个请求能拿到锁，避免重复扣费
  const locked = await redis.set(STATUS_KEY(id), String(uid), 'EX', STATUS_TTL_SEC, 'NX');
  if (!locked) {
    return { lessonId: id, status: 'pending', count: 0 };
  }

  const refId = `lp-${id}`;
  let consumed = false;
  try {
    await quota.consume(uid, refId, '生成课后练习消耗');
    consumed = true;

    await redis.lpush(
      PRACTICE_QUEUE,
      JSON.stringify({ lessonId: id, uid, refId, count: wantCount })
    );
  } catch (e) {
    await redis.del(STATUS_KEY(id)).catch(() => {});
    if (consumed) {
      await quota.refund(uid, refId, '练习生成任务创建失败退还').catch((err) =>
        logger.error({ err: err.message, uid, lessonId: id }, '退款失败，需人工介入')
      );
    }
    throw e;
  }

  // reqCount 一定要打：出题量不对时，日志里能立刻分清是
  // 「前端没传 / 老 worker 不认 count」还是「模型出题不足被补题逻辑拦下」
  logger.info({ uid, lessonId: id, reqCount: wantCount }, '练习生成任务已入队');
  return { lessonId: id, status: 'pending', count: wantCount };
}

/**
 * 执行生成（由 worker 调用）
 *
 * 重试时先清空旧题目，避免同一课堆积重复题。
 * 题量来自队列消息；老消息没有 count 字段时按默认档出题。
 */
async function runGeneratePractice(lessonId, uid, refId, count) {
  const id = Number(lessonId);
  if (!Number.isInteger(id) || id <= 0) return;
  const wantCount = normalizeCount(count);

  let lesson;
  try {
    lesson = await loadLesson(uid, id);
  } catch (e) {
    // 课文被删 / 归属变了：不能再出题，已扣的额度必须退回
    await redis.del(STATUS_KEY(id)).catch(() => {});
    await quota
      .refund(uid, refId || `lp-${id}`, '课文不可用退还')
      .catch(() => {});
    logger.warn({ lessonId: id, err: e.message }, '练习生成时课文不可用，已退款跳过');
    return;
  }

  const kp = lesson.kp
    ? (typeof lesson.kp === 'string' ? JSON.parse(lesson.kp) : lesson.kp)
    : [];

  try {
    const questions = await ai.generatePractice({
      subject: Number(lesson.subject),
      grade: Number(lesson.grade),
      unit: lesson.unit,
      title: lesson.title,
      count: wantCount,
    });

    await db.transaction(async (conn) => {
      await conn.query('DELETE FROM question WHERE lesson_id = ?', [id]);
      for (const q of questions) {
        await conn.query(
          `INSERT INTO question (lesson_id, type, stem, options, answer, analysis, difficulty)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [id, q.type || 1, q.stem, JSON.stringify(q.options), q.answer, q.analysis, q.difficulty]
        );
      }
    });

    logger.info(
      { uid, lessonId: id, reqCount: wantCount, count: questions.length },
      '课后练习生成成功'
    );
  } catch (e) {
    await quota
      .refund(uid, refId || `lp-${id}`, '课后练习生成失败退还')
      .catch((err) => logger.error({ err: err.message, uid, lessonId: id }, '退款失败，需人工介入'));
    logger.error({ err: e.message, uid, lessonId: id }, '课后练习生成失败');
  } finally {
    await redis.del(STATUS_KEY(id)).catch(() => {});
  }
}

/** 查询生成状态（练习页轮询） */
async function getPracticeStatus(uid, lessonId) {
  const lesson = await loadLesson(uid, lessonId);
  const id = Number(lesson.id);

  const count = await countQuestions(id);
  if (count > 0) return { lessonId: id, status: 'ready', count };

  const running = await redis.get(STATUS_KEY(id));
  if (running) return { lessonId: id, status: 'pending', count: 0 };

  return { lessonId: id, status: 'none', count: 0 };
}

module.exports = {
  PRACTICE_QUEUE,
  ALLOWED_COUNTS,
  DEFAULT_COUNT,
  createPractice,
  runGeneratePractice,
  getPracticeStatus,
};
