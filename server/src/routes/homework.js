/**
 * 作业批改路由
 */
const express = require('express');
const homeworkService = require('../services/homework');
const quota = require('../services/quota');
const { auth } = require('../middlewares/auth');
const { ok, wrap, CODES, fail } = require('../utils/response');
const { rateLimit } = require('../utils/redis');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * 提交批改
 * 注意：额度扣减在 service 内完成，这里只负责参数校验与限流
 */
router.post(
  '/homework/analyze',
  auth,
  wrap(async (req, res) => {
    // 批改是重操作，严格限流：每分钟 5 次
    const allow = await rateLimit(`analyze:${req.uid}`, 5, 60);
    if (!allow) return fail(res, CODES.RATE_LIMITED, '提交过于频繁，请稍后再试');

    const { subject, imageUrls, lessonId } = req.body || {};
    if (!subject || !Array.isArray(imageUrls) || !imageUrls.length) {
      return fail(res, CODES.BAD_REQUEST, '参数不完整：需要 subject 与 imageUrls');
    }
    if (imageUrls.length > 9) {
      return fail(res, CODES.BAD_REQUEST, '单次最多上传 9 张图片');
    }

    try {
      const result = await homeworkService.submitAnalyze(req.uid, {
        subject: Number(subject),
        imageUrls,
        lessonId: lessonId ? Number(lessonId) : null,
      });

      // 立即触发异步批改（生产建议改为队列投递）
      setImmediate(() => {
        homeworkService.runAnalyze(result.homeworkId).catch((e) =>
          logger.error({ err: e.message, homeworkId: result.homeworkId }, '异步批改异常')
        );
      });

      ok(res, result);
    } catch (e) {
      // 额度不足：返回 4010，前端唤起拦截弹层
      if (e.code === quota.ERR.INSUFFICIENT) {
        const balance = await quota.getBalance(req.uid);
        return res.json({
          code: CODES.QUOTA_INSUFFICIENT,
          msg: e.message,
          data: { balance },
        });
      }
      throw e;
    }
  })
);

/**
 * 历史作业
 * 注意：必须放在 /homework/:id/* 之前，
 * 否则 list 会被当成 :id 匹配走（Express 按声明顺序匹配）。
 */
router.get(
  '/homework/list',
  auth,
  wrap(async (req, res) => {
    const { page = 1, size = 20 } = req.query;
    ok(res, await homeworkService.listHomework(req.uid, { page: Number(page), size: Number(size) }));
  })
);

/** 查询批改进度（前端轮询） */
router.get(
  '/homework/:id/status',
  auth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return fail(res, CODES.BAD_REQUEST, '作业 ID 不合法');
    }
    ok(res, await homeworkService.getStatus(req.uid, id));
  })
);

/** 批改报告 */
router.get(
  '/homework/:id/report',
  auth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return fail(res, CODES.BAD_REQUEST, '作业 ID 不合法');
    }
    ok(res, await homeworkService.getReport(req.uid, id));
  })
);

module.exports = router;
