/**
 * AI 批改中
 * 对应设计稿 14
 *
 * 这一页是"等待体验"的关键：批改要 10-30 秒，
 * 如果只是转圈，家长会以为卡死了。
 * 所以用分步进度文案 + 轮询状态，让等待有预期。
 */
const api = require('../../utils/api');
const { HW_STATUS } = require('../../utils/constants');
const config = require('../../config/index');
const app = getApp();

/** 分步文案：随等待时长推进，给用户"正在做什么"的确定感 */
const STEPS = [
  { at: 0, text: '正在读取作业照片…' },
  { at: 4, text: '正在识别题目内容…' },
  { at: 10, text: '正在逐题核对答案…' },
  { at: 18, text: '正在整理讲解…' },
  { at: 26, text: '马上就好，请稍等一下…' },
];

Page({
  data: {
    theme: 'light',
    homeworkId: 0,
    cached: false,
    /** 当前阶段文案 */
    stepText: '正在读取作业照片…',
    /** 已等待秒数 */
    elapsed: 0,
    /** 进度百分比（模拟推进，最高 95%） */
    percent: 6,
    failed: false,
    errorMsg: '',
  },

  onLoad(options) {
    const id = Number(options.id) || 0;
    const cached = options.cached === '1';
    this.setData({ homeworkId: id, cached, theme: app.globalData.theme || 'light' });

    if (!id) {
      this.setData({ failed: true, errorMsg: '缺少作业 ID' });
      return;
    }

    // 命中缓存说明服务端已有结果，直接跳报告
    if (cached) {
      this.goReport();
      return;
    }

    this.startTick();
    this.startPoll();
  },

  onUnload() {
    this.stop();
  },

  onThemeChanged(theme) {
    this.setData({ theme });
  },

  /** 秒表：驱动文案与进度 */
  startTick() {
    this._tick = setInterval(() => {
      const elapsed = this.data.elapsed + 1;
      const step = [...STEPS].reverse().find((s) => elapsed >= s.at) || STEPS[0];
      // 进度按时间渐进逼近 95%，避免长时间停在某处
      const percent = Math.min(95, Math.round(6 + (elapsed / 30) * 89));
      this.setData({ elapsed, stepText: step.text, percent });
    }, 1000);
  },

  /** 轮询批改结果 */
  startPoll() {
    const startedAt = Date.now();
    this._polling = true;

    const poll = async () => {
      if (!this._polling) return;

      // 超时保护：避免无限轮询
      if (Date.now() - startedAt > config.pollTimeout) {
        this.stop();
        this.setData({
          failed: true,
          errorMsg: '批改时间有点久，可能网络不太顺畅。稍后可在「我的 → 批改记录」查看结果。',
        });
        return;
      }

      try {
        const status = await api.getHomeworkStatus(this.data.homeworkId);

        if (status.status === HW_STATUS.DONE) {
          this.stop();
          this.setData({ percent: 100, stepText: '批改完成' });
          setTimeout(() => this.goReport(), 400);
          return;
        }

        if (status.status === HW_STATUS.FAILED) {
          this.stop();
          this.setData({
            failed: true,
            errorMsg: status.errorMsg || '这次批改没成功，请重新拍一张试试',
          });
          return;
        }
      } catch (e) {
        // 单次失败不终止，下一轮继续
      }

      this._timer = setTimeout(poll, config.pollInterval);
    };

    poll();
  },

  stop() {
    this._polling = false;
    if (this._tick) clearInterval(this._tick);
    if (this._timer) clearTimeout(this._timer);
    this._tick = null;
    this._timer = null;
  },

  goReport() {
    wx.redirectTo({ url: `/pages/homework/report?id=${this.data.homeworkId}` });
  },

  /** 失败：重新上传 */
  onRetry() {
    wx.redirectTo({ url: '/pages/homework/upload' });
  },

  /** 失败：先离开 */
  onLeave() {
    wx.switchTab({ url: '/pages/mine/mine' });
  },
});
