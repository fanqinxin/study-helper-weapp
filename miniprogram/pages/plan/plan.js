/**
 * 学习计划
 * 对应设计稿 06
 *
 * 设计意图：家长不想排课表，孩子不想看任务清单。
 * 所以这里是"今天只做 3 件事"，做完打勾，一周进度一目了然。
 */
const api = require('../../utils/api');
const { PLAN_TYPE } = require('../../utils/constants');
const { getIcon } = require('../../styles/icons');
const app = getApp();

/** 任务类型 → 图标与配色 */
const TYPE_STYLE = {
  1: { icon: 'lesson', color: '#6BB6E0', bg: 'var(--sky-light)' },
  2: { icon: 'mistake', color: '#FF8C7A', bg: 'var(--coral-light)' },
  3: { icon: 'camera', color: '#FFC857', bg: 'var(--brand-light)' },
  4: { icon: 'star', color: '#7DD3A0', bg: 'var(--grass-light)' },
};

/** 任务类型 → 点击跳转 */
const TYPE_ROUTE = {
  1: '/pages/lesson/list',
  2: '/pages/mistake/list',
  3: '/pages/homework/upload',
  4: '/pages/game/game',
};

Page({
  data: {
    theme: 'light',
    loading: true,
    plan: { planDate: '', total: 0, done: 0, percent: 0, tasks: [] },
    week: { days: [], total: 0, done: 0, rate: 0 },
    /** 本周柱状图高度（百分比） */
    weekBars: [],
    tabIndex: 2,
  },

  onLoad() {
    this.setData({ theme: app.globalData.theme || 'light' });
  },

  onShow() {
    this.setData({ tabIndex: 2 });
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  onThemeChanged(theme) {
    this.setData({ theme });
  },

  async load() {
    try {
      const [plan, week] = await Promise.all([
        api.getTodayPlan().catch(() => null),
        api.getWeekPlan().catch(() => null),
      ]);

      if (plan) {
        plan.tasks = (plan.tasks || []).map((t) => {
          const style = TYPE_STYLE[t.type] || TYPE_STYLE[1];
          return {
            ...t,
            typeName: PLAN_TYPE[t.type] || '任务',
            icon: getIcon(style.icon, style.color, 26),
            bg: style.bg,
          };
        });
      }

      // 一周柱状图：把 done/total 换算成高度
      const days = (week && week.days) || [];
      const weekBars = days.map((d) => ({
        label: this.weekdayLabel(d.planDate),
        height: d.total ? Math.round((d.done / d.total) * 100) : 0,
        done: d.done,
        total: d.total,
      }));

      this.setData({
        loading: false,
        plan: plan || this.data.plan,
        week: week || this.data.week,
        weekBars,
      });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  /** 2026-01-05 → 一 / 二 / … */
  weekdayLabel(dateStr) {
    if (!dateStr) return '';
    const d = new Date(String(dateStr).replace(/-/g, '/'));
    const names = ['日', '一', '二', '三', '四', '五', '六'];
    return names[d.getDay()] || '';
  },

  /** 勾选 / 取消任务 */
  async onToggle(e) {
    const { id, done } = e.currentTarget.dataset;
    try {
      const plan = await api.togglePlanTask(Number(id), !done);
      plan.tasks = (plan.tasks || []).map((t) => {
        const style = TYPE_STYLE[t.type] || TYPE_STYLE[1];
        return {
          ...t,
          typeName: PLAN_TYPE[t.type] || '任务',
          icon: getIcon(style.icon, style.color, 26),
          bg: style.bg,
        };
      });
      this.setData({ plan });

      // 一周统计也会变
      const week = await api.getWeekPlan().catch(() => null);
      if (week) {
        this.setData({
          week,
          weekBars: (week.days || []).map((d) => ({
            label: this.weekdayLabel(d.planDate),
            height: d.total ? Math.round((d.done / d.total) * 100) : 0,
            done: d.done,
            total: d.total,
          })),
        });
      }

      if (!done) wx.showToast({ title: '完成一项，很棒', icon: 'none' });
    } catch (err) { /* request 层已提示 */ }
  },

  /** 点击任务主体 → 去完成 */
  onTaskTap(e) {
    const { type, done } = e.currentTarget.dataset;
    if (done) return;
    const url = TYPE_ROUTE[Number(type)] || '/pages/home/home';
    if (url.includes('lesson') || url.includes('mistake')) {
      wx.switchTab({ url });
    } else {
      wx.navigateTo({ url });
    }
  },
});
