/**
 * 教材服务
 *
 * 两类教材：
 *   1. 内置版本（is_custom=0）—— 由运营预置，用户只能选
 *   2. 自定义教材（is_custom=1）—— 用户拍课本目录，AI 识别生成课文结构
 */
const db = require('../models/db');
const ai = require('../ai');
const quota = require('./quota');
const logger = require('../utils/logger');
const config = require('../config');
const { toInt } = require('../utils/validate');
const { redis } = require('../utils/redis');

const STATUS = { RECOGNIZING: 0, READY: 1, FAILED: 2 };

/** 目录识别队列（由 jobs/homeworkWorker.js 消费） */
const TEXTBOOK_QUEUE = 'queue:textbook:recognize';

/** 识别卡住多久视为失败（worker 挂掉 / 队列消息丢失的兜底） */
const RECOGNIZE_STALE_MS = 10 * 60 * 1000;

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
 * 取出「属于本人」的自定义教材，否则抛业务错误
 *
 * 内置教材（is_custom=0）由运营维护，用户既不能改名也不能删除，
 * 否则会把别人的课文一起改掉。
 */
async function assertOwnCustomTextbook(uid, textbookId) {
  const id = toInt(textbookId, { min: 1 });
  if (id === undefined) {
    const e = new Error('教材 ID 不合法');
    e.code = 4000;
    throw e;
  }

  const rows = await db.query(
    'SELECT id, name, is_custom AS isCustom, owner_uid AS ownerUid FROM textbook WHERE id = ?',
    [id]
  );
  if (!rows.length) {
    const e = new Error('教材不存在');
    e.code = 4040;
    throw e;
  }

  const tb = rows[0];
  if (!Number(tb.isCustom) || Number(tb.ownerUid) !== Number(uid)) {
    const e = new Error('内置教材不能修改或删除');
    e.code = 4000;
    throw e;
  }
  return { id, name: tb.name };
}

/** 重命名自定义教材 */
async function renameCustomTextbook(uid, textbookId, name) {
  const tb = await assertOwnCustomTextbook(uid, textbookId);
  const newName = String(name == null ? '' : name).trim();

  if (!newName) {
    const e = new Error('教材名称不能为空');
    e.code = 4000;
    throw e;
  }
  if (newName.length > 20) {
    const e = new Error('教材名称最多 20 个字');
    e.code = 4000;
    throw e;
  }

  await db.query('UPDATE textbook SET name = ? WHERE id = ? AND owner_uid = ?', [
    newName,
    tb.id,
    uid,
  ]);
  logger.info({ uid, textbookId: tb.id, from: tb.name, to: newName }, '自定义教材重命名');
  return { textbookId: tb.id, name: newName };
}

/**
 * 删除自定义教材
 *
 * 表和表之间没有外键，删除必须自己按依赖顺序清理：
 * question → lesson → textbook，同时把指向它的用户解绑，
 * 否则孩子会停在一个"教材已不存在"的空列表里。
 */
async function deleteCustomTextbook(uid, textbookId) {
  const tb = await assertOwnCustomTextbook(uid, textbookId);

  await db.transaction(async (conn) => {
    await conn.query('UPDATE user SET textbook_id = NULL, lesson_progress = 0 WHERE textbook_id = ?', [
      tb.id,
    ]);
    await conn.query(
      'DELETE q FROM question q JOIN lesson l ON l.id = q.lesson_id WHERE l.textbook_id = ?',
      [tb.id]
    );
    await conn.query('DELETE FROM lesson WHERE textbook_id = ?', [tb.id]);
    await conn.query('DELETE FROM textbook WHERE id = ? AND owner_uid = ?', [tb.id, uid]);
  });

  logger.info({ uid, textbookId: tb.id, name: tb.name }, '自定义教材已删除');
  return { textbookId: tb.id, deleted: true };
}

/**
 * 上传自定义教材：建记录 → 投递识别任务 → 立即返回
 *
 * 为什么是异步：
 *   目录识别要跑视觉模型，动辄 60-120 秒，而小程序 wx.request 默认 30 秒超时。
 *   同步请求必然先撞客户端超时，用户看到"失败"其实模型还在跑。
 *   改成任务 + 轮询，客户端只等短请求，耗时不再受前端超时限制。
 *
 * 额度：识别同样消耗 1 次 AI 额度，失败由 worker 自动退还。
 */
async function createCustomTextbook(uid, { subject, grade, volume = 1, imageUrls, name }) {
  if (!Array.isArray(imageUrls) || !imageUrls.length) {
    const e = new Error('请至少上传一张课本目录照片');
    e.code = 4000;
    throw e;
  }
  if (imageUrls.length > 6) {
    const e = new Error('目录照片最多 6 张，请只拍目录页');
    e.code = 4000;
    throw e;
  }

  const subjectNo = toInt(subject, { min: 1, max: 3 });
  const gradeNo = toInt(grade, { min: 1, max: 9 });
  const volumeNo = toInt(volume, { min: 1, max: 2, fallback: 1 });
  if (!subjectNo || !gradeNo) {
    const e = new Error('请选择学科和年级');
    e.code = 4000;
    throw e;
  }

  const res = await db.query(
    `INSERT INTO textbook (name, subject, grade, volume, is_custom, owner_uid, status)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
    [name || '我的教材', subjectNo, gradeNo, volumeNo, uid, STATUS.RECOGNIZING]
  );
  const textbookId = Number(res.insertId);
  // 流水号与教材一一对应，退款时也用这个号，便于对账
  const refId = `tb-${textbookId}`;

  try {
    // 扣额度放在建记录之后，这样流水号可以直接用教材 ID
    await quota.consume(uid, refId, '教材目录识别消耗');

    await redis.lpush(
      TEXTBOOK_QUEUE,
      JSON.stringify({ textbookId, uid, imageUrls })
    );

    logger.info({ uid, textbookId, images: imageUrls.length }, '教材识别任务已入队');
    return { textbookId, status: STATUS.RECOGNIZING, lessonCount: 0 };
  } catch (e) {
    // 记录已建但未能入队 → 清理记录并把额度退回，避免用户白扣
    await db
      .query('DELETE FROM textbook WHERE id = ? AND owner_uid = ? AND status = ?', [
        textbookId,
        uid,
        STATUS.RECOGNIZING,
      ])
      .catch(() => {});
    if (e.code !== quota.ERR.INSUFFICIENT) {
      await quota.refund(uid, refId, '教材识别任务创建失败退还').catch((err) =>
        logger.error({ err: err.message, uid, textbookId }, '退款失败，需人工介入')
      );
    }
    throw e;
  }
}

/**
 * 执行目录识别（由 worker 调用）
 *
 * 幂等：只有 status=识别中 的记录才会处理，重复投递 / 用户重复点都会被跳过。
 * 失败：标记失败 + 退还额度。
 */
async function runRecognize(textbookId, imageUrls) {
  const rows = await db.query('SELECT * FROM textbook WHERE id = ?', [textbookId]);
  if (!rows.length) {
    logger.warn({ textbookId }, '教材识别任务对应的记录不存在');
    return;
  }
  const tb = rows[0];
  if (Number(tb.status) !== STATUS.RECOGNIZING) {
    logger.info({ textbookId, status: tb.status }, '教材已非识别中状态，跳过');
    return;
  }

  const uid = Number(tb.owner_uid);
  try {
    const catalog = await ai.recognizeCatalog(imageUrls);
    if (!catalog.length) throw new Error('未识别到课文目录');

    await db.transaction(async (conn) => {
      // 重试时先清空旧课文，避免重复堆积
      await conn.query('DELETE FROM lesson WHERE textbook_id = ?', [textbookId]);
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
  } catch (e) {
    await db
      .query('UPDATE textbook SET status = ? WHERE id = ?', [STATUS.FAILED, textbookId])
      .catch(() => {});
    await quota.refund(uid, `tb-${textbookId}`, '教材识别失败退还').catch((err) =>
      logger.error({ err: err.message, uid, textbookId }, '退款失败，需人工介入')
    );
    logger.error({ err: e.message, uid, textbookId }, '自定义教材识别失败');
  }
}

/**
 * 查询自定义教材识别进度
 *
 * 轮询入口。同时兜底处理"卡在识别中"的记录：
 * worker 挂了或队列消息丢了，用户不至于永远看到"识别中"。
 */
async function getCustomStatus(uid, textbookId) {
  const id = toInt(textbookId, { min: 1 });
  if (id === undefined) {
    const e = new Error('教材 ID 不合法');
    e.code = 4000;
    throw e;
  }

  const rows = await db.query(
    'SELECT id, status, created_at AS createdAt FROM textbook WHERE id = ? AND owner_uid = ?',
    [id, uid]
  );
  if (!rows.length) {
    const e = new Error('教材不存在');
    e.code = 4040;
    throw e;
  }
  const tb = rows[0];
  let status = Number(tb.status);

  if (status === STATUS.RECOGNIZING) {
    const startedAt = new Date(tb.createdAt).getTime();
    if (Number.isFinite(startedAt) && Date.now() - startedAt > RECOGNIZE_STALE_MS) {
      await db.query('UPDATE textbook SET status = ? WHERE id = ?', [STATUS.FAILED, id]);
      await quota.refund(uid, `tb-${id}`, '教材识别超时退还').catch(() => {});
      logger.warn({ uid, textbookId: id }, '教材识别超时，已标记失败并退还额度');
      status = STATUS.FAILED;
    }
  }

  let lessonCount = 0;
  if (status === STATUS.READY) {
    const c = await db.query('SELECT COUNT(*) AS cnt FROM lesson WHERE textbook_id = ?', [id]);
    lessonCount = Number(c[0] ? c[0].cnt : 0);
  }

  return { textbookId: id, status, lessonCount };
}

/** 课文详情（含题目） */
async function getLesson(uid, lessonId) {
  const rows = await db.query(
    `SELECT l.*, t.name AS textbookName, t.subject, t.grade,
            t.is_custom AS textbookIsCustom
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
    /** 自定义教材只有课文结构，题目需要按需生成 */
    isCustom: !!Number(l.textbookIsCustom),
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
  // 先校验归属：自定义教材只有本人能提交，否则会推进别人的进度
  const own = await db.query(
    `SELECT l.id FROM lesson l JOIN textbook t ON t.id = l.textbook_id
      WHERE l.id = ? AND (t.is_custom = 0 OR t.owner_uid = ?)`,
    [lessonId, uid]
  );
  if (!own.length) {
    const e = new Error('课文不存在');
    e.code = 4040;
    throw e;
  }

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

/**
 * 设置「当前学到哪一课」
 *
 * lesson_progress 存的是「已学到的课序号」，列表据此算：
 *   passed  = seq <= progress
 *   current = seq === progress + 1
 * 所以选中第 N 课要把 progress 设成 N-1，这一课才会成为「当前」。
 *
 * 与 submitLesson 的 GREATEST 不同，这里**允许往回调**：
 * 孩子说这学期学到第 3 课，就该是第 3 课，不能被之前练过的进度顶回去。
 */
async function setCurrentLesson(uid, lessonId) {
  const id = toInt(lessonId, { min: 1 });
  if (id === undefined) {
    const e = new Error('课文 ID 不合法');
    e.code = 4000;
    throw e;
  }

  const rows = await db.query(
    `SELECT l.id, l.seq, l.textbook_id AS textbookId
       FROM lesson l JOIN textbook t ON t.id = l.textbook_id
      WHERE l.id = ? AND (t.is_custom = 0 OR t.owner_uid = ?)`,
    [id, uid]
  );
  if (!rows.length) {
    const e = new Error('课文不存在');
    e.code = 4040;
    throw e;
  }

  const seq = Number(rows[0].seq) || 1;
  const progress = Math.max(0, seq - 1);
  const textbookId = Number(rows[0].textbookId);

  // 课文可能属于另一本教材（不同学科），当前教材一起切过去，避免「当前课不在当前书里」
  await db.query(
    'UPDATE user SET lesson_progress = ?, textbook_id = ? WHERE id = ?',
    [progress, textbookId, uid]
  );

  logger.info({ uid, lessonId: id, seq, progress }, '用户调整当前课文');
  return { lessonId: id, seq, lessonProgress: progress, textbookId };
}

module.exports = {
  STATUS,
  TEXTBOOK_QUEUE,
  listTextbook,
  listLesson,
  selectTextbook,
  setCurrentLesson,
  renameCustomTextbook,
  deleteCustomTextbook,
  createCustomTextbook,
  runRecognize,
  getCustomStatus,
  getLesson,
  submitLesson,
};
