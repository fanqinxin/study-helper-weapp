/**
 * 作业任务单服务
 *
 * 家长把老师布置作业的截图（班级群消息、通知等）拍下来上传，
 * AI 按学科整理成可逐项打勾的任务清单（"闯关"模式）。
 *
 * 模式与教材识别 / 练习生成一致：
 *   - 长耗时视觉 AI → Redis 队列 + worker，接口立即返回
 *   - 扣 1 次额度 → 失败自动退还
 *   - image_hash 唯一索引做幂等：同一张截图重复提交不重复扣费
 */
const crypto = require('crypto');
const db = require('../models/db');
const ai = require('../ai');
const quota = require('./quota');
const logger = require('../utils/logger');
const { toInt } = require('../utils/validate');
const { redis } = require('../utils/redis');

/** 识别队列（由 jobs/homeworkWorker.js 消费） */
const ASSIGNMENT_QUEUE = 'queue:assignment:parse';

const STATUS = {
  PARSING: 0,
  READY: 1,
  FAILED: 2,
};

const STATUS_KEY = (id) => `assignment:parse:${id}`;
const STATUS_TTL_SEC = 10 * 60;

/** 学科名（与 textbook 的 1/2/3 对齐，0=通用 4=其他） */
const SUBJECT_NAME = { 0: '每日必做', 1: '语文', 2: '数学', 3: '英语', 4: '其他' };

/** 最多几张截图（作业通知一般 1-3 张就够） */
const MAX_IMAGES = 6;

/** 用东八区时间生成 YYYY-MM-DD：容器 TZ 不保证 +08，不能裸用 toISOString */
function shanghaiToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function normalizeDate(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return shanghaiToday();
}

function hashImages(imageUrls) {
  return crypto.createHash('sha256').update(imageUrls.join('|')).digest('hex');
}

/** 归属校验：任务单必须属于当前用户 */
async function loadAssignment(uid, assignmentId) {
  const id = toInt(assignmentId, { min: 1 });
  if (id === undefined) {
    const e = new Error('任务单 ID 不合法');
    e.code = 4000;
    throw e;
  }
  const rows = await db.query('SELECT * FROM assignment WHERE id = ? AND uid = ?', [id, uid]);
  if (!rows.length) {
    const e = new Error('任务单不存在');
    e.code = 4040;
    throw e;
  }
  return rows[0];
}

async function loadItems(assignmentId) {
  return db.query(
    'SELECT id, subject, content, sort, done, done_at AS doneAt FROM assignment_item WHERE assignment_id = ? ORDER BY sort ASC, id ASC',
    [assignmentId]
  );
}

/**
 * 提交识别任务
 *
 * @param {number} uid
 * @param {object} params
 * @param {string[]} params.imageUrls 已上传的作业截图（相对路径）
 * @param {string} [params.taskDate] 作业所属日期，默认今天
 * @returns {Promise<{assignmentId:number, status:string, cached:boolean}>}
 * @throws {quota.QuotaError} code=4010 额度不足
 */
async function createAssignment(uid, { imageUrls, taskDate } = {}) {
  if (!Array.isArray(imageUrls) || !imageUrls.length) {
    const e = new Error('请先上传作业截图');
    e.code = 4000;
    throw e;
  }
  if (imageUrls.length > MAX_IMAGES) {
    const e = new Error(`最多上传 ${MAX_IMAGES} 张截图`);
    e.code = 4000;
    throw e;
  }
  const date = normalizeDate(taskDate);
  const imageHash = hashImages(imageUrls);
  const consumeRefId = `pending-${imageHash.slice(0, 56)}`;

  // ---- 幂等：同一用户同一组截图，直接返回已有任务单 ----
  const exist = await db.query(
    'SELECT id, status FROM assignment WHERE uid = ? AND image_hash = ? LIMIT 1',
    [uid, imageHash]
  );
  if (exist.length && exist[0].status !== STATUS.FAILED) {
    logger.info({ uid, assignmentId: exist[0].id }, '作业截图命中幂等，直接返回已有任务单');
    return {
      assignmentId: Number(exist[0].id),
      status: exist[0].status === STATUS.READY ? 'ready' : 'pending',
      cached: true,
    };
  }

  // 防并发重复扣费
  const lockKey = `lock:assignment:${uid}:${imageHash.slice(0, 32)}`;
  const locked = await redis.set(lockKey, String(uid), 'EX', 30, 'NX');
  if (!locked) {
    const e = new Error('任务正在创建中，请勿重复提交');
    e.code = 4000;
    throw e;
  }

  let assignmentId = null;
  try {
    await quota.consume(uid, consumeRefId, '识别作业任务消耗');

    const res = await db.query(
      `INSERT INTO assignment (uid, task_date, image_urls, image_hash, status)
       VALUES (?, ?, ?, ?, ?)`,
      [uid, date, JSON.stringify(imageUrls), imageHash, STATUS.PARSING]
    );
    assignmentId = res.insertId;

    // 流水号换成真实 ID，便于对账
    await db.query(
      'UPDATE quota_log SET ref_id = ? WHERE uid = ? AND ref_id = ? AND source = ?',
      [`as-${assignmentId}`, uid, consumeRefId, quota.SOURCE.CONSUME]
    );

    await redis.lpush(
      ASSIGNMENT_QUEUE,
      JSON.stringify({ assignmentId, uid, refId: `as-${assignmentId}` })
    );

    logger.info({ uid, assignmentId, date }, '作业识别任务已入队');
    return { assignmentId, status: 'pending', cached: false };
  } catch (e) {
    // 扣了额度但没建成任务 → 退款 + 清锁
    if (assignmentId === null && e.code !== quota.ERR.INSUFFICIENT) {
      await quota.refund(uid, consumeRefId, '任务创建失败退还').catch((err) =>
        logger.error({ err: err.message, uid }, '退款失败，需人工介入')
      );
    }
    throw e;
  } finally {
    await redis.del(lockKey).catch(() => {});
  }
}

/**
 * 执行识别（worker 调用）
 *
 * 幂等：已 READY 的任务单不再重复识别。
 * 失败：置 FAILED + 退款（流水号 as-<id>），前端轮询到 failed 可重新拍。
 */
async function runParseAssignment(assignmentId, uid, refId) {
  const id = toInt(assignmentId, { min: 1 });
  if (id === undefined) return;

  let row;
  try {
    row = await loadAssignment(uid, id);
  } catch (e) {
    await redis.del(STATUS_KEY(id)).catch(() => {});
    logger.warn({ assignmentId: id, err: e.message }, '作业任务单不可用，跳过识别');
    return;
  }
  if (Number(row.status) === STATUS.READY) {
    await redis.del(STATUS_KEY(id)).catch(() => {});
    return;
  }

  const failRefId = refId || `as-${id}`;
  try {
    const imageUrls = typeof row.image_urls === 'string'
      ? JSON.parse(row.image_urls)
      : row.image_urls || [];

    const parsed = await ai.recognizeAssignment(imageUrls);

    // 组内条目按顺序落库；sort 用组序×1000 + 条内序，保证前端按学科分组展示时顺序稳定
    let flat = 0;
    const items = [];
    for (const g of parsed.groups) {
      for (const content of g.items) {
        items.push([g.subject, content, flat]);
        flat += 1;
      }
    }

    await db.transaction(async (conn) => {
      await conn.query('DELETE FROM assignment_item WHERE assignment_id = ?', [id]);
      for (const [subject, content, sort] of items) {
        await conn.query(
          'INSERT INTO assignment_item (assignment_id, subject, content, sort) VALUES (?, ?, ?, ?)',
          [id, subject, content, sort]
        );
      }
      await conn.query(
        'UPDATE assignment SET title = ?, note = ?, status = ?, error = NULL WHERE id = ?',
        [parsed.title, parsed.note, STATUS.READY, id]
      );
    });

    logger.info({ uid, assignmentId: id, items: items.length }, '作业任务单识别成功');
  } catch (e) {
    await db
      .query('UPDATE assignment SET status = ?, error = ? WHERE id = ?', [
        STATUS.FAILED,
        String(e.message || '识别失败').slice(0, 255),
        id,
      ])
      .catch(() => {});
    await quota.refund(uid, failRefId, '作业识别失败退还').catch((err) =>
      logger.error({ err: err.message, uid, assignmentId: id }, '退款失败，需人工介入')
    );
    logger.error({ err: e.message, uid, assignmentId: id }, '作业任务单识别失败');
  } finally {
    await redis.del(STATUS_KEY(id)).catch(() => {});
  }
}

/** 识别进度（前端轮询） */
async function getParseStatus(uid, assignmentId) {
  const row = await loadAssignment(uid, assignmentId);
  const id = Number(row.id);
  if (Number(row.status) === STATUS.READY) {
    const items = await loadItems(id);
    return { assignmentId: id, status: 'ready', count: items.length };
  }
  if (Number(row.status) === STATUS.FAILED) {
    return { assignmentId: id, status: 'failed', error: row.error || '识别失败' };
  }
  return { assignmentId: id, status: 'pending', count: 0 };
}

/**
 * 任务单列表（含明细），按日期倒序
 * @param {object} [opts]
 * @param {string} [opts.date] 只看某一天（YYYY-MM-DD）
 * @param {number} [opts.limit] 默认 7
 */
async function listAssignments(uid, { date, limit } = {}) {
  const n = toInt(limit, { min: 1, max: 31, fallback: 7 });
  let rows;
  if (date) {
    const d = normalizeDate(date);
    rows = await db.query(
      'SELECT id, task_date AS taskDate, title, note, status, created_at AS createdAt FROM assignment WHERE uid = ? AND task_date = ? ORDER BY id DESC LIMIT ?',
      [uid, d, n]
    );
  } else {
    rows = await db.query(
      'SELECT id, task_date AS taskDate, title, note, status, created_at AS createdAt FROM assignment WHERE uid = ? ORDER BY task_date DESC, id DESC LIMIT ?',
      [uid, n]
    );
  }
  if (!rows.length) return [];

  const ids = rows.map((r) => Number(r.id));
  const placeholders = ids.map(() => '?').join(',');
  const items = await db.query(
    `SELECT id, assignment_id AS assignmentId, subject, content, sort, done, done_at AS doneAt
       FROM assignment_item WHERE assignment_id IN (${placeholders}) ORDER BY sort ASC, id ASC`,
    ids
  );
  const byAssignment = new Map();
  for (const it of items) {
    const key = Number(it.assignmentId);
    if (!byAssignment.has(key)) byAssignment.set(key, []);
    byAssignment.get(key).push({
      id: Number(it.id),
      subject: Number(it.subject),
      subjectName: SUBJECT_NAME[Number(it.subject)] || '其他',
      content: it.content,
      done: !!Number(it.done),
      doneAt: it.doneAt,
    });
  }
  return rows.map((r) => ({
    id: Number(r.id),
    taskDate: typeof r.taskDate === 'string' ? r.taskDate : String(r.taskDate).slice(0, 10),
    title: r.title,
    note: r.note,
    status: Number(r.status),
    statusText: Number(r.status) === STATUS.READY ? 'ready' : Number(r.status) === STATUS.FAILED ? 'failed' : 'pending',
    items: byAssignment.get(Number(r.id)) || [],
  }));
}

/** 打卡：勾选/取消一个事项（归属校验） */
async function toggleItem(uid, itemId, done) {
  const id = toInt(itemId, { min: 1 });
  if (id === undefined) {
    const e = new Error('任务 ID 不合法');
    e.code = 4000;
    throw e;
  }
  const rows = await db.query(
    `SELECT i.id, i.assignment_id
       FROM assignment_item i JOIN assignment a ON a.id = i.assignment_id
      WHERE i.id = ? AND a.uid = ?`,
    [id, uid]
  );
  if (!rows.length) {
    const e = new Error('任务不存在');
    e.code = 4040;
    throw e;
  }
  const flag = done === false ? 0 : 1; // 缺省视为勾选
  await db.query('UPDATE assignment_item SET done = ?, done_at = ? WHERE id = ?', [
    flag,
    flag ? new Date() : null,
    id,
  ]);
  return { id, done: !!flag };
}

module.exports = {
  ASSIGNMENT_QUEUE,
  STATUS,
  SUBJECT_NAME,
  createAssignment,
  runParseAssignment,
  getParseStatus,
  listAssignments,
  toggleItem,
};
