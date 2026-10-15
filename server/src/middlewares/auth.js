/**
 * 鉴权中间件：校验 JWT，把 uid 挂到 req 上
 */
const jwt = require('jsonwebtoken');
const config = require('../config');
const { fail, CODES } = require('../utils/response');

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token) {
    return fail(res, CODES.UNAUTHORIZED, '未登录', 401);
  }

  try {
    const payload = jwt.verify(token, config.jwt.secret);
    req.uid = Number(payload.uid);
    req.role = Number(payload.role || 1);
    next();
  } catch (e) {
    return fail(res, CODES.UNAUTHORIZED, '登录已过期，请重新登录', 401);
  }
}

/** 仅家长可访问 */
function parentOnly(req, res, next) {
  if (req.role !== 2) {
    return fail(res, CODES.UNAUTHORIZED, '需要家长身份', 403);
  }
  next();
}

/** 签发 token */
function sign(payload) {
  return jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
}

module.exports = { auth, parentOnly, sign };
