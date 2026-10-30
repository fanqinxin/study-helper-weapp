/**
 * 教材服务
 *
 * 两类教材：
 *   1. 内置版本（is_custom=0）—— 由运营预置，用户只能选
 *   2. 自定义教材（is_custom=1）—— 用户拍课本目录，AI 识别生成课文结构
 */
const db = require('../models/db');
const ai = require('../ai');
const logger = require('../utils/logger');
const config = require('../config');
const { toInt } = require('../utils/validate');

const STATUS = { RECOGNIZING: 0, READY: 1, FAILED: 2 };

/** 教材版本列表：按学科+年级筛选 */
async function listTextbook(uid, { subject, grade, volume } = {}) {
  const where = ['status = 1', '(is_custom = 0 OR owner_uid = ?)'];
  const params = [uid];

  // query 参数可能是 'undefined' 这类脏字符串，清洗后再进 SQL
  const subjectNo = toInt(subject, { min: 1, max: 3 });
  const gradeNo = toInt(grade, { min: 1, max: 9 });
  const volumeNo = toInt(volume, { min: 1, max: 4 });
  if (subjectNo !== undefined) { where.push('subject = ?'); params.push(subjectNo); }
  if (gradeNo !== undefined) { where.push('grade = ?'); params.push(gradeNo); }
  if (volumeNo !== undefined) { where.push('volume = ?'); params.push(volumeNo); }

  const rows = await db.query(
    `SELECT id, name, subject, grade, volume, is_custom AS isCustom
       FROM textbook WHERE ${where.join(' AND ')}
      ORDER BY is_custom ASC, id ASC`,
    params
  );
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    subject: Number(r.subject),
    grade: Number(r.grade),
    volume: Number(r.volume),
    isCustom: !!Number(r.isCustom),
    subjectName: ai.SUBJECT_NAME[r.subject] || '',
  }));
}

/** 某本教材的课文列表 */
async function listLesson(uid, textbookId) {
  const tb = await db.query(
    'SELECT * FROM textbook WHERE id = ? AND (is_custom = 0 OR owner_uid = ?)',
    [textbookId, uid]
  );
  if (!tb.length) {
    const e = new Error('教材不存在');
    e.code = 4040;
    throw e;
  }

  const lessons = await db.query(
    `SELECT id, seq, title, unit, knowledge_points AS knowledgePoints
       FROM lesson WHERE textbook_id = ? ORDER BY seq ASC`,
    [textbookId]
  );

  return {
    textbook: {
      id: Number(tb[0].id),
      name: tb[0].name,
      subject: Number(tb[0].subject),
      grade: Number(tb[0].grade),
      volume: Number(tb[0].volume),
      isCustom: !!Number(tb[0].is_custom),
    },
    lessons: lessons.map((l) => ({
      id: Number(l.id),
      seq: Number(l.seq),
      title: l.title,
      unit: l.unit,
      knowledgePoints: l.knowledgePoints
        ? (typeof l.knowledgePoints === 'string' ? JSON.parse(l.knowledgePoints) : l.knowledgePoints)
        : [],
    })),
  };
}

/** 选择教材（同步写入用户表） */
async function selectTextbook(uid, { textbookId, lessonProgress = 0 }) {
  const tb = await db.query(
    'SELECT id, grade FROM textbook WHERE id = ? AND status = 1 AND (is_custom = 0 OR owner_uid = ?)',
    [textbookId, uid]
  );
  if (!tb.length) {
    const e = new Error('教材不存在或不可用');
    e.code = 4000;
    throw e;
  }

  await db.query(
    'UPDATE user SET textbook_id = ?, grade = ?, lesson_progress = ? WHERE id = ?',
    [textbookId, tb[0].grade, Number(lessonProgress) || 0, uid]
  );
  logger.info({ uid, textbookId }, '用户切换教材');
  return { textbookId: Number(textbookId) };
}

/**
 * 上传自定义教材：识别目录 → 建教材 → 建课文
 *
 * 注意：识别耗时长且消耗 AI 额度，这里同样走额度闸门。
 */
async function createCustomTextbook(uid, { subject, grade, volume = 1, imageUrls, name }) {
  if (!Array.isArray(imageUrls) || !imageUrls.length) {
    const e = new Error('请至少上传一张课本目录照片');
    e.code = 4000;
    throw e;
  }

  const res = await db.query(
    `INSERT INTO textbook (name, subject, grade, volume, is_custom, owner_uid, status)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
    [name || '我的教材', Number(subject), Number(grade), Number(volume), uid, STATUS.RECOGNIZING]
  );
  const textbookId = res.insertId;

  try {
    const catalog = await ai.recognizeCatalog(imageUrls);
    if (!catalog.length) throw new Error('未识别到课文目录');

    await db.transaction(async (conn) => {
      for (const item of catalog) {
        await conn.query(
          `INSERT INTO lesson (textbook_id, seq, title, unit, knowledge_points)
           VALUES (?, ?, ?, ?, ?)`,
          [textbookId, item.seq, item.title, item.unit, JSON.stringify([])]
        );
      }
      await conn.query('UPDATE textbook SET status = ? WHERE id = ?', [STATUS.READY, textbookId]);
    });

    logger.info({ uid, textbookId, count: catalog.length }, '自定义教材创建成功');
    return { textbookId: Number(textbookId), lessonCount: catalog.length, status: STATUS.READY };
  } catch (e) {
    await db.query('UPDATE textbook SET status = ? WHERE id = ?', [STATUS.FAILED, textbookId]);
    logger.error({ err: e.message, uid, textbookId }, '自定义教材识别失败');
    const err = new Error('目录识别失败，请拍清楚目录页后重试');
    err.code = 5001;
    throw err;
  }
}

/** 课文详情（含题目） */
async function getLesson(uid, lessonId) {
  const rows = await db.query(
    `SELECT l.*, t.name AS textbookName, t.subject, t.grade
       FROM lesson l JOIN textbook t ON t.id = l.textbook_id
      WHERE l.id = ? AND (t.is_custom = 0 OR t.owner_uid = ?)`,
    [lessonId, uid]
  );
  if (!rows.length) {
    const e = new Error('课文不存在');
    e.code = 4040;
    throw e;
  }
  const l = rows[0];

  const questions = await db.query(
    `SELECT id, type, stem, options, answer, analysis, difficulty
       FROM question WHERE lesson_id = ? ORDER BY id ASC`,
    [lessonId]
  );

  return {
    id: Number(l.id),
    seq: Number(l.seq),
    title: l.title,
    unit: l.unit,
    textbookName: l.textbookName,
    subject: Number(l.subject),
    grade: Number(l.grade),
    knowledgePoints: l.knowledge_points
      ? (typeof l.knowledge_points === 'string' ? JSON.parse(l.knowledge_points) : l.knowledge_points)
      : [],
    // 注意：answer 不下发给前端，避免孩子直接看答案；由 /lesson/:id/submit 判分
    questions: questions.map((q) => ({
      id: Number(q.id),
      type: Number(q.type),
      stem: q.stem,
      options: q.options ? (typeof q.options === 'string' ? JSON.parse(q.options) : q.options) : null,
      difficulty: Number(q.difficulty),
    })),
  };
}

/**
 * 提交课文练习答案并判分
 *
 * 为什么判分放服务端：答案不下发前端，孩子无法直接看到答案作弊。
 * 纯本地比对，不调 AI，所以不消耗额度。
 */
async function submitLesson(uid, lessonId, answers = []) {
  const questions = await db.query(
    'SELECT id, answer, analysis FROM question WHERE lesson_id = ?',
    [lessonId]
  );
  if (!questions.length) {
    const e = new Error('该课文暂无练习题');
    e.code = 4040;
    throw e;
  }

  const answerMap = new Map(answers.map((a) => [Number(a.questionId), String(a.answer ?? '').trim()]));
  const detail = questions.map((q) => {
    const mine = answerMap.get(Number(q.id));
    const std = String(q.answer).trim();
    return {
      questionId: Number(q.id),
      myAnswer: mine ?? null,
      correctAnswer: std,
      isCorrect: mine !== undefined && mine !== null && mine.toLowerCase() === std.toLowerCase(),
      analysis: q.analysis,
    };
  });

  const correct = detail.filter((d) => d.isCorrect).length;
  const total = detail.length;
  const score = Math.round((correct / total) * 100);

  // 推进课堂进度（答完一课就往前推，用于"同步课堂"体验）
  await db.query(
    `UPDATE user u
        JOIN lesson l ON l.id = ?
        SET u.lesson_progress = GREATEST(u.lesson_progress, l.seq)
      WHERE u.id = ?`,
    [lessonId, uid]
  ).catch(() => {});

  return { lessonId, total, correct, score, detail };
}

module.exports = {
  STATUS,
  listTextbook,
  listLesson,
  selectTextbook,
  createCustomTextbook,
  getLesson,
  submitLesson,
};
