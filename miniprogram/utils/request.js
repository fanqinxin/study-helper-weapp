/**
 * 网络请求封装
 *
 * 要点：
 * 1. 自动带 token
 * 2. 401 自动跳登录
 * 3. 4010 额度不足统一唤起拦截页（业务侧不用各自处理）
 * 4. 错误统一 toast，业务代码只需关心成功分支
 */

const config = require('../config/index');
const { getToken, clearToken } = require('./auth');
const { CODE } = require('./constants');

/** 携带在途请求数，用于全局 loading（避免闪烁） */
let pending = 0;

function showLoadingIfNeeded() {
  pending += 1;
  if (pending === 1) {
    wx.showLoading({ title: '加载中', mask: true });
  }
}

function hideLoadingIfNeeded() {
  pending = Math.max(0, pending - 1);
  if (pending === 0) wx.hideLoading();
}

/**
 * 核心请求
 * @param {object} options
 * @param {string} options.url 相对路径，如 /homework/analyze
 * @param {string} [options.method] 默认 GET
 * @param {object} [options.data]
 * @param {boolean} [options.loading] 是否显示 loading
 * @param {boolean} [options.auth] 是否需要登录态，默认 true
 * @param {boolean} [options.handleQuota] 是否自动处理额度不足，默认 true
 */
function request(options) {
  const {
    url,
    method = 'GET',
    data = {},
    loading = false,
    auth = true,
    handleQuota = true,
    header = {},
  } = options;

  if (loading) showLoadingIfNeeded();

  return new Promise((resolve, reject) => {
    const token = getToken();
    if (auth && !token) {
      if (loading) hideLoadingIfNeeded();
      redirectToLogin();
      return reject(new Error('未登录'));
    }

    wx.request({
      url: `${config.baseUrl}${url}`,
      method: method.toUpperCase(),
      data,
      timeout: config.timeout,
      header: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...header,
      },
      success(res) {
        const body = res.data || {};

        // HTTP 层错误
        if (res.statusCode === 401) {
          clearToken();
          redirectToLogin();
          return reject(new Error('登录已过期'));
        }
        if (res.statusCode === 429) {
          wx.showToast({ title: '操作太频繁，稍后再试', icon: 'none' });
          return reject(new Error('请求过于频繁'));
        }
        if (res.statusCode >= 500) {
          wx.showToast({ title: '服务开小差了', icon: 'none' });
          return reject(new Error(body.msg || '服务异常'));
        }

        // 业务层错误
        if (body.code === CODE.OK) {
          return resolve(body.data);
        }

        // 额度不足：统一跳转拦截页，业务代码不需要处理
        if (handleQuota && body.code === CODE.QUOTA_INSUFFICIENT) {
          const balance = (body.data && body.data.balance) || {};
          wx.navigateTo({
            url: `/pages/wallet/insufficient?freeTotal=${balance.freeTotal || 0}`,
          });
          return reject({ code: body.code, msg: body.msg, silent: true });
        }

        // 其他业务错误
        const msg = body.msg || '操作失败';
        wx.showToast({ title: msg, icon: 'none', duration: 2000 });
        return reject({ code: body.code, msg });
      },
      fail(err) {
        wx.showToast({ title: '网络异常，请检查网络', icon: 'none' });
        reject(err);
      },
      complete() {
        if (loading) hideLoadingIfNeeded();
      },
    });
  });
}

function redirectToLogin() {
  wx.showToast({ title: '请先登录', icon: 'none' });
  setTimeout(() => {
    wx.reLaunch({ url: '/pages/home/home' });
  }, 800);
}

/** 语法糖 */
const http = {
  get: (url, data, opts = {}) => request({ url, method: 'GET', data, ...opts }),
  post: (url, data, opts = {}) => request({ url, method: 'POST', data, ...opts }),
  put: (url, data, opts = {}) => request({ url, method: 'PUT', data, ...opts }),
  del: (url, data, opts = {}) => request({ url, method: 'DELETE', data, ...opts }),
};

module.exports = { request, http };
