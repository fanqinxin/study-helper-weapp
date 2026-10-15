/**
 * 认证与用户路由
 */
const express = require('express');
const authService = require('../services/authService');
const { auth, parentOnly } = require('../middlewares/auth');
const { ok, wrap, CODES, fail } = require('../utils/response');
const { rateLimit } = require('../utils/redis');

const router = express.Router();

/** 登录/注册：限流防刷（同一 IP 每分钟 20 次） */
router.post(
  '/auth/login',
  wrap(async (req, res) => {
    const allow = await rateLimit(`login:${req.ip}`, 20, 60);
    if (!allow) return fail(res, CODES.RATE_LIMITED, '操作过于频繁，请稍后再试');

    const { code, role } = req.body || {};
    if (!code) return fail(res, CODES.BAD_REQUEST, '缺少 code');
    const result = await authService.login(code, Number(role) || 1);
    ok(res, result);
  })
);

/** 当前用户信息 */
router.get(
  '/user/profile',
  auth,
  wrap(async (req, res) => ok(res, await authService.getProfile(req.uid)))
);

/** 更新用户信息 */
router.post(
  '/user/profile',
  auth,
  wrap(async (req, res) => ok(res, await authService.updateProfile(req.uid, req.body || {})))
);

/** 生成绑定邀请码（孩子端） */
router.get(
  '/family/qrcode',
  auth,
  wrap(async (req, res) => ok(res, await authService.getInviteCode(req.uid)))
);

/** 家长绑定 */
router.post(
  '/family/bind',
  auth,
  parentOnly,
  wrap(async (req, res) => {
    const { inviteCode } = req.body || {};
    if (!inviteCode) return fail(res, CODES.BAD_REQUEST, '缺少邀请码');
    ok(res, await authService.bindFamily(req.uid, inviteCode));
  })
);

/** 家长查看孩子列表 */
router.get(
  '/family/children',
  auth,
  parentOnly,
  wrap(async (req, res) => ok(res, await authService.listChildren(req.uid)))
);

module.exports = router;
