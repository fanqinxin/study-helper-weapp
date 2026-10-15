/**
 * 额度不足拦截
 * 对应设计稿 21
 *
 * 这一页最重要的不是"卖额度"，而是"给出去路"。
 * 用户被拦住时最容易流失，所以必须同时给出：
 *   1. 立刻能用（手动对答案，不消耗额度）
 *   2. 等一等（免费额度重置时间）
 *   3. 花钱解决（充加油包）
 * 三条路都摆出来，用户自己选，反感度最低。
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
    packs: [],
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
      const [balance, packsRes] = await Promise.all([
        api.getQuotaBalance().catch(() => null),
        api.getQuotaPacks().catch(() => ({ packs: [] })),
      ]);

      const packs = (packsRes.packs || []).map((p) => ({
        ...p,
        priceText: (p.amountFen / 100).toFixed(0),
        quotaText: p.monthly ? '按月不限次' : `${p.quota} 次`,
      }));

      if (balance) {
        let resetText = '';
        if (balance.nextResetAt) {
          const d = new Date(balance.nextResetAt);
          resetText = `${d.getMonth() + 1}月${d.getDate()}日`;
        }
        // 免费还没用完却有余额，说明是月卡之外的付费余额不足
        const freeUsedUp = balance.freeLeft <= 0;
        this.setData({
          balance,
          resetText,
          freeUsedUp,
          reason: freeUsedUp
            ? '本周免费批改次数已经用完了'
            : '加油包次数已经用完了',
          packs,
        });
        app.globalData.quota = balance;
      } else {
        this.setData({ packs });
      }
    } catch (e) { /* 静默，页面用兜底文案渲染 */ }
  },

  /** 去充值 */
  onBuy() {
    wx.redirectTo({ url: '/pages/wallet/center' });
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
