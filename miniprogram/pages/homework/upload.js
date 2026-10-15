/**
 * 作业上传
 * 对应设计稿 04
 *
 * 成本控制要点（本页是最关键的省钱闸门）：
 * 1. 选图后立刻压缩（长边 1600 / ≤1MB），压缩在这里发生，不是服务端
 * 2. 提交前明确展示"本次会消耗 1 次额度"，避免意外扣费引发客诉
 * 3. 额度不足时直接拦截在提交前，不让用户白等一场
 */
const api = require('../../utils/api');
const { chooseImages, getFileSize, formatSize } = require('../../utils/image');
const { getIcon } = require('../../styles/icons');
const { SUBJECT, SUBJECT_NAME } = require('../../utils/constants');
const config = require('../../config/index');
const app = getApp();

Page({
  data: {
    theme: 'light',
    /** 学科：1语文 2数学 3英语 */
    subject: SUBJECT.CHINESE,
    subjectList: [
      { value: SUBJECT.CHINESE, name: '语文' },
      { value: SUBJECT.MATH, name: '数学' },
      { value: SUBJECT.ENGLISH, name: '英语' },
    ],
    subjectName: '语文',
    /** 已选图片 [{ path, size }] */
    images: [],
    maxCount: config.maxUploadCount,
    /** 总大小文案 */
    totalSize: '0KB',
    /** 额度 */
    quotaLeft: 0,
    quotaLow: false,
    /** 关联课文（可选） */
    lessonId: null,
    lessonTitle: '',
    lessons: [],
    /** 提交中 */
    submitting: false,
    iconCamera: '',
  },

  onLoad() {
    this.setData({
      theme: app.globalData.theme || 'light',
      iconCamera: getIcon('camera', '#FF8C7A', 40),
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

  /** 切换学科 */
  onSubjectTap(e) {
    const value = Number(e.currentTarget.dataset.value);
    this.setData({ subject: value, subjectName: SUBJECT_NAME[value] });
  },

  /** 选图 */
  async onChoose() {
    const remain = this.data.maxCount - this.data.images.length;
    if (remain <= 0) {
      wx.showToast({ title: `最多 ${this.data.maxCount} 张`, icon: 'none' });
      return;
    }

    try {
      // chooseImages 内部已完成压缩
      const paths = await chooseImages(remain);
      if (!paths.length) return;

      const added = [];
      for (const p of paths) {
        const size = await getFileSize(p);
        added.push({ path: p, size });
      }

      const images = [...this.data.images, ...added].slice(0, this.data.maxCount);
      this.refreshTotal(images);
    } catch (e) {
      wx.showToast({ title: '选图失败，请重试', icon: 'none' });
    }
  },

  /** 删除某张 */
  onRemove(e) {
    const index = Number(e.currentTarget.dataset.index);
    const images = this.data.images.filter((_, i) => i !== index);
    this.refreshTotal(images);
  },

  /** 预览 */
  onPreview(e) {
    const index = Number(e.currentTarget.dataset.index);
    wx.previewImage({
      current: this.data.images[index].path,
      urls: this.data.images.map((i) => i.path),
    });
  },

  refreshTotal(images) {
    const total = images.reduce((s, i) => s + (i.size || 0), 0);
    this.setData({ images, totalSize: formatSize(total) });
  },

  /**
   * 提交批改
   * 顺序：本地额度预检 → 上传图片 → 提交批改 → 跳转处理页
   */
  async onSubmit() {
    if (this.data.submitting) return;

    if (!this.data.images.length) {
      wx.showToast({ title: '先拍一张作业照片吧', icon: 'none' });
      return;
    }

    // 额度预检：本地先拦一次，减少一次无谓的上传
    if (this.data.quotaLeft === 0) {
      wx.navigateTo({
        url: `/pages/wallet/insufficient?freeTotal=${this.data.quotaLeft}`,
      });
      return;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: '上传中', mask: true });

    try {
      // 1. 逐张上传换 URL
      const { uploadImages } = require('../../utils/image');
      const imageUrls = await uploadImages(this.data.images.map((i) => i.path));

      wx.hideLoading();
      wx.showLoading({ title: '提交批改', mask: true });

      // 2. 提交批改（服务端扣额度）
      const res = await api.analyzeHomework({
        subject: this.data.subject,
        imageUrls,
        lessonId: this.data.lessonId,
      });

      wx.hideLoading();

      // 3. 额度已变化，刷新全局
      app.refreshQuota();

      // 4. 跳处理页
      wx.redirectTo({
        url: `/pages/homework/processing?id=${res.homeworkId}&cached=${res.cached ? 1 : 0}`,
      });
    } catch (e) {
      wx.hideLoading();
      this.setData({ submitting: false });
      // 额度不足已由 request 层统一跳转，这里不重复提示
      if (e && e.silent) return;
    }
  },
});
