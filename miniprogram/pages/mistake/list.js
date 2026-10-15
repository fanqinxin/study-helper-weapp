/**
 * 错题本
 * 对应设计稿 07
 *
 * 产品思路：错题本的目标不是"记录"，而是"清空"。
 * 所以顶部最显眼的是"待巩固 N 道"，答对即毕业，
 * 给的是清空进度条而不是数量堆积，正向激励更强。
 */
const api = require('../../utils/api');
const { SUBJECT_NAME } = require('../../utils/constants');
const app = getApp();

Page({
  data: {
    theme: 'light',
    loading: true,
    stats: { total: 0, pending: 0, mastered: 0, topPoints: [] },
    /** 筛选：学科，0=全部 */
    subject: 0,
    subjects: [
      { value: 0, name: '全部' },
      { value: 1, name: '语文' },
      { value: 2, name: '数学' },
      { value: 3, name: '英语' },
    ],
    list: [],
    /** 清空进度百分比 */
    clearPercent: 0,
    tabIndex: 3,
  },

  onLoad() {
    this.setData({ theme: app.globalData.theme || 'light' });
  },

  onShow() {
    this.setData({ tabIndex: 3 });
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
      const [stats, res] = await Promise.all([
        api.getMistakeStats().catch(() => null),
        api.listMistake({
          subject: this.data.subject || undefined,
          mastered: 0,
          size: 50,
        }).catch(() => ({ list: [] })),
      ]);

      const list = (res.list || []).map((m) => ({
        ...m,
        subjectName: SUBJECT_NAME[m.subject] || '',
      }));

      const s = stats || { total: 0, pending: 0, mastered: 0, topPoints: [] };
      const clearPercent = s.total ? Math.round((s.mastered / s.total) * 100) : 0;

      this.setData({ loading: false, stats: s, list, clearPercent });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  /** 切换学科筛选 */
  onSubjectTap(e) {
    const value = Number(e.currentTarget.dataset.value);
    if (value === this.data.subject) return;
    this.setData({ subject: value, loading: true });
    this.load();
  },

  /** 进入重做 */
  onItemTap(e) {
    const { id } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/mistake/detail?id=${id}` });
  },

  /** 去课文练习 */
  onGoLesson() {
    wx.switchTab({ url: '/pages/lesson/list' });
  },
});
