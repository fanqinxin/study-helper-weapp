/**
 * 额度中心
 * 对应设计稿 20
 *
 * 产品原则：
 * 1. 先讲清"什么消耗、什么不消耗"，再谈充值，减少"是不是坑钱"的疑虑
 * 2. 免费额度占大头且能重置，付费只是加速，不制造焦虑
 * 3. 流水透明，每笔扣减都能查到
 */
const api = require('../../utils/api');
const { QUOTA_SOURCE } = require('../../utils/constants');
const app = getApp();

Page({
  data: {
    theme: 'light',
    loading: true,
    balance: {
      freeLeft: 0, freeTotal: 0, freeUsed: 0,
      paidBalance: 0, monthly: false, totalLeft: 0,
      nextResetAt: '', low: false,
    },
    /** 下次重置日期文案 */
    resetText: '',
    packs: [],
    logs: [],
    /** 档位选中 */
    selectedPack: '',
    iconBolt: '',
  },

  onLoad() {
    this.setData({ theme: app.globalData.theme || 'light' });
    this.load();
  },

  onShow() {
    this.load();
  },

  onThemeChanged(theme) {
    this.setData({ theme });
  },

  onQuotaChanged(quota) {
    this.applyBalance(quota);
  },

  async load() {
    try {
      const [balance, packsRes, logsRes] = await Promise.all([
        api.getQuotaBalance().catch(() => null),
        api.getQuotaPacks().catch(() => ({ packs: [] })),
        api.getQuotaLogs({ page: 1, size: 10 }).catch(() => []),
      ]);

      const packs = (packsRes.packs || []).map((p) => ({
        ...p,
        priceText: (p.amountFen / 100).toFixed(0),
        // 每月单价换算是家长最关心的对比维度
        unitText: p.monthly
          ? '按月不限次'
          : `约 ¥${((p.amountFen / 100) / p.quota).toFixed(2)}/次`,
      }));

      const logs = (Array.isArray(logsRes) ? logsRes : []).map((l) => ({
        ...l,
        sourceName: QUOTA_SOURCE[l.source] || '额度变动',
        timeText: this.formatTime(l.createdAt),
        positive: Number(l.change) > 0,
        changeText: Number(l.change) > 0 ? `+${l.change}` : String(l.change),
      }));

      this.setData({
        loading: false,
        packs,
        logs,
        selectedPack: packs.find((p) => p.recommended)?.packId || '',
      });

      if (balance) {
        app.globalData.quota = balance;
        this.applyBalance(balance);
      }
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  applyBalance(balance) {
    let resetText = '';
    if (balance.nextResetAt) {
      const d = new Date(balance.nextResetAt);
      resetText = `${d.getMonth() + 1}月${d.getDate()}日`;
    }
    this.setData({ balance, resetText });
  },

  /** 2026-01-05 10:30 → 01-05 10:30 */
  formatTime(str) {
    if (!str) return '';
    const s = String(str).replace('T', ' ').replace(/\.\d+Z?$/, '');
    return s.slice(5, 16);
  },

  onPackTap(e) {
    this.setData({ selectedPack: e.currentTarget.dataset.id });
  },

  /** 下单（Phase 4 接入微信支付） */
  async onBuy() {
    const packId = this.data.selectedPack;
    if (!packId) {
      wx.showToast({ title: '先选一个档位', icon: 'none' });
      return;
    }
    try {
      const res = await api.createOrder(packId);
      wx.showModal({
        title: '支付功能开发中',
        content: res.msg || '微信支付将在下个版本上线，敬请期待。',
        showCancel: false,
        confirmText: '知道了',
      });
    } catch (e) { /* 已提示 */ }
  },
});
