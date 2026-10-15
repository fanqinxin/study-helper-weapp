/**
 * 课文同步练习 —— 课前选择
 * 对应设计稿 02
 *
 * 交互要点：默认对齐"课堂进度"，孩子只需点"下一课"就能开练，
 * 不需要自己去列表里找，这是同步练习体验的关键。
 */
const api = require('../../utils/api');
const { getUser } = require('../../utils/auth');
const { getIcon } = require('../../styles/icons');
const { SUBJECT_NAME } = require('../../utils/constants');
const app = getApp();

Page({
  data: {
    theme: 'light',
    loading: true,
    /** 当前教材信息 */
    textbook: null,
    /** 课文列表 */
    lessons: [],
    /** 课堂进度（第几课） */
    progress: 0,
    /** 推荐下一课 */
    nextLesson: null,
    /** 左侧单元聚合（按 unit 分组） */
    groups: [],
    iconPlay: '',
  },

  onLoad() {
    this.setData({
      theme: app.globalData.theme || 'light',
      iconPlay: getIcon('play', '#37352F', 20),
    });
    this.load();
  },

  onShow() {
    if (!this.data.loading && this.data.textbook) this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  onThemeChanged(theme) {
    this.setData({
      theme,
      iconPlay: getIcon('play', theme === 'dark' ? '#F2EFE8' : '#37352F', 20),
    });
  },

  async load() {
    const user = getUser();
    if (!user || !user.textbookId) {
      this.setData({ loading: false, textbook: null });
      return;
    }

    this.setData({ loading: true });
    try {
      const res = await api.listLesson(user.textbookId);
      const lessons = (res.lessons || []).map((l) => ({
        ...l,
        passed: Number(l.seq) <= Number(user.lessonProgress || 0),
        current: Number(l.seq) === Number(user.lessonProgress || 0) + 1,
      }));

      const progress = Number(user.lessonProgress || 0);
      const nextLesson = lessons.find((l) => Number(l.seq) === progress + 1) || null;

      // 按单元分组，视觉上更像课本
      const groupMap = new Map();
      lessons.forEach((l) => {
        const key = l.unit || '课文';
        if (!groupMap.has(key)) groupMap.set(key, []);
        groupMap.get(key).push(l);
      });
      const groups = Array.from(groupMap.entries()).map(([unit, list]) => ({ unit, list }));

      this.setData({
        loading: false,
        textbook: res.textbook,
        lessons,
        groups,
        progress,
        nextLesson,
      });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  /** 开始推荐的那一课 */
  onStartNext() {
    if (!this.data.nextLesson) {
      wx.showToast({ title: '本册课文已全部练完', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: `/pages/lesson/quiz?id=${this.data.nextLesson.id}` });
  },

  /** 点击某一课 */
  onLessonTap(e) {
    const { id } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/lesson/quiz?id=${id}` });
  },

  /** 去教材中心换教材 */
  onSwitchTextbook() {
    wx.navigateTo({ url: '/pages/textbook/center' });
  },
});
