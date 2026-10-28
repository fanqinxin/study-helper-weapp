/**
 * 错题本服务
 *
 * 产品意图：错题不是收集箱，而是"要消灭的清单"。
 * 所以核心字段是 mastered（已掌握），重做答对两次自动标记掌握。
 */
const db = require('../models/db');
const logger = require('../utils/logger');

/** 答对多少次算掌握 */
const MASTER_STREAK = 2;

/**
 * 错题列表
 * @param {number} uid
 * @param {object} opts
 * @param {number} [opts.subject] 按学科筛选
 * @param {number} [opts.mastered] 0=未掌握 1=已掌握，不传=全部
 */
async function listMistake(uid, { page = 1, size = 20, subject, mastered } = {}) {
  const where = ['m.uid = ?'];
  const params = [uid];

  if (subject) { where.push('m.subject = ?'); params.push(Number(subject)); }
  if (mastered !== undefined && mastered !== '' && mastered !== null) {
    where.push('m.mastered = ?');
    params.push(Number(mastered));
  }

  const offset = (Number(page) - 1) * Number(size);
  params.push(Number(size), offset);

  const rows = await db.query(
    `SELECT m.id, m.subject, m.knowledge_point AS knowledgePoint,
            m.wrong_count AS wrongCount, m.mastered,
            m.last_wrong_at AS lastWrongAt,
            hi.stem, hi.student_ans AS studentAns, hi.correct_ans AS correctAns,
            hi.analysis, hi.seq
       FROM mistake m
       JOIN homework_item hi ON hi.id = m.homework_item_id
      WHERE ${where.join(' AND ')}
      ORDER BY m.mastered ASC, m.last_wrong_at DESC
      LIMIT ? OFFSET ?`,
    params
  );

  return rows.map((r) => ({
    id: Number(r.id),
    subject: Number(r.subject),
    knowledgePoint: r.knowledgePoint,
    wrongCount: Number(r.wrongCount),
    mastered: !!Number(r.mastered),
    lastWrongAt: r.lastWrongAt,
    stem: r.stem,
    studentAns: r.studentAns,
    correctAns: r.correctAns,
    analysis: r.analysis,
    seq: Number(r.seq),
  }));
}

/** 错题统计：给首页与错题本顶部用 */
async function getStats(uid) {
  // 全项目约定：db.query 返回「行数组」，一律不解构；要单行就取 [0]。
  // （conn.query 是原生驱动，返回 [rows, fields]，才需要解构 —— 两套写法不要混）
  const stats = await db.query(
    `SELECT
        COUNT(*)                                        AS total,
        SUM(CASE WHEN mastered = 0 THEN 1 ELSE 0 END)   AS pending,
        SUM(CASE WHEN mastered = 1 THEN 1 ELSE 0 END)   AS mastered
       FROM mistake WHERE uid = ?`,
    [uid]
  );
  const row = stats[0] || {};

  const bySubject = await db.query(
    `SELECT subject, COUNT(*) AS cnt FROM mistake
      WHERE uid = ? AND mastered = 0 GROUP BY subject`,
    [uid]
  );

  // 高频知识点 Top5：告诉孩子"最该补哪一块"
  const topPoints = await db.query(
    `SELECT knowledge_point AS knowledgePoint, COUNT(*) AS cnt
       FROM mistake
      WHERE uid = ? AND mastered = 0 AND knowledge_point IS NOT NULL
      GROUP BY knowledge_point ORDER BY cnt DESC LIMIT 5`,
    [uid]
  );

  return {
    total: Number(row.total || 0),
    pending: Number(row.pending || 0),
    mastered: Number(row.mastered || 0),
    bySubject: bySubject.map((s) => ({ subject: Number(s.subject), count: Number(s.cnt) })),
    topPoints: topPoints.map((p) => ({ knowledgePoint: p.knowledgePoint, count: Number(p.cnt) })),
  };
}

/** 单条错题详情 */
async function getMistake(uid, id) {
  const rows = await db.query(
    `SELECT m.id, m.subject, m.knowledge_point AS knowledgePoint,
            m.wrong_count AS wrongCount, m.mastered,
            hi.stem, hi.student_ans AS studentAns, hi.correct_ans AS correctAns, hi.analysis
       FROM mistake m JOIN homework_item hi ON hi.id = m.homework_item_id
      WHERE m.id = ? AND m.uid = ?`,
    [id, uid]
  );
  if (!rows.length) {
    const e = new Error('错题不存在');
    e.code = 4040;
    throw e;
  }
  const r = rows[0];
  return {
    id: Number(r.id),
    subject: Number(r.subject),
    knowledgePoint: r.knowledgePoint,
    wrongCount: Number(r.wrongCount),
    mastered: !!Number(r.mastered),
    stem: r.stem,
    studentAns: r.studentAns,
    correctAns: r.correctAns,
    analysis: r.analysis,
  };
}

/**
 * 重做错题
 *
 * 规则：
 * - 答对：wrong_count 归零；连续答对（用 wrong_count 负值计streak 不优雅，
 *   这里简化为"答对即减 1，减到 -MASTER_STREAK +1 视为掌握"不方便理解，
 *   所以采取更直白的规则：答对一次即掌握，答错则罪加一等）
 * - 答错：wrong_count + 1
 *
 * 采用直白规则的原因：小学生心智模型简单，"对了就过"比"连续两次"更好理解，
 * 也避免家长觉得系统在拖延。
 */
async function retryMistake(uid, id, studentAnswer) {
  const mistake = await getMistake(uid, id);
  const mine = String(studentAnswer ?? '').trim();
  const std = String(mistake.correctAns || '').trim();

  if (!std) {
    const e = new Error('该题缺少标准答案，无法判分');
    e.code = 4000;
    throw e;
  }

  const isCorrect = mine.toLowerCase() === std.toLowerCase();

  if (isCorrect) {
    // 答对：标记掌握 + 重做次数递减（保留 0 下限）
    await db.query(
      `UPDATE mistake SET mastered = 1, wrong_count = GREATEST(0, wrong_count - 1)
        WHERE id = ? AND uid = ?`,
      [id, uid]
    );
    logger.info({ uid, mistakeId: id }, '错题已攻克');
  } else {
    await db.query(
      `UPDATE mistake SET wrong_count = wrong_count + 1, last_wrong_at = NOW()
        WHERE id = ? AND uid = ?`,
      [id, uid]
    );
  }

  return {
    isCorrect,
    correctAnswer: mistake.correctAns,
    analysis: mistake.analysis,
    message: isCorrect ? '答对啦，这道题从错题本毕业了' : '再看一遍解析，下次一定对',
  };
}

module.exports = {
  MASTER_STREAK,
  listMistake,
  getStats,
  getMistake,
  retryMistake,
};
