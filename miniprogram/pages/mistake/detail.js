/**
 * 错题重做
 *
 * 交互取舍：不展示正确答案，先让孩子自己重做一遍，
 * 提交后才揭晓。这样才能真正检验是否掌握，而不是"看一眼答案觉得会了"。
 */
const api = require('../../utils/api');
const { SUBJECT_NAME } = require('../../utils/constants');
const { getIcon } = require('../../styles/icons');
const app = getApp();

Page({
  data: {
    theme: 'light',
    loading: true,
    id: 0,
    mistake: null,
    subjectName: '',
    /** 作答 */
    answer: '',
    /** 提交结果 */
    result: null,
    submitted: false,
    iconSpark: '',
  },

  onLoad(options) {
    const id = Number(options.id) || 0;
    this.setData({
      id,
      theme: app.globalData.theme || 'light',
      iconSpark: getIcon('spark', '#7DD3A0', 22),
    });
    if (id) this.load(id);
    else this.setData({ loading: false });
  },

  onThemeChanged(theme) {
    this.setData({ theme });
  },

  async load(id) {
    try {
      const mistake = await api.getMistake(id);
      this.setData({
        loading: false,
        mistake,
        subjectName: SUBJECT_NAME[mistake.subject] || '',
      });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  onInput(e) {
    this.setData({ answer: e.detail.value });
  },

  /** 提交重做 */
  async onSubmit() {
    const answer = String(this.data.answer || '').trim();
    if (!answer) {
      wx.showToast({ title: '先写下你的答案吧', icon: 'none' });
      return;
    }

    try {
      const result = await api.retryMistake(this.data.id, answer);
      this.setData({ submitted: true, result });

      if (result.isCorrect) {
        wx.showToast({ title: '答对啦', icon: 'success' });
      }
    } catch (e) { /* request 层已提示 */ }
  },

  /** 再做一次 */
  onRetryAgain() {
    this.setData({ answer: '', result: null, submitted: false });
  },

  onBack() {
    wx.navigateBack();
  },
});
