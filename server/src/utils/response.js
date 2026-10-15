/**
 * 统一响应体与错误码
 */
const CODES = {
  OK: 0,
  BAD_REQUEST: 4000,
  UNAUTHORIZED: 4001,
  NOT_FOUND: 4040,
  QUOTA_INSUFFICIENT: 4010, // 额度不足，前端据此唤起拦截弹层
  RATE_LIMITED: 4029,
  SERVER_ERROR: 5000,
  AI_FAILED: 5001,
};

/** 成功响应 */
function ok(res, data = {}) {
  res.json({ code: CODES.OK, msg: 'ok', data });
}

/** 失败响应 */
function fail(res, code, msg, httpStatus = 200) {
  res.status(httpStatus).json({ code, msg: msg || '请求失败', data: null });
}

/**
 * 异步路由包装器：自动 catch 并交给错误中间件
 */
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * 业务错误类
 */
class BizError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}

module.exports = { CODES, ok, fail, wrap, BizError };
