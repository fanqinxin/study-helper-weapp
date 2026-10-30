/**
 * 数值参数清洗
 *
 * 背景：小程序曾把 undefined 序列化成字符串 `subject=undefined`，
 * 服务端 `Number('undefined')` 得到 NaN，被 mysql2 拼进 SQL →
 * `Unknown column 'NaN' in 'where clause'`。
 * 凡是来自 req.query / req.body 的数值字段，一律先过这里。
 */

/**
 * 安全整数转换
 * @param {*} v 原始值
 * @param {object} [opts]
 * @param {number} [opts.min]
 * @param {number} [opts.max]
 * @param {number} [opts.fallback] 无效时的默认值；不传则返回 undefined
 *   （配合调用方的 if 过滤，"参数不合法" 等价于 "没传"）
 */
function toInt(v, { min = -Infinity, max = Infinity, fallback } = {}) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

module.exports = { toInt };
