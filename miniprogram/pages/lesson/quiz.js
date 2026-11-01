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
    /** 是否来自自定义教材（决定空态文案） */
    isCustom: false,
    /** 正在让 AI 出题 */
    generating: false,
    /** 出题已等待秒数 */
    genSeconds: 0,
    /** 可选题量档位（与服务端 ALLOWED_COUNTS 一致） */
    countOptions: [5, 10, 15, 20],
    /** 本次要出的题量 */
    practiceCount: 5,
    /**
     * 当前题是否已作答 —— 底部按钮亮/暗的状态源。
     * 不能直接在 WXML 里写 canGoNext()：WXML 表达式不支持调用页面方法，
     * 结果恒为假，按钮会一直是浅色。
     */
    canNext: false,
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
        isCustom: !!lesson.isCustom,
        total,
        index: 0,
        question: total ? lesson.questions[0] : null,
        answers: {},
        inputValue: '',
        canNext: false,
        progressPercent: total ? Math.round((1 / total) * 100) : 0,
      });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  onUnload() {
    this.stopGenerate();
  },

  /** 选题量：5 / 10 / 15 / 20 */
  onPickCount(e) {
    if (this.data.generating) return;
    const n = Number(e.currentTarget.dataset.count) || 5;
    if (n === this.data.practiceCount) return;
    this.setData({ practiceCount: n });
  },

  /**
   * 让 AI 出这一课的练习
   *
   * 与教材识别同一套模式：入队立即返回，前端轮询。
   * 之所以不在这里同步等，是因为出题要 10-30 秒，
   * 而 wx.request 默认 30 秒就断，一定先撞客户端超时。
   */
  async onGenerate() {
    if (this.data.generating) return;

    this.setData({ generating: true, genSeconds: 0 });
    this._genTick = setInterval(() => {
      this.setData({ genSeconds: this.data.genSeconds + 1 });
    }, 1000);

    try {
      const res = await api.generatePractice(this.data.lessonId, this.data.practiceCount);
      if (res && res.status === 'ready') {
        this.finishGenerate(true);
        return;
      }
      this.pollPractice();
    } catch (e) {
      // request 层已提示；额度不足会跳拦截页
      this.finishGenerate(false, e && e.silent ? '' : (e && e.msg) || '');
    }
  },

  /** 轮询出题结果，最多等 90 秒 */
  pollPractice() {
    const startedAt = Date.now();

    const tick = async () => {
      if (!this.data.generating) return;

      if (Date.now() - startedAt > 90000) {
        this.finishGenerate(false, '生成时间有点久，稍后回来看看');
        return;
      }

      try {
        const st = await api.getPracticeStatus(this.data.lessonId);
        if (st.status === 'ready') {
          this.finishGenerate(true);
          return;
        }
        if (st.status === 'none') {
          // 没有题目也没有生成中标记：任务失败，服务端已退款
          this.finishGenerate(false, '这次没生成成功，额度已退还');
          return;
        }
      } catch (e) {
        // 单次失败不终止，下一轮继续
      }

      this._genPoll = setTimeout(tick, 3000);
    };

    this._genPoll = setTimeout(tick, 2000);
  },

  stopGenerate() {
    if (this._genTick) clearInterval(this._genTick);
    if (this._genPoll) clearTimeout(this._genPoll);
    this._genTick = null;
    this._genPoll = null;
  },

  finishGenerate(ok, msg) {
    this.stopGenerate();
    this.setData({ generating: false });
    if (ok) {
      wx.showToast({ title: '练习已生成', icon: 'success' });
      if (app.refreshQuota) app.refreshQuota();
      this.load(this.data.lessonId);
      return;
    }
    if (msg) wx.showToast({ title: msg, icon: 'none' });
  },

  /** 单选题选择 */
  onOptionTap(e) {
    if (this.data.submitted) return;
    const { value } = e.currentTarget.dataset;
    const q = this.data.question;
    if (!q) return;

    const answers = { ...this.data.answers, [q.id]: value };
    this.setData({ answers, canNext: true });
  },

  /** 填空/计算题输入 */
  onInput(e) {
    const v = e.detail.value;
    this.setData({ inputValue: v, canNext: String(v || '').trim() !== '' });
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

  /** 某题是否已作答 */
  isAnswered(q, answers) {
    if (!q) return false;
    const a = answers[q.id];
    return a !== undefined && a !== null && String(a).trim() !== '';
  },

  /** 是否可进入下一题 */
  canGoNext() {
    return this.isAnswered(this.data.question, this.data.answers);
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
      canNext: this.isAnswered(q, this.data.answers),
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
      canNext: this.isAnswered(q, this.data.answers),
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
      canNext: false,
      progressPercent: Math.round((1 / this.data.total) * 100),
    });
  },

  /** 结果页：回课文列表 */
  onBackToList() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack();
      return;
    }
    wx.switchTab({ url: '/pages/lesson/list' });
  },

  /** 结果页：去错题本 */
  onGoMistake() {
    wx.switchTab({ url: '/pages/mistake/list' });
  },
});
