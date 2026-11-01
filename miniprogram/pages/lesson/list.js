/**
 * 课文同步练习 —— 课前选择
 * 对应设计稿 02
 *
 * 交互要点：默认对齐"课堂进度"，孩子只需点"下一课"就能开练，
 * 不需要自己去列表里找，这是同步练习体验的关键。
 */
const api = require('../../utils/api');
const { getUser, setUser } = require('../../utils/auth');
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
    /** 当前学科 */
    subject: 1,
    /** 三个学科及是否有可用教材 */
    subjects: [],
  },

  onLoad() {
    this.setData({
      theme: app.globalData.theme || 'light',
      iconPlay: getIcon('play', '#37352F', 20),
    });
    this.load();
  },

  onShow() {
    // 从教材中心 / 添加教材返回时都要刷新：
    // 之前只在「已选教材」时刷新，选完教材回来仍是空态
    if (!this.data.loading) this.load();
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
    this.setData({ loading: true });

    // 先取"可选教材"，用来判断哪些学科能直接切换
    let all = [];
    try {
      const res = await api.listTextbook({});
      all = res.list || [];
    } catch (e) {
      all = [];
    }
    this._textbooks = all;

    const subjects = [1, 2, 3].map((v) => ({
      value: v,
      name: SUBJECT_NAME[v],
      available: all.some((t) => Number(t.subject) === v),
    }));

    if (!user || !user.textbookId) {
      this.setData({ loading: false, textbook: null, lessons: [], groups: [], nextLesson: null, subjects });
      return;
    }

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
        subject: Number(res.textbook.subject) || this.data.subject,
        subjects,
        lessons,
        groups,
        progress,
        nextLesson,
      });
    } catch (e) {
      this.setData({ loading: false, subjects });
    }
  },

  /**
   * 切换学科
   *
   * 一个学科可能有多本教材（上下册 / 多个版本），
   * 只有一本就直接切；多本交给教材中心挑；一本都没有就引导去拍目录。
   */
  async onSubjectTap(e) {
    const { value, name } = e.currentTarget.dataset;
    const subject = Number(value);
    if (subject === Number(this.data.subject)) return;

    const list = (this._textbooks || []).filter((t) => Number(t.subject) === subject);

    if (!list.length) {
      wx.showModal({
        title: `还没有${name || ''}教材`,
        content: '可以拍下课本目录，AI 会整理成你的专属练习册。',
        confirmText: '去添加',
        cancelText: '再看看',
        success: (r) => {
          if (r.confirm) wx.navigateTo({ url: `/pages/textbook/add?subject=${subject}` });
        },
      });
      return;
    }

    if (list.length > 1) {
      wx.navigateTo({ url: `/pages/textbook/center?subject=${subject}` });
      return;
    }

    const target = list[0];
    wx.showLoading({ title: '切换中', mask: true });
    try {
      await api.selectTextbook({ textbookId: Number(target.id) });
      const user = {
        ...(getUser() || {}),
        textbookId: Number(target.id),
        grade: Number(target.grade),
        lessonProgress: 0,
      };
      setUser(user);
      app.globalData.user = user;
      wx.hideLoading();
      await this.load();
    } catch (err) {
      wx.hideLoading();
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

  /** 去教材中心换教材（带上当前学科，少点一次） */
  onSwitchTextbook() {
    const subject = Number(this.data.subject) || 1;
    wx.navigateTo({ url: `/pages/textbook/center?subject=${subject}` });
  },
});
