/**
 * 使用记录
 * 对应设计稿 20
 *
 * 内测阶段调整（重要）：
 *   1. 页面内不出现任何价格、套餐、购买按钮 —— 个人主体无法开通微信支付，
 *      iOS 端只要出现「¥xx / 立即充值」就会被驳回，且内测期本就没有售卖行为
 *   2. 保留余额与流水：让用户看得见「还剩多少、什么消耗额度」，这是信任的基础
 *   3. 内测期免费额度给足，正常情况下不会走到不足提示
 *
 * 支付能力待主体升级为企业/个体工商户并接入「小程序虚拟支付」后再恢复。
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
    logs: [],
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
      const [balance, logsRes] = await Promise.all([
        api.getQuotaBalance().catch(() => null),
        api.getQuotaLogs({ page: 1, size: 20 }).catch(() => []),
      ]);

      const logs = (Array.isArray(logsRes) ? logsRes : []).map((l) => ({
        ...l,
        sourceName: QUOTA_SOURCE[l.source] || '额度变动',
        timeText: this.formatTime(l.createdAt),
        positive: Number(l.change) > 0,
        changeText: Number(l.change) > 0 ? `+${l.change}` : String(l.change),
      }));

      this.setData({ loading: false, logs });

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
});
