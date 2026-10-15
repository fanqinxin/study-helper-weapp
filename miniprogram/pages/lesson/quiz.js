/**
 * 课文练习答题
 * 对应设计稿 03
 *
 * 为什么答案不下发前端、判分走后端：
 * 孩子会翻看前端数据，答案下发等于送答案。
 * 判分纯本地字符串比对，不调 AI，所以这一页不消耗额度。
 */
const api = require('../../utils/api');
const { getIcon } = require('../../styles/icons');
const app = getApp();

Page({
  data: {
    theme: 'light',
    loading: true,
    lessonId: 0,
    lesson: null,
    /** 当前题索引 */
    index: 0,
    total: 0,
    /** 当前题 */
    question: null,
    /** 已选答案：{ [questionId]: string } */
    answers: {},
    /** 填空题输入值 */
    inputValue: '',
    /** 结果（提交后才有） */
    result: null,
    /** 是否已提交 */
    submitted: false,
    /** 选项字母 */
    letters: ['A', 'B', 'C', 'D'],
    progressPercent: 0,
    iconCheck: '',
  },

  onLoad(options) {
    const lessonId = Number(options.id) || 0;
    this.setData({
      lessonId,
      theme: app.globalData.theme || 'light',
      iconCheck: getIcon('check', '#7DD3A0', 22),
    });
    if (lessonId) this.load(lessonId);
    else this.setData({ loading: false });
  },

  onThemeChanged(theme) {
    this.setData({ theme });
  },

  async load(lessonId) {
    try {
      const lesson = await api.getLesson(lessonId);
      const total = (lesson.questions || []).length;
      this.setData({
        loading: false,
        lesson,
        total,
        index: 0,
        question: total ? lesson.questions[0] : null,
        answers: {},
        inputValue: '',
        progressPercent: total ? Math.round((1 / total) * 100) : 0,
      });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  /** 单选题选择 */
  onOptionTap(e) {
    if (this.data.submitted) return;
    const { value } = e.currentTarget.dataset;
    const q = this.data.question;
    if (!q) return;

    const answers = { ...this.data.answers, [q.id]: value };
    this.setData({ answers });
  },

  /** 填空/计算题输入 */
  onInput(e) {
    this.setData({ inputValue: e.detail.value });
  },

  /** 确认当前题（填空类需要显式确认） */
  onConfirmInput() {
    const q = this.data.question;
    if (!q) return;
    const v = String(this.data.inputValue || '').trim();
    if (!v) {
      wx.showToast({ title: '先写下你的答案吧', icon: 'none' });
      return;
    }
    this.setData({ answers: { ...this.data.answers, [q.id]: v } });
    this.next();
  },

  /** 是否可进入下一题 */
  canGoNext() {
    const q = this.data.question;
    if (!q) return false;
    const a = this.data.answers[q.id];
    return a !== undefined && a !== null && String(a).trim() !== '';
  },

  onNext() {
    if (!this.canGoNext()) {
      wx.showToast({ title: '先选一个答案吧', icon: 'none' });
      return;
    }
    this.next();
  },

  next() {
    const { index, total } = this.data;
    if (index + 1 >= total) {
      this.submit();
      return;
    }
    const nextIndex = index + 1;
    const q = this.data.lesson.questions[nextIndex];
    this.setData({
      index: nextIndex,
      question: q,
      inputValue: (this.data.answers[q.id] || '').toString(),
      progressPercent: Math.round(((nextIndex + 1) / total) * 100),
    });
  },

  onPrev() {
    const { index } = this.data;
    if (index <= 0) return;
    const prevIndex = index - 1;
    const q = this.data.lesson.questions[prevIndex];
    this.setData({
      index: prevIndex,
      question: q,
      inputValue: (this.data.answers[q.id] || '').toString(),
      progressPercent: Math.round(((prevIndex + 1) / this.data.total) * 100),
    });
  },

  /** 提交判分 */
  async submit() {
    if (this.data.submitted) return;

    const answers = Object.keys(this.data.answers).map((questionId) => ({
      questionId: Number(questionId),
      answer: this.data.answers[questionId],
    }));

    if (!answers.length) {
      wx.showToast({ title: '还没有作答哦', icon: 'none' });
      return;
    }

    try {
      const result = await api.submitLesson(this.data.lessonId, answers);

      // 把题面与作答合并，便于结果页展示
      const qMap = new Map((this.data.lesson.questions || []).map((q) => [q.id, q]));
      const detail = (result.detail || []).map((d) => {
        const q = qMap.get(d.questionId) || {};
        return { ...d, stem: q.stem, options: q.options, type: q.type };
      });

      this.setData({ submitted: true, result: { ...result, detail } });
      wx.pageScrollTo({ scrollTop: 0, duration: 200 });
    } catch (e) {
      // request 层已 toast
    }
  },

  /** 结果页：再来一次 */
  onRetry() {
    this.setData({
      submitted: false,
      result: null,
      index: 0,
      question: this.data.lesson.questions[0],
      answers: {},
      inputValue: '',
      progressPercent: Math.round((1 / this.data.total) * 100),
    });
  },

  /** 结果页：回课文列表 */
  onBackToList() {
    wx.navigateBack();
  },

  /** 结果页：去错题本 */
  onGoMistake() {
    wx.switchTab({ url: '/pages/mistake/list' });
  },
});
