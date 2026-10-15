/**
 * 学习计划路由
 */
const express = require('express');
const planService = require('../services/plan');
const { auth } = require('../middlewares/auth');
const { ok, wrap, CODES, fail } = require('../utils/response');

const router = express.Router();

/** 今日计划（不存在则自动生成） */
router.get(
  '/plan/today',
  auth,
  wrap(async (req, res) => ok(res, await planService.getTodayPlan(req.uid)))
);

/** 本周完成率 */
router.get(
  '/plan/week',
  auth,
  wrap(async (req, res) => ok(res, await planService.getWeekStats(req.uid)))
);

/** 勾选任务（注意放在 /plan/:id 相关之前） */
router.post(
  '/plan/task/:id/toggle',
  auth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, CODES.BAD_REQUEST, '任务 ID 不合法');
    const { done = true } = req.body || {};
    ok(res, await planService.toggleTask(req.uid, id, done !== false));
  })
);

module.exports = router;
