/**
 * 教材中心
 * 对应设计稿 10
 *
 * 交互核心：先定学科 + 年级，再选版本。三级筛选比一长串列表好选得多。
 */
const api = require('../../utils/api');
const { getUser, setUser } = require('../../utils/auth');
const { SUBJECT_NAME } = require('../../utils/constants');
const app = getApp();

Page({
  data: {
    theme: 'light',
    loading: true,
    /** 筛选条件 */
    subject: 1,
    grade: 3,
    /** 当前用户已选教材 id */
    currentId: null,
    subjectList: [
      { value: 1, name: '语文' },
      { value: 2, name: '数学' },
      { value: 3, name: '英语' },
    ],
    gradeList: [1, 2, 3, 4, 5, 6],
    textbooks: [],
  },

  onLoad() {
    const user = getUser() || {};
    this.setData({
      theme: app.globalData.theme || 'light',
      currentId: user.textbookId || null,
      grade: user.grade || 3,
    });
    this.load();
  },

  onShow() {
    // 从添加教材返回后刷新
    if (!this.data.loading) this.load();
  },

  onThemeChanged(theme) {
    this.setData({ theme });
  },

  async load() {
    try {
      const res = await api.listTextbook({
        subject: this.data.subject,
        grade: this.data.grade,
      });
      const list = (res.list || []).map((t) => ({
        ...t,
        active: Number(t.id) === Number(this.data.currentId),
      }));
      this.setData({ loading: false, textbooks: list });
    } catch (e) {
      this.setData({ loading: false, textbooks: [] });
    }
  },

  onSubjectTap(e) {
    const value = Number(e.currentTarget.dataset.value);
    if (value === this.data.subject) return;
    this.setData({ subject: value, loading: true, textbooks: [] });
    this.load();
  },

  onGradeTap(e) {
    const value = Number(e.currentTarget.dataset.value);
    if (value === this.data.grade) return;
    this.setData({ grade: value, loading: true, textbooks: [] });
    this.load();
  },

  /** 选定教材 */
  async onPick(e) {
    const { id, name } = e.currentTarget.dataset;
    if (Number(id) === Number(this.data.currentId)) {
      wx.navigateBack();
      return;
    }

    wx.showLoading({ title: '切换中', mask: true });
    try {
      await api.selectTextbook({ textbookId: Number(id) });
      const user = { ...(getUser() || {}), textbookId: Number(id), grade: this.data.grade };
      setUser(user);
      app.globalData.user = user;
      wx.hideLoading();
      wx.showToast({ title: `已切换到${name}`, icon: 'success' });
      setTimeout(() => wx.navigateBack(), 700);
    } catch (err) {
      wx.hideLoading();
    }
  },

  /** 去添加自定义教材 */
  onAddCustom() {
    wx.navigateTo({ url: '/pages/textbook/add' });
  },
});
