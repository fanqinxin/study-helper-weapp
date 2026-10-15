/**
 * 首页
 * 对应设计稿 01
 */
const api = require('../../utils/api');
const { getUser, ensureLogin } = require('../../utils/auth');
const { getIcon } = require('../../styles/icons');

const app = getApp();

Page({
  data: {
    theme: 'light',
    loading: true,
    user: null,
    /** 问候语随时间变化 */
    greeting: '早上好',
    /** 剩余额度 */
    quotaLeft: 0,
    quotaLow: false,
    /** 今日任务 */
    todayTask: {
      title: '上传今天的作业',
      desc: '拍张照片，AI 帮你检查一遍',
      actionText: '开始',
      url: '/pages/homework/upload',
    },
    /** 今日任务进度 */
    taskDone: 0,
    taskTotal: 3,
    taskPercent: 0,
    /** 数据概览 */
    stats: { todayCount: 0, weekRate: 0, mistakeCount: 0 },
    /** 当前教材 */
    textbook: null,
    /** 工具入口（图标在 onLoad 中生成） */
    tools: [],
    /** 图标（模板里直接用） */
    iconBolt: '',
    iconPlayDark: '',
    /** Tab Bar 选中索引 */
    tabIndex: 0,
  },

  onLoad() {
    this.setData({
      greeting: this.calcGreeting(),
      theme: app.globalData.theme || 'light',
      iconBolt: getIcon('bolt', '#E0A32E', 18),
      iconPlayDark: getIcon('play', '#FFFFFF', 18),
      tools: this.buildTools(),
    });
  },

  onShow() {
    this.setData({ tabIndex: 0 });
    this.loadData();
  },

  onPullDownRefresh() {
    this.loadData().finally(() => wx.stopPullDownRefresh());
  },

  /** 主题变化（由 app 广播） */
  onThemeChanged(theme) {
    this.setData({
      theme,
      tools: this.buildTools(),
      iconBolt: getIcon('bolt', theme === 'dark' ? '#FFC857' : '#E0A32E', 18),
      iconPlayDark: getIcon('play', '#FFFFFF', 18),
    });
  },

  /** 额度变化（由 app 广播） */
  onQuotaChanged(quota) {
    this.setData({
      quotaLeft: quota.totalLeft,
      quotaLow: quota.low,
    });
  },

  /** 按当前时间生成问候语 */
  calcGreeting() {
    const h = new Date().getHours();
    if (h < 6) return '夜深了';
    if (h < 11) return '早上好';
    if (h < 14) return '中午好';
    if (h < 18) return '下午好';
    return '晚上好';
  },

  /** 工具入口配置 */
  buildTools() {
    return [
      {
        key: 'upload',
        name: '上传作业',
        desc: 'AI 帮你批改',
        url: '/pages/homework/upload',
        icon: getIcon('camera', '#FF8C7A', 26),
        bg: 'var(--coral-light)',
      },
      {
        key: 'mistake',
        name: '错题本',
        desc: `${this.data.stats.mistakeCount || 0} 题待巩固`,
        url: '/pages/mistake/list',
        icon: getIcon('mistake', '#6BB6E0', 26),
        bg: 'var(--sky-light)',
        tab: true,
      },
      {
        key: 'plan',
        name: '学习计划',
        desc: '看看今天做什么',
        url: '/pages/plan/plan',
        icon: getIcon('plan', '#FFC857', 26),
        bg: 'var(--brand-light)',
        tab: true,
      },
      {
        key: 'lesson',
        name: '课文练习',
        desc: '同步教材练一练',
        url: '/pages/lesson/list',
        icon: getIcon('lesson', '#7DD3A0', 26),
        bg: 'var(--grass-light)',
        tab: true,
      },
    ];
  },

  /** 拉取首页数据 */
  async loadData() {
    try {
      // 未登录先登录
      let user = getUser();
      if (!user) {
        user = await ensureLogin();
      }
      if (!user) {
        this.setData({ loading: false });
        return;
      }

      const [quota, profile] = await Promise.all([
        api.getQuotaBalance().catch(() => null),
        api.getProfile().catch(() => user),
      ]);

      const quotaData = quota || { totalLeft: 0, low: false };

      this.setData({
        user: profile,
        quotaLeft: quotaData.totalLeft,
        quotaLow: quotaData.low,
        loading: false,
        textbook: profile && profile.textbookId
          ? { id: profile.textbookId, name: profile.textbookName || '人教版', grade: profile.grade || 3 }
          : null,
      });

      if (quota) app.globalData.quota = quota;

      // 刷新工具文案（错题数可能变化）
      this.setData({ tools: this.buildTools() });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  /** 开始今日任务 */
  onStartTask() {
    if (this.data.todayTask) {
      wx.navigateTo({ url: this.data.todayTask.url });
      return;
    }
    wx.navigateTo({ url: '/pages/homework/upload' });
  },

  /** 点击工具入口 */
  onToolTap(e) {
    const { url, tab } = e.currentTarget.dataset;
    if (tab) {
      wx.switchTab({ url });
    } else {
      wx.navigateTo({ url });
    }
  },

  /** 点击额度 chip */
  onQuotaTap() {
    wx.navigateTo({ url: '/pages/wallet/center' });
  },

  /** 跳教材中心 */
  onTextbookTap() {
    wx.navigateTo({ url: '/pages/textbook/center' });
  },
});
