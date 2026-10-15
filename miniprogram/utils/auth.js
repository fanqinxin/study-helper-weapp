/**
 * 登录态管理
 */
const { STORAGE_KEY } = require('./constants');

function getToken() {
  return wx.getStorageSync(STORAGE_KEY.TOKEN) || '';
}

function setToken(token) {
  wx.setStorageSync(STORAGE_KEY.TOKEN, token);
}

function clearToken() {
  wx.removeStorageSync(STORAGE_KEY.TOKEN);
  wx.removeStorageSync(STORAGE_KEY.USER);
}

function getUser() {
  return wx.getStorageSync(STORAGE_KEY.USER) || null;
}

function setUser(user) {
  wx.setStorageSync(STORAGE_KEY.USER, user);
}

function isLogged() {
  return !!getToken();
}

/** 是否家长身份 */
function isParent() {
  const u = getUser();
  return !!(u && Number(u.role) === 2);
}

/**
 * 微信登录并换取 token
 * @param {number} role 1=孩子 2=家长
 */
function login(role = 1) {
  return new Promise((resolve, reject) => {
    wx.login({
      success(res) {
        if (!res.code) {
          return reject(new Error('微信登录失败'));
        }
        // 延迟 require 避免循环依赖
        const { http } = require('./request');
        http
          .post('/auth/login', { code: res.code, role }, { auth: false, loading: true })
          .then((data) => {
            setToken(data.token);
            setUser(data.user);
            resolve(data);
          })
          .catch(reject);
      },
      fail: reject,
    });
  });
}

/** 确保已登录，未登录则自动登录 */
async function ensureLogin(role = 1) {
  if (isLogged()) return getUser();
  const data = await login(role);
  return data.user;
}

module.exports = {
  getToken,
  setToken,
  clearToken,
  getUser,
  setUser,
  isLogged,
  isParent,
  login,
  ensureLogin,
};
