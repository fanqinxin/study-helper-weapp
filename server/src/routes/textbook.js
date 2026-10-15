/**
 * 教材与课文路由
 */
const express = require('express');
const textbookService = require('../services/textbook');
const { auth } = require('../middlewares/auth');
const { ok, wrap, CODES, fail } = require('../utils/response');
const { rateLimit } = require('../utils/redis');

const router = express.Router();

/** 教材版本列表 */
router.get(
  '/textbook/list',
  auth,
  wrap(async (req, res) => {
    const { subject, grade, volume } = req.query;
    ok(res, {
      list: await textbookService.listTextbook(req.uid, { subject, grade, volume }),
    });
  })
);

/** 选择教材 */
router.post(
  '/textbook/select',
  auth,
  wrap(async (req, res) => {
    const { textbookId, lessonProgress } = req.body || {};
    if (!textbookId) return fail(res, CODES.BAD_REQUEST, '缺少 textbookId');
    ok(res, await textbookService.selectTextbook(req.uid, { textbookId, lessonProgress }));
  })
);

/**
 * 上传自定义教材
 * 会调 AI 识别目录，限流收紧到每分钟 2 次
 */
router.post(
  '/textbook/custom',
  auth,
  wrap(async (req, res, next) => {
    const allow = await rateLimit(`textbook_custom:${req.uid}`, 2, 60);
    if (!allow) return fail(res, CODES.RATE_LIMITED, '识别过于频繁，请稍后再试');
    next();
  }),
  wrap(async (req, res) => {
    const { subject, grade, volume, imageUrls, name } = req.body || {};
    if (!subject || !grade) {
      return fail(res, CODES.BAD_REQUEST, '请先选择学科与年级');
    }
    ok(res, await textbookService.createCustomTextbook(req.uid, {
      subject, grade, volume, imageUrls, name,
    }));
  })
);

/** 某本教材的课文列表（放在 /textbook/:id/lessons） */
router.get(
  '/textbook/:id/lessons',
  auth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, CODES.BAD_REQUEST, '教材 ID 不合法');
    ok(res, await textbookService.listLesson(req.uid, id));
  })
);

/** 课文详情 */
router.get(
  '/lesson/:id',
  auth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, CODES.BAD_REQUEST, '课文 ID 不合法');
    ok(res, await textbookService.getLesson(req.uid, id));
  })
);

/** 提交练习答案（本地判分，不消耗 AI 额度） */
router.post(
  '/lesson/:id/submit',
  auth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, CODES.BAD_REQUEST, '课文 ID 不合法');
    const { answers } = req.body || {};
    ok(res, await textbookService.submitLesson(req.uid, id, Array.isArray(answers) ? answers : []));
  })
);

module.exports = router;
