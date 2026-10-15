/**
 * 家长绑定
 * 对应设计稿 12
 *
 * 为什么用"孩子出示邀请码 + 家长输入"而不是家长扫码：
 * 孩子端没有生成图片的能力时，纯文本码最稳；而且孩子主动出示，
 * 天然带有"我知道你在看我的学习"的心理契约，比家长偷偷绑定更好。
 */
const api = require('../../utils/api');
const { setUser } = require('../../utils/auth');
const { getIcon } = require('../../styles/icons');
const app = getApp();

Page({
  data: {
    theme: 'light',
    /** 邀请码输入 */
    code: '',
    /** 已绑定的孩子 */
    children: [],
    loading: true,
    submitting: false,
    iconShield: '',
  },

  onLoad() {
    this.setData({
      theme: app.globalData.theme || 'light',
      iconShield: getIcon('shield', '#7DD3A0', 44),
    });
    this.loadChildren();
  },

  onThemeChanged(theme) {
    this.setData({ theme });
  },

  async loadChildren() {
    try {
      const children = await api.listChildren();
      this.setData({ loading: false, children });
    } catch (e) {
      this.setData({ loading: false, children: [] });
    }
  },

  onInput(e) {
    this.setData({ code: String(e.detail.value || '').toUpperCase() });
  },

  /** 提交绑定 */
  async onBind() {
    const code = String(this.data.code || '').trim().toUpperCase();
    if (code.length < 6) {
      wx.showToast({ title: '请输入完整的邀请码', icon: 'none' });
      return;
    }
    if (this.data.submitting) return;

    this.setData({ submitting: true });
    try {
      await api.bindFamily(code);
      wx.showToast({ title: '绑定成功', icon: 'success' });
      this.setData({ code: '' });
      await this.loadChildren();
    } catch (e) {
      // request 层已提示
    } finally {
      this.setData({ submitting: false });
    }
  },

  /** 进入家长首页 */
  onGoHome() {
    wx.reLaunch({ url: '/pages/parent/home' });
  },

  /** 切回孩子端 */
  onSwitchToChild() {
    wx.showModal({
      title: '切换到孩子端',
      content: '将以孩子身份重新登录，之前的学习记录都在。',
      success: async (r) => {
        if (!r.confirm) return;
        wx.showLoading({ title: '切换中', mask: true });
        try {
          const { login } = require('../../utils/auth');
          const data = await login(1);
          setUser(data.user);
          app.globalData.user = data.user;
          wx.hideLoading();
          wx.reLaunch({ url: '/pages/home/home' });
        } catch (e) {
          wx.hideLoading();
          wx.showToast({ title: '切换失败', icon: 'none' });
        }
      },
    });
  },
});
