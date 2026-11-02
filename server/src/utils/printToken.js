/**
 * 打印链接签名
 *
 * 打印页在浏览器打开（家长电脑 Ctrl+P），没有小程序登录态，
 * 所以用 HMAC 短期签名授权访问：token 里编码 kind/uid/资源ID/过期时间。
 * 密钥复用 JWT_SECRET —— 它已经受生产环境强校验，不会是弱密钥。
 */
const crypto = require('crypto');
const config = require('../config');

/** 打印链接有效期：7 天（作业是当天的事，足够长且不永久有效） */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @param {number} uid
 * @param {'practice'|'assignment'} kind
 * @param {number} resId
 */
function signPrintToken(uid, kind, resId) {
  const exp = Date.now() + TTL_MS;
  const body = `${kind}.${uid}.${resId}.${exp}`;
  const sig = crypto.createHmac('sha256', config.jwt.secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** 校验签名 + 过期时间 + 资源匹配，任一不符返回 false */
function verifyPrintToken(token, kind, resId) {
  const parts = String(token || '').split('.');
  if (parts.length !== 5) return false;
  const [k, uid, id, expStr, sig] = parts;
  const body = `${k}.${uid}.${id}.${expStr}`;
  const expect = crypto.createHmac('sha256', config.jwt.secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  if (k !== kind || Number(id) !== Number(resId)) return false;
  const exp = Number(expStr);
  return Number.isFinite(exp) && exp > Date.now();
}

module.exports = { signPrintToken, verifyPrintToken, TTL_MS };
