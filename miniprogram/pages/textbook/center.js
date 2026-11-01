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

  onLoad(options) {
    const user = getUser() || {};
    const subject = Number(options && options.subject);
    this.setData({
      theme: app.globalData.theme || 'light',
      currentId: user.textbookId || null,
      subject: subject >= 1 && subject <= 3 ? subject : 1,
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
    const subject = Number(this.data.subject) || 1;
    const grade = Number(this.data.grade) || 3;
    wx.navigateTo({ url: `/pages/textbook/add?subject=${subject}&grade=${grade}` });
  },

  /** 自定义教材的管理入口（内置教材不显示） */
  onMore(e) {
    const { id, name } = e.currentTarget.dataset;
    wx.showActionSheet({
      itemList: ['重命名', '删除这本教材'],
      success: (r) => {
        if (r.tapIndex === 0) this.renameBook(Number(id), name);
        if (r.tapIndex === 1) this.deleteBook(Number(id), name);
      },
    });
  },

  /** 重命名 */
  renameBook(id, oldName) {
    wx.showModal({
      title: '重命名教材',
      editable: true,
      placeholderText: '例如：人教版语文三上',
      content: oldName || '',
      success: async (r) => {
        if (!r.confirm) return;
        const name = String(r.content || '').trim();
        if (!name) {
          wx.showToast({ title: '名称不能为空', icon: 'none' });
          return;
        }
        if (name === oldName) return;

        wx.showLoading({ title: '保存中', mask: true });
        try {
          await api.renameTextbook(id, name);
          wx.hideLoading();
          wx.showToast({ title: '已重命名', icon: 'success' });
          this.load();
        } catch (err) {
          wx.hideLoading();
        }
      },
    });
  },

  /** 删除：课文与练习会一并清除，且不可恢复 */
  deleteBook(id) {
    wx.showModal({
      title: '删除这本教材',
      content: '课文和练习会一并删除，且不可恢复。确定删除吗？',
      confirmText: '删除',
      confirmColor: '#E06C5A',
      success: async (r) => {
        if (!r.confirm) return;

        wx.showLoading({ title: '删除中', mask: true });
        try {
          await api.deleteTextbook(id);
          wx.hideLoading();

          // 删的是当前在用的教材：本地登录态也要同步解绑，否则会跳进空列表
          if (Number(id) === Number(this.data.currentId)) {
            const user = { ...(getUser() || {}), textbookId: null, lessonProgress: 0 };
            setUser(user);
            app.globalData.user = user;
            this.setData({ currentId: null });
          }

          wx.showToast({ title: '已删除', icon: 'success' });
          this.load();
        } catch (err) {
          wx.hideLoading();
        }
      },
    });
  },
});
