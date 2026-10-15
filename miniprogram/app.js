/**
 * 小程序入口
 */
const { ensureLogin, getUser } = require('./utils/auth');
const { STORAGE_KEY } = require('./utils/constants');
const { getSystemInfo } = require('./utils/system');

App({
  globalData: {
    user: null,
    systemInfo: null,
    /** 额度余额，多处复用，减少请求 */
    quota: null,
    /** 当前主题 light | dark */
    theme: 'light',
  },

  onLaunch() {
    // 系统信息提前算好，避免各页面重复计算
    this.globalData.systemInfo = getSystemInfo();

    // 恢复主题设置
    const savedTheme = wx.getStorageSync(STORAGE_KEY.THEME);
    if (savedTheme) {
      this.globalData.theme = savedTheme;
    } else {
      // 未设置过则跟随系统
      const sys = wx.getAppBaseInfo ? wx.getAppBaseInfo() : {};
      this.globalData.theme = sys.theme === 'dark' ? 'dark' : 'light';
    }

    // 静默登录（失败不阻断启动，页面会再次触发）
    this.silentLogin();

    // 监听系统主题变化
    if (wx.onThemeChange) {
      wx.onThemeChange((res) => {
        if (!wx.getStorageSync(STORAGE_KEY.THEME)) {
          this.setTheme(res.theme === 'dark' ? 'dark' : 'light');
        }
      });
    }
  },

  /** 静默登录 */
  async silentLogin(role = 1) {
    try {
      const user = await ensureLogin(role);
      this.globalData.user = user;
      return user;
    } catch (e) {
      // 登录失败不抛给用户，页面按未登录态渲染
      console.warn('[app] 静默登录失败', e);
      return null;
    }
  },

  /** 切换主题 */
  setTheme(theme) {
    this.globalData.theme = theme;
    wx.setStorageSync(STORAGE_KEY.THEME, theme);
    // 通知所有页面刷新
    const pages = getCurrentPages();
    pages.forEach((p) => {
      if (p && typeof p.onThemeChanged === 'function') {
        p.onThemeChanged(theme);
      }
    });
  },

  /** 刷新额度并广播（额度变更后调用） */
  async refreshQuota() {
    const api = require('./utils/api');
    try {
      const quota = await api.getQuotaBalance();
      this.globalData.quota = quota;
      const pages = getCurrentPages();
      pages.forEach((p) => {
        if (p && typeof p.onQuotaChanged === 'function') {
          p.onQuotaChanged(quota);
        }
      });
      return quota;
    } catch (e) {
      return null;
    }
  },
});
