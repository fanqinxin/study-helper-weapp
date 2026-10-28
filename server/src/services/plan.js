/**
 * 学习计划服务
 *
 * 设计意图：计划不是让家长排课，而是系统根据"课堂进度 + 错题 + 今日作业"
 * 自动生成 3 件事，孩子完成打勾即可。降低家长操作负担是留存关键。
 */
const db = require('../models/db');
const logger = require('../utils/logger');

const TYPE = { LESSON: 1, MISTAKE: 2, HOMEWORK: 3, GAME: 4 };

/** 每天生成的任务上限，太多会让孩子放弃 */
const DAILY_TASKS = 3;

function today() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * 今日计划（不存在则按规则自动生成）
 */
async function getTodayPlan(uid) {
  const date = today();
  let tasks = await db.query(
    `SELECT id, plan_date AS planDate, title, type, ref_id AS refId, status,
            finished_at AS finishedAt
       FROM plan_task WHERE uid = ? AND plan_date = ? ORDER BY id ASC`,
    [uid, date]
  );

  if (!tasks.length) {
    tasks = await generatePlan(uid, date);
  }

  const list = tasks.map((t) => ({
    id: Number(t.id),
    title: t.title,
    type: Number(t.type),
    refId: t.refId ? Number(t.refId) : null,
    status: Number(t.status),
    done: Number(t.status) === 1,
    finishedAt: t.finishedAt,
  }));

  const done = list.filter((t) => t.done).length;
  return {
    planDate: date,
    total: list.length,
    done,
    percent: list.length ? Math.round((done / list.length) * 100) : 0,
    tasks: list,
  };
}

/**
 * 生成今日计划（幂等：同一天重复调用不会重复插入）
 */
async function generatePlan(uid, date = today()) {
  const user = await db.query('SELECT * FROM user WHERE id = ?', [uid]);
  if (!user.length) return [];

  const u = user[0];
  const suggestions = [];

  // 1. 同步课文练习：按课堂进度取下一课
  if (u.textbook_id) {
    const next = await db.query(
      `SELECT id, seq, title FROM lesson
        WHERE textbook_id = ? AND seq > ? ORDER BY seq ASC LIMIT 1`,
      [u.textbook_id, u.lesson_progress || 0]
    );
    if (next.length) {
      suggestions.push({
        title: `第${next[0].seq}课《${next[0].title}》练习`,
        type: TYPE.LESSON,
        refId: next[0].id,
      });
    }
  }

  // 2. 错题巩固：优先未掌握且错得多的
  const pending = await db.query(
    `SELECT COUNT(*) AS cnt FROM mistake WHERE uid = ? AND mastered = 0`,
    [uid]
  );
  if (Number(pending[0].cnt) > 0) {
    suggestions.push({
      title: `巩固 ${Math.min(Number(pending[0].cnt), 5)} 道错题`,
      type: TYPE.MISTAKE,
      refId: null,
    });
  }

  // 3. 作业批改：还没上传就提醒
  const hw = await db.query(
    `SELECT COUNT(*) AS cnt FROM homework WHERE uid = ? AND DATE(created_at) = ?`,
    [uid, date]
  );
  if (Number(hw[0].cnt) === 0) {
    suggestions.push({ title: '上传今天的作业给 AI 检查', type: TYPE.HOMEWORK, refId: null });
  }

  // 不足则补一个轻松的小游戏收尾，保证"每天有始有终"
  while (suggestions.length < DAILY_TASKS) {
    suggestions.push({ title: '玩一局识字小游戏', type: TYPE.GAME, refId: null });
  }

  const picked = suggestions.slice(0, DAILY_TASKS);

  return db.transaction(async (conn) => {
    const inserted = [];
    for (const s of picked) {
      // 先查后插，避免唯一索引缺失时重复插入
      const [exist] = await conn.query(
        'SELECT id FROM plan_task WHERE uid = ? AND plan_date = ? AND title = ? LIMIT 1',
        [uid, date, s.title]
      );
      if (exist.length) {
        inserted.push({ id: exist[0].id, plan_date: date, title: s.title, type: s.type, ref_id: s.refId, status: 0 });
        continue;
      }
      // conn 是原生连接，返回 [result, fields]，INSERT 的结果取第一个
      const [res] = await conn.query(
        `INSERT INTO plan_task (uid, plan_date, title, type, ref_id, status)
         VALUES (?, ?, ?, ?, ?, 0)`,
        [uid, date, s.title, s.type, s.refId]
      );
      inserted.push({ id: res.insertId, plan_date: date, title: s.title, type: s.type, ref_id: s.refId, status: 0 });
    }
    logger.info({ uid, date, count: inserted.length }, '生成今日学习计划');
    return inserted;
  });
}

/** 勾选/取消任务 */
async function toggleTask(uid, taskId, done = true) {
  const rows = await db.query(
    'SELECT id FROM plan_task WHERE id = ? AND uid = ?',
    [taskId, uid]
  );
  if (!rows.length) {
    const e = new Error('任务不存在');
    e.code = 4040;
    throw e;
  }

  await db.query(
    'UPDATE plan_task SET status = ?, finished_at = ? WHERE id = ?',
    [done ? 1 : 0, done ? new Date() : null, taskId]
  );
  return getTodayPlan(uid);
}

/** 一周完成率：给"我的"页与家长报告用 */
async function getWeekStats(uid) {
  const rows = await db.query(
    `SELECT plan_date AS planDate,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) AS done
       FROM plan_task
      WHERE uid = ? AND plan_date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
      GROUP BY plan_date ORDER BY plan_date ASC`,
    [uid]
  );

  const total = rows.reduce((s, r) => s + Number(r.total), 0);
  const done = rows.reduce((s, r) => s + Number(r.done), 0);

  return {
    days: rows.map((r) => ({
      planDate: r.planDate,
      total: Number(r.total),
      done: Number(r.done),
    })),
    total,
    done,
    rate: total ? Math.round((done / total) * 100) : 0,
  };
}

module.exports = { TYPE, DAILY_TASKS, getTodayPlan, generatePlan, toggleTask, getWeekStats };
