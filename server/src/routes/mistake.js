/**
 * 错题本路由
 */
const express = require('express');
const mistakeService = require('../services/mistake');
const { auth } = require('../middlewares/auth');
const { ok, wrap, CODES, fail } = require('../utils/response');

const router = express.Router();

/** 错题列表 */
router.get(
  '/mistake/list',
  auth,
  wrap(async (req, res) => {
    const { page = 1, size = 20, subject, mastered } = req.query;
    ok(res, {
      list: await mistakeService.listMistake(req.uid, { page, size, subject, mastered }),
    });
  })
);

/** 错题统计（注意：必须放在 /mistake/:id 之前） */
router.get(
  '/mistake/stats',
  auth,
  wrap(async (req, res) => ok(res, await mistakeService.getStats(req.uid)))
);

/** 单条错题详情 */
router.get(
  '/mistake/:id',
  auth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, CODES.BAD_REQUEST, '错题 ID 不合法');
    ok(res, await mistakeService.getMistake(req.uid, id));
  })
);

/** 重做错题 */
router.post(
  '/mistake/:id/retry',
  auth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, CODES.BAD_REQUEST, '错题 ID 不合法');
    const { answer } = req.body || {};
    ok(res, await mistakeService.retryMistake(req.uid, id, answer));
  })
);

module.exports = router;
