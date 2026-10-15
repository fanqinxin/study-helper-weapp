/**
 * 文件上传路由
 *
 * 前端流程：chooseImages（选图+压缩）→ uploadImages（逐张调本接口）→ 拿到 URL 数组 → 提交批改。
 */
const express = require('express');
const { auth } = require('../middlewares/auth');
const { singleUpload, toPublicUrl } = require('../middlewares/upload');
const { ok, wrap, CODES, fail } = require('../utils/response');
const { rateLimit } = require('../utils/redis');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * 上传单张图片
 * 限流：每分钟 30 张（一次批改最多 9 张，够用且防刷）
 */
router.post(
  '/upload/image',
  auth,
  wrap(async (req, res, next) => {
    const allow = await rateLimit(`upload:${req.uid}`, 30, 60);
    if (!allow) return fail(res, CODES.RATE_LIMITED, '上传过于频繁，请稍后再试');
    next();
  }),
  singleUpload,
  wrap(async (req, res) => {
    if (!req.file) return fail(res, CODES.BAD_REQUEST, '未接收到文件');

    const url = toPublicUrl(req.file);
    logger.info({ uid: req.uid, size: req.file.size }, '图片上传成功');
    ok(res, { url, size: req.file.size });
  })
);

module.exports = router;
