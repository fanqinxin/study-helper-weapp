/**
 * 家长端路由
 *
 * 数据都按"孩子 uid"聚合，每个接口先 parentOnly 再 assertChildAccess 双重校验。
 */
const express = require('express');
const parentService = require('../services/parent');
const { auth, parentOnly } = require('../middlewares/auth');
const { ok, wrap, CODES, fail } = require('../utils/response');

const router = express.Router();

/** 解析并校验 uid 参数 */
function parseChildUid(req, res) {
  const uid = Number(req.query.uid || (req.body && req.body.uid) || 0);
  if (!Number.isInteger(uid) || uid <= 0) {
    fail(res, CODES.BAD_REQUEST, '孩子 uid 不合法');
    return null;
  }
  return uid;
}

/** 家长首页概览（单孩子） */
router.get(
  '/parent/overview',
  auth,
  parentOnly,
  wrap(async (req, res) => {
    const childUid = parseChildUid(req, res);
    if (!childUid) return;
    await parentService.assertChildAccess(req.uid, childUid);
    ok(res, await parentService.getOverview(childUid));
  })
);

/** 家长周报详情（单孩子） */
router.get(
  '/parent/report',
  auth,
  parentOnly,
  wrap(async (req, res) => {
    const childUid = parseChildUid(req, res);
    if (!childUid) return;
    await parentService.assertChildAccess(req.uid, childUid);
    ok(res, await parentService.getReport(childUid));
  })
);

module.exports = router;
