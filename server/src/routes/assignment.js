/**
 * 作业任务单路由
 *
 * 家长上传老师布置的作业截图 → AI 按学科生成打卡清单 → 逐项打勾。
 * 识别是长耗时视觉调用：入队立即返回，前端轮询 /assignment/:id/status。
 */
const express = require('express');
const config = require('../config');
const assignmentService = require('../services/assignment');
const { signPrintToken } = require('../utils/printToken');
const { auth } = require('../middlewares/auth');
const { ok, wrap, CODES, fail } = require('../utils/response');
const { rateLimit } = require('../utils/redis');

const router = express.Router();

/**
 * 提交作业截图
 * body: { imageUrls: string[], taskDate?: 'YYYY-MM-DD' }
 * 每次消耗 1 次额度；同一组截图重复提交幂等返回，不重复扣费。
 */
router.post(
  '/assignment',
  auth,
  wrap(async (req, res, next) => {
    const allow = await rateLimit(`assignment_create:${req.uid}`, 5, 60);
    if (!allow) return fail(res, CODES.RATE_LIMITED, '提交过于频繁，请稍后再试');
    next();
  }),
  wrap(async (req, res) => {
    const body = req.body || {};
    ok(res, await assignmentService.createAssignment(req.uid, {
      imageUrls: body.imageUrls,
      taskDate: body.taskDate,
    }));
  })
);

/** 识别进度（轮询） */
router.get(
  '/assignment/:id/status',
  auth,
  wrap(async (req, res) => {
    ok(res, await assignmentService.getParseStatus(req.uid, req.params.id));
  })
);

/** 任务单列表（默认最近 7 天；?date= 看指定日期） */
router.get(
  '/assignment/list',
  auth,
  wrap(async (req, res) => {
    ok(res, await assignmentService.listAssignments(req.uid, {
      date: req.query.date,
      limit: req.query.limit,
    }));
  })
);

/** 打卡 / 取消打卡 */
router.post(
  '/assignment/item/:id/toggle',
  auth,
  wrap(async (req, res) => {
    const done = req.body ? req.body.done : undefined;
    ok(res, await assignmentService.toggleItem(req.uid, req.params.id, done));
  })
);

/** 换取闯关单打印链接（浏览器打开，7 天有效，不消耗额度） */
router.post(
  '/assignment/:id/print-url',
  auth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, CODES.BAD_REQUEST, '任务单 ID 不合法');

    // 归属校验 + 必须已识别出任务
    const list = await assignmentService.listAssignments(req.uid, { limit: 31 });
    const target = list.find((a) => a.id === id && a.status === 1);
    if (!target) return fail(res, CODES.NOT_FOUND, '任务单不存在或还未识别完成');

    const token = signPrintToken(req.uid, 'assignment', id);
    const base = config.upload.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
    ok(res, { url: `${base}/api/v1/print/assignment/${id}?token=${token}` });
  })
);

module.exports = router;
