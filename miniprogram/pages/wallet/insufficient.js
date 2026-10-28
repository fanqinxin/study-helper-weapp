/**
 * 额度不足拦截
 * 对应设计稿 21
 *
 * 这一页最重要的是"给出去路"，而不是"卖额度"。
 * 用户被拦住时最容易流失，所以必须给出：
 *   1. 立刻能用（手动对答案，不消耗额度）
 *   2. 等一等（免费额度重置时间）
 *   3. 换脑子（小游戏）
 *
 * 内测阶段不提供购买入口：个人主体无法开通微信支付，
 * 页面出现价格或购买按钮在 iOS 端必被驳回。次数不够统一走管理员手动增加。
 */
const api = require('../../utils/api');
const app = getApp();

Page({
  data: {
    theme: 'light',
    balance: {
      freeLeft: 0, freeTotal: 20, nextResetAt: '',
      paidBalance: 0, monthly: false, totalLeft: 0,
    },
    resetText: '',
    /** 免费额度用完了还是整体用完 */
    freeUsedUp: true,
    /** 额度不足的原因文案 */
    reason: '本周免费批改次数已经用完了',
    iconWarning: '',
  },

  onLoad(options) {
    // request 层会把 freeTotal 带过来，便于在无网时也能渲染
    const freeTotal = Number(options.freeTotal) || 20;
    this.setData({
      theme: app.globalData.theme || 'light',
      'balance.freeTotal': freeTotal,
    });
    this.load();
  },

  onShow() {
    this.load();
  },

  onThemeChanged(theme) {
    this.setData({ theme });
  },

  async load() {
    try {
      const balance = await api.getQuotaBalance().catch(() => null);

      if (balance) {
        let resetText = '';
        if (balance.nextResetAt) {
          const d = new Date(balance.nextResetAt);
          resetText = `${d.getMonth() + 1}月${d.getDate()}日`;
        }
        // 免费还没用完却有余额，说明是赠送余量以外的部分不足
        const freeUsedUp = balance.freeLeft <= 0;
        this.setData({
          balance,
          resetText,
          freeUsedUp,
          reason: freeUsedUp
            ? '本周免费批改次数已经用完了'
            : '当前可用次数已经用完了',
        });
        app.globalData.quota = balance;
      }
    } catch (e) { /* 静默，页面用兜底文案渲染 */ }
  },

  /** 不消耗额度的出路：手动对答案 */
  onManualCheck() {
    wx.showModal({
      title: '手动对答案',
      content: '在「错题本」里可以看到每道题的标准答案和讲解，自己核对一样有效，而且不消耗额度。',
      confirmText: '去错题本',
      cancelText: '知道了',
      success: (r) => {
        if (r.confirm) wx.switchTab({ url: '/pages/mistake/list' });
      },
    });
  },

  /** 去玩小游戏（也是不消耗额度的正向出路） */
  onPlayGame() {
    wx.navigateTo({ url: '/pages/game/game' });
  },

  /** 先去做课文练习 */
  onGoLesson() {
    wx.switchTab({ url: '/pages/lesson/list' });
  },

  onBack() {
    wx.navigateBack({
      fail: () => wx.switchTab({ url: '/pages/home/home' }),
    });
  },
});
