/**
 * 家长端数据服务
 *
 * 权限模型：家长（role=2）与自己 family_id 相同的孩子（role=1）之间可互看学习数据。
 * 所有按孩子 uid 查询的接口，都必须先过 assertChildAccess，防止改 uid 越权拉别人的数据。
 */
const db = require('../models/db');
const homeworkService = require('./homework');
const mistakeService = require('./mistake');
const planService = require('./plan');

/**
 * 校验家长对该孩子有查看权（同 family_id 且孩子 role=1）
 */
async function assertChildAccess(parentUid, childUid) {
  const [rows] = await db.query(
    `SELECT p.family_id
       FROM user p
       JOIN user c ON c.id = ? AND c.family_id = p.family_id AND c.role = 1
      WHERE p.id = ?`,
    [childUid, parentUid]
  );
  if (!rows.length) {
    const e = new Error('未绑定该孩子，无法查看');
    e.code = 4030;
    throw e;
  }
}

/**
 * 家长首页概览（对应设计稿 15）
 * 一次拉齐：孩子列表外层已给，这里只给单孩子的四指标 + 弱项 + 周趋势 + 最近批改
 */
async function getOverview(childUid) {
  const [week, stats, hwRes] = await Promise.all([
    planService.getWeekStats(childUid),
    mistakeService.getStats(childUid),
    homeworkService.listHomework(childUid, { page: 1, size: 5 }),
  ]);
  const list = hwRes.list;

  const scored = list.filter((h) => h.score !== null && h.score !== undefined);
  const weekRate = scored.length
    ? Math.round(scored.reduce((s, h) => s + Number(h.score), 0) / scored.length)
    : 0;

  return {
    overview: {
      planRate: week.rate,
      homeworkCount: hwRes.total,
      mistakePending: stats.pending,
      weekRate,
    },
    weakPoints: stats.topPoints || [],
    weekBars: (week.days || []).map((d) => ({
      planDate: d.planDate,
      total: d.total,
      done: d.done,
    })),
    latest: list.length ? list[0] : null,
  };
}

/**
 * 周报详情（对应设计稿 16）
 * Phase 4 可再加"真实学习时长 / 环比 / LLM 点评"，当前给的是可靠数据的聚合
 */
async function getReport(childUid) {
  const [stats, hwRes, week] = await Promise.all([
    mistakeService.getStats(childUid),
    homeworkService.listHomework(childUid, { page: 1, size: 20 }),
    planService.getWeekStats(childUid),
  ]);
  const list = hwRes.list;

  const scored = list.filter((h) => h.score !== null && h.score !== undefined);
  const scoreRate = scored.length
    ? Math.round(scored.reduce((s, h) => s + Number(h.score), 0) / scored.length)
    : 0;

  const levelText = scoreRate >= 85 ? '表现优秀'
    : scoreRate >= 70 ? '稳步前进'
    : scoreRate > 0 ? '需要关注' : '刚起步';

  return {
    summary: {
      levelText,
      trendText: week.rate >= 80 ? '本周任务完成度很高'
        : week.rate >= 50 ? '本周任务完成过半'
        : '本周任务完成偏少',
      homeworkCount: hwRes.total,
      scoreRate,
      mistakeCount: stats.pending,
      planRate: week.rate,
    },
    subjects: stats.bySubject || {},
    weakPoints: stats.topPoints || [],
    latest: list.length ? list[0] : null,
  };
}

module.exports = { assertChildAccess, getOverview, getReport };
