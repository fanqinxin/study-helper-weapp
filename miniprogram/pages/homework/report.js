/**
 * AI 批改报告
 * 对应设计稿 05
 *
 * 设计意图（面向家长与孩子两种读者）：
 * - 顶部给结论：对了几题、得了多少分，3 秒看完
 * - 中部给错题：只突出错的，对的折叠，减少信息量
 * - 底部给下一步：把错题转成"去做的事"，而不是停在报告里
 */
const api = require('../../utils/api');
const { getIcon } = require('../../styles/icons');
const { SUBJECT_NAME } = require('../../utils/constants');
const app = getApp();

Page({
  data: {
    theme: 'light',
    loading: true,
    homeworkId: 0,
    report: null,
    subjectName: '',
    /** 拆分成对/错两组 */
    wrongItems: [],
    rightItems: [],
    /** 是否展开答对题目 */
    showRight: false,
    /** 环形颜色：按分数变色 */
    ringColor: '#FFC857',
    iconSpark: '',
    iconArrow: '',
  },

  onLoad(options) {
    const id = Number(options.id) || 0;
    this.setData({
      homeworkId: id,
      theme: app.globalData.theme || 'light',
      iconSpark: getIcon('spark', '#FFC857', 20),
      iconArrow: getIcon('arrowRight', '#37352F', 20),
    });
    if (id) this.load(id);
    else this.setData({ loading: false });
  },

  onThemeChanged(theme) {
    this.setData({
      theme,
      iconArrow: getIcon('arrowRight', theme === 'dark' ? '#F2EFE8' : '#37352F', 20),
    });
  },

  async load(id) {
    try {
      const report = await api.getHomeworkReport(id);
      const items = report.items || [];

      // 给每道题标序号，模板里直接用
      const wrongItems = items
        .filter((i) => i.isCorrect === 0)
        .map((i, idx) => ({ ...i, no: idx + 1 }));
      const rightItems = items
        .filter((i) => i.isCorrect === 1)
        .map((i, idx) => ({ ...i, no: idx + 1 }));

      this.setData({
        loading: false,
        report,
        subjectName: SUBJECT_NAME[report.subject] || '作业',
        wrongItems,
        rightItems,
        ringColor: report.score >= 80 ? '#7DD3A0' : report.score >= 60 ? '#FFC857' : '#FF8C7A',
      });

      // 批改完成后错题本会变，顺手刷新首页数据
      app.refreshQuota();
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  onToggleRight() {
    this.setData({ showRight: !this.data.showRight });
  },

  /** 去错题本巩固 */
  onGoMistake() {
    wx.switchTab({ url: '/pages/mistake/list' });
  },

  /** 再传一份 */
  onUploadMore() {
    wx.redirectTo({ url: '/pages/homework/upload' });
  },
});
