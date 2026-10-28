/**
 * 作业批改编排服务
 *
 * 这是最需要小心的一个文件：额度、任务状态、异常回滚都在这里。
 *
 * 提交批改的严格顺序（不可调换）：
 *   1. 幂等检查（同图重复提交直接返回原结果，不扣额度）
 *   2. 校验并原子扣减额度
 *   3. 写额度流水
 *   4. 创建 homework 记录（status=1 批改中）
 *   5. 投递任务，立即返回 homework_id
 *
 * 为什么必须"先扣额度再投递"：
 *   若等批改成功再扣，并发提交会超发，成本失控。
 */
const crypto = require('crypto');
const db = require('../models/db');
const quota = require('./quota');
const ai = require('../ai');
const logger = require('../utils/logger');
const { KEY, acquireLock, releaseLock, setTaskStatus } = require('../utils/redis');

const STATUS = {
  PENDING: 0,
  PROCESSING: 1,
  DONE: 2,
  FAILED: 3,
};

/** 图片 hash：用于幂等判断 */
function hashImages(imageUrls) {
  return crypto.createHash('sha256').update(imageUrls.join('|')).digest('hex').slice(0, 64);
}

/**
 * 提交批改任务
 *
 * @param {number} uid
 * @param {object} params
 * @param {number} params.subject 学科
 * @param {string[]} params.imageUrls 已上传到对象存储的图片地址
 * @param {number} [params.lessonId] 关联课文
 * @returns {Promise<{homeworkId:number, cached:boolean, quotaFrom:string}>}
 * @throws {quota.QuotaError} code=4010 额度不足
 */
async function submitAnalyze(uid, { subject, imageUrls, lessonId = null }) {
  if (!Array.isArray(imageUrls) || !imageUrls.length) {
    throw new Error('缺少作业图片');
  }

  const imageHash = hashImages(imageUrls);

  // ---- 1. 幂等检查：同一用户同一张作业不重复批改也不重复扣额度 ----
  const exist = await db.query(
    'SELECT id, status FROM homework WHERE uid = ? AND image_hash = ? LIMIT 1',
    [uid, imageHash]
  );
  if (exist.length && exist[0].status !== STATUS.FAILED) {
    logger.info({ uid, homeworkId: exist[0].id }, '命中幂等，直接返回已有结果');
    return { homeworkId: exist[0].id, cached: true, quotaFrom: 'none' };
  }

  // ---- 防止同一用户并发提交 ----
  const lockKey = KEY.analyzeLock(uid, imageHash);
  const gotLock = await acquireLock(lockKey, 30);
  if (!gotLock) {
    throw new Error('该作业正在处理中，请勿重复提交');
  }

  let homeworkId = null;
  try {
    // ---- 2. 原子扣减额度（不足会抛 QuotaError 4010）----
    const consumed = await quota.consume(uid, `pending-${imageHash}`, 'AI 批改消耗');

    // ---- 3. 创建批改记录 ----
    const res = await db.query(
      `INSERT INTO homework
         (uid, subject, lesson_id, image_urls, image_hash, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uid, subject, lessonId, JSON.stringify(imageUrls), imageHash, STATUS.PROCESSING]
    );
    homeworkId = res.insertId;

    // 把流水关联到真实的作业 ID，便于事后对账
    await db.query(
      'UPDATE quota_log SET ref_id = ? WHERE uid = ? AND ref_id = ? AND source = ?',
      [`hw-${homeworkId}`, uid, `pending-${imageHash}`, quota.SOURCE.CONSUME]
    );

    await setTaskStatus(homeworkId, STATUS.PROCESSING);

    logger.info({ uid, homeworkId, from: consumed.from }, '批改任务已创建');
    return { homeworkId, cached: false, quotaFrom: consumed.from };
  } catch (e) {
    // 扣了额度但创建记录失败 → 必须退还，否则用户白扣
    if (homeworkId === null && e.code !== quota.ERR.INSUFFICIENT) {
      await quota.refund(uid, `pending-${imageHash}`, '任务创建失败退还').catch((err) =>
        logger.error({ err: err.message, uid }, '退款失败，需人工介入')
      );
    }
    throw e;
  } finally {
    await releaseLock(lockKey);
  }
}

/**
 * 执行批改（由 worker 调用，不阻塞接口）
 *
 * 失败时：标记失败 + 退还额度 + 记录错误信息
 */
async function runAnalyze(homeworkId) {
  const rows = await db.query('SELECT * FROM homework WHERE id = ?', [homeworkId]);
  if (!rows.length) {
    logger.warn({ homeworkId }, '批改任务不存在');
    return;
  }
  const hw = rows[0];
  if (hw.status === STATUS.DONE) return;

  const imageUrls = typeof hw.image_urls === 'string' ? JSON.parse(hw.image_urls) : hw.image_urls;

  // 取课文上下文，提升判题准确率
  let ctx = { subject: hw.subject };
  if (hw.lesson_id) {
    const ls = await db.query(
      'SELECT title, knowledge_points FROM lesson WHERE id = ?',
      [hw.lesson_id]
    );
    if (ls.length) {
      ctx.lessonTitle = ls[0].title;
      ctx.knowledgePoints = ls[0].knowledge_points
        ? (typeof ls[0].knowledge_points === 'string'
            ? JSON.parse(ls[0].knowledge_points)
            : ls[0].knowledge_points)
        : [];
    }
  }

  try {
    const result = await ai.gradeHomework(imageUrls, ctx);

    await db.transaction(async (conn) => {
      await conn.query(
        `UPDATE homework
            SET status = ?, score = ?, total = ?, correct = ?,
                raw_result = ?, finished_at = NOW(), error_msg = NULL
          WHERE id = ?`,
        [
          STATUS.DONE, result.score, result.total, result.correct,
          JSON.stringify(result.raw), homeworkId,
        ]
      );

      // 逐题明细
      for (const item of result.items) {
        await conn.query(
          `INSERT INTO homework_item
             (homework_id, seq, stem, student_ans, correct_ans, is_correct, analysis)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            homeworkId, item.seq, item.stem, item.student_ans,
            item.correct_ans, item.is_correct, item.analysis,
          ]
        );
      }

      // 错题自动入本
      for (const item of result.items) {
        if (item.is_correct !== 0) continue;
        const [itemRow] = await conn.query(
          'SELECT id FROM homework_item WHERE homework_id = ? AND seq = ? LIMIT 1',
          [homeworkId, item.seq]
        );
        if (!itemRow.length) continue;
        await conn.query(
          `INSERT INTO mistake
             (uid, homework_item_id, subject, knowledge_point, wrong_count, mastered, last_wrong_at)
           VALUES (?, ?, ?, ?, 1, 0, NOW())`,
          [hw.uid, itemRow[0].id, hw.subject, item.knowledge_point]
        );
      }
    });

    await setTaskStatus(homeworkId, STATUS.DONE);
    logger.info({ homeworkId, score: result.score }, '批改任务完成');
  } catch (e) {
    logger.error({ err: e.message, homeworkId }, '批改失败');

    await db.query(
      'UPDATE homework SET status = ?, error_msg = ?, finished_at = NOW() WHERE id = ?',
      [STATUS.FAILED, String(e.message).slice(0, 255), homeworkId]
    );
    await setTaskStatus(homeworkId, STATUS.FAILED);

    // 失败了必须退额度，这是用户信任的基础
    await quota
      .refund(hw.uid, `hw-${homeworkId}`, '批改失败退还')
      .catch((err) => logger.error({ err: err.message, homeworkId }, '退款失败，需人工介入'));
  }
}

/** 查询批改状态（前端轮询） */
async function getStatus(uid, homeworkId) {
  const rows = await db.query(
    'SELECT id, status, error_msg FROM homework WHERE id = ? AND uid = ?',
    [homeworkId, uid]
  );
  if (!rows.length) {
    const err = new Error('作业不存在');
    err.code = 4040;
    throw err;
  }
  const hw = rows[0];
  return {
    homeworkId: hw.id,
    status: hw.status,
    failed: hw.status === STATUS.FAILED,
    errorMsg: hw.error_msg || null,
    // 失败时明确告知额度已退还，减少客诉
    refunded: hw.status === STATUS.FAILED,
  };
}

/** 获取批改报告 */
async function getReport(uid, homeworkId) {
  const rows = await db.query(
    'SELECT * FROM homework WHERE id = ? AND uid = ?',
    [homeworkId, uid]
  );
  if (!rows.length) {
    const err = new Error('作业不存在');
    err.code = 4040;
    throw err;
  }
  const hw = rows[0];

  const items = await db.query(
    `SELECT seq, stem, student_ans AS studentAns, correct_ans AS correctAns,
            is_correct AS isCorrect, analysis
       FROM homework_item WHERE homework_id = ? ORDER BY seq ASC`,
    [homeworkId]
  );

  return {
    homeworkId: hw.id,
    subject: hw.subject,
    status: hw.status,
    score: hw.score,
    total: hw.total,
    correct: hw.correct,
    createdAt: hw.created_at,
    items,
  };
}

/** 历史作业列表（带分页总数） */
async function listHomework(uid, { page = 1, size = 20 } = {}) {
  const offset = (page - 1) * size;
  const [rows, totalRows] = await Promise.all([
    db.query(
      `SELECT id, subject, status, score, total, correct, created_at AS createdAt
         FROM homework WHERE uid = ?
        ORDER BY id DESC LIMIT ? OFFSET ?`,
      [uid, Number(size), Number(offset)]
    ),
    db.query('SELECT COUNT(*) AS cnt FROM homework WHERE uid = ?', [uid]),
  ]);
  return { list: rows, total: Number(totalRows[0].cnt) };
}

module.exports = {
  STATUS,
  submitAnalyze,
  runAnalyze,
  getStatus,
  getReport,
  listHomework,
  hashImages,
};
