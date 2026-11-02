/**
 * 教材与课文路由
 */
const express = require('express');
const config = require('../config');
const textbookService = require('../services/textbook');
const practiceService = require('../services/practice');
const { signPrintToken } = require('../utils/printToken');
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

/**
 * 自定义教材识别进度（前端轮询）
 * 识别是异步任务：上传接口立即返回，这里查状态
 */
router.get(
  '/textbook/:id/status',
  auth,
  wrap(async (req, res) => ok(res, await textbookService.getCustomStatus(req.uid, req.params.id)))
);

/**
 * 重命名自定义教材
 */
router.patch(
  '/textbook/:id',
  auth,
  wrap(async (req, res) => {
    const { name } = req.body || {};
    ok(res, await textbookService.renameCustomTextbook(req.uid, req.params.id, name));
  })
);

/**
 * 删除自定义教材
 * 内置教材不允许删除（由运营维护）
 */
router.delete(
  '/textbook/:id',
  auth,
  wrap(async (req, res) => {
    ok(res, await textbookService.deleteCustomTextbook(req.uid, req.params.id));
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

/**
 * 设置「当前学到哪一课」
 *
 * 只改 user.lesson_progress（允许往回调），不扣额度、不触发 AI。
 */
router.post(
  '/lesson/:id/current',
  auth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, CODES.BAD_REQUEST, '课文 ID 不合法');
    ok(res, await textbookService.setCurrentLesson(req.uid, id));
  })
);

/**
 * 生成课后练习（自定义教材没有题库时用）
 *
 * 同样是一次长耗时 AI 调用：入队后立即返回，前端轮询 status。
 * 每次消耗 1 次额度，失败由 worker 自动退还；限流防连点。
 * body.count：5 / 10 / 15 / 20（其它值由 service 回落默认档，不报错）
 * body.force：true 时忽略已有题目重新生成（换一套题，覆盖旧题）
 */
router.post(
  '/lesson/:id/practice',
  auth,
  wrap(async (req, res, next) => {
    const allow = await rateLimit(`lesson_practice:${req.uid}`, 3, 60);
    if (!allow) return fail(res, CODES.RATE_LIMITED, '生成过于频繁，请稍后再试');
    next();
  }),
  wrap(async (req, res) => {
    const body = req.body || {};
    ok(res, await practiceService.createPractice(req.uid, req.params.id, body.count, !!body.force));
  })
);

/** 练习生成进度（前端轮询） */
router.get(
  '/lesson/:id/practice/status',
  auth,
  wrap(async (req, res) => {
    ok(res, await practiceService.getPracticeStatus(req.uid, req.params.id));
  })
);

/**
 * 换取练习题打印链接
 *
 * 打印页在电脑浏览器打开（个人主体小程序不支持 web-view，无法内嵌），
 * 返回带 HMAC 签名的 URL，7 天有效。不消耗额度。
 */
router.post(
  '/lesson/:id/practice/print-url',
  auth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, CODES.BAD_REQUEST, '课文 ID 不合法');

    // 校验归属：内置教材任何人可打，自定义教材仅限本人
    const lesson = await textbookService.getLesson(req.uid, id);
    if (!lesson.questions || !lesson.questions.length) {
      return fail(res, CODES.BAD_REQUEST, '这一课还没有练习题');
    }

    const token = signPrintToken(req.uid, 'practice', id);
    const base = config.upload.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
    ok(res, { url: `${base}/api/v1/print/practice/${id}?token=${token}` });
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
