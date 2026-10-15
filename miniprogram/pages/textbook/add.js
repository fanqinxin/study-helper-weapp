/**
 * 添加自定义教材
 * 对应设计稿 11
 *
 * 关键体验：用户只需要拍"目录页"，剩下的（拆单元、拆课文、排序）交给 AI。
 * 这一页会消耗一次 AI 额度，所以必须在提交前明确告知。
 */
const api = require('../../utils/api');
const { chooseImages, getFileSize, formatSize, uploadImages } = require('../../utils/image');
const { getIcon } = require('../../styles/icons');
const app = getApp();

Page({
  data: {
    theme: 'light',
    subject: 1,
    grade: 3,
    volume: 1,
    subjectList: [
      { value: 1, name: '语文' },
      { value: 2, name: '数学' },
      { value: 3, name: '英语' },
    ],
    gradeList: [1, 2, 3, 4, 5, 6],
    volumeList: [
      { value: 1, name: '上册' },
      { value: 2, name: '下册' },
    ],
    images: [],
    totalSize: '0KB',
    quotaLeft: 0,
    quotaLow: false,
    submitting: false,
    iconCamera: '',
  },

  onLoad() {
    this.setData({
      theme: app.globalData.theme || 'light',
      iconCamera: getIcon('camera', '#FFC857', 40),
    });
    this.loadQuota();
  },

  onShow() {
    this.loadQuota();
  },

  onThemeChanged(theme) {
    this.setData({ theme });
  },

  onQuotaChanged(quota) {
    this.setData({ quotaLeft: quota.totalLeft, quotaLow: quota.low });
  },

  async loadQuota() {
    try {
      const quota = app.globalData.quota || (await api.getQuotaBalance());
      app.globalData.quota = quota;
      this.setData({ quotaLeft: quota.totalLeft, quotaLow: quota.low });
    } catch (e) { /* 静默 */ }
  },

  onSubjectTap(e) {
    this.setData({ subject: Number(e.currentTarget.dataset.value) });
  },

  onGradeTap(e) {
    this.setData({ grade: Number(e.currentTarget.dataset.value) });
  },

  onVolumeTap(e) {
    this.setData({ volume: Number(e.currentTarget.dataset.value) });
  },

  /** 选目录页照片 */
  async onChoose() {
    const remain = 3 - this.data.images.length;
    if (remain <= 0) {
      wx.showToast({ title: '最多 3 张目录页', icon: 'none' });
      return;
    }
    try {
      const paths = await chooseImages(remain);
      if (!paths.length) return;

      const added = [];
      for (const p of paths) {
        added.push({ path: p, size: await getFileSize(p) });
      }
      const images = [...this.data.images, ...added].slice(0, 3);
      const total = images.reduce((s, i) => s + (i.size || 0), 0);
      this.setData({ images, totalSize: formatSize(total) });
    } catch (e) {
      wx.showToast({ title: '选图失败', icon: 'none' });
    }
  },

  onRemove(e) {
    const index = Number(e.currentTarget.dataset.index);
    const images = this.data.images.filter((_, i) => i !== index);
    const total = images.reduce((s, i) => s + (i.size || 0), 0);
    this.setData({ images, totalSize: formatSize(total) });
  },

  onPreview(e) {
    const index = Number(e.currentTarget.dataset.index);
    wx.previewImage({
      current: this.data.images[index].path,
      urls: this.data.images.map((i) => i.path),
    });
  },

  /** 提交识别 */
  async onSubmit() {
    if (this.data.submitting) return;

    if (!this.data.images.length) {
      wx.showToast({ title: '先拍一张目录页吧', icon: 'none' });
      return;
    }

    // 预检额度：识别同样走 AI，会消耗 1 次
    if (this.data.quotaLeft === 0) {
      wx.navigateTo({ url: '/pages/wallet/insufficient?freeTotal=0' });
      return;
    }

    const confirm = await new Promise((resolve) => {
      wx.showModal({
        title: '开始识别',
        content: '识别课本目录会消耗 1 次 AI 额度，识别失败会自动退还。确认继续吗？',
        confirmText: '开始识别',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirm) return;

    this.setData({ submitting: true });
    wx.showLoading({ title: '上传中', mask: true });

    try {
      const imageUrls = await uploadImages(this.data.images.map((i) => i.path));

      wx.hideLoading();
      wx.showLoading({ title: 'AI 识别目录中', mask: true });

      const res = await api.uploadCustomTextbook({
        subject: this.data.subject,
        grade: this.data.grade,
        volume: this.data.volume,
        imageUrls,
        name: '我的教材',
      });

      wx.hideLoading();
      app.refreshQuota();

      wx.showModal({
        title: '识别完成',
        content: `已整理出 ${res.lessonCount} 篇课文，去教材中心选它开始练习吧。`,
        showCancel: false,
        confirmText: '去看看',
        success: () => {
          wx.redirectTo({ url: '/pages/textbook/center' });
        },
      });
    } catch (e) {
      wx.hideLoading();
      this.setData({ submitting: false });
      if (e && e.silent) return;
    }
  },
});
