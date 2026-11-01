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

  onLoad(options) {
    const subject = Number(options && options.subject);
    const grade = Number(options && options.grade);
    this.setData({
      theme: app.globalData.theme || 'light',
      iconCamera: getIcon('camera', '#FFC857', 40),
      // 从课文页/教材中心带过来的学科年级，省得再选一次
      subject: subject >= 1 && subject <= 3 ? subject : this.data.subject,
      grade: grade >= 1 && grade <= 6 ? grade : this.data.grade,
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

      // 接口只负责建记录 + 投递任务，立刻返回；识别在后台 worker 里跑
      const res = await api.uploadCustomTextbook({
        subject: this.data.subject,
        grade: this.data.grade,
        volume: this.data.volume,
        imageUrls,
        name: '我的教材',
      });

      app.refreshQuota();
      wx.showLoading({ title: 'AI 识别目录中', mask: true });

      const st = await this.waitRecognize(res.textbookId);
      wx.hideLoading();
      this.setData({ submitting: false });

      if (st.status === 1) {
        wx.showModal({
          title: '识别完成',
          content: `已整理出 ${st.lessonCount} 篇课文，去教材中心选它开始练习吧。`,
          showCancel: false,
          confirmText: '去看看',
          success: () => {
            wx.redirectTo({ url: '/pages/textbook/center' });
          },
        });
      } else if (st.status === 2) {
        wx.showModal({
          title: '识别失败',
          content: '没能从照片里认出目录，可能是画面模糊或目录页不全。消耗的额度已自动退还，换个光线好点的地方重拍试试。',
          showCancel: false,
          confirmText: '重新拍',
        });
      } else {
        // 超过本地等待时间但后端仍在跑：不判失败，也不跳教材中心
        // （识别中的教材不会出现在列表里，跳过去只会看到空的）
        wx.showModal({
          title: '还在整理',
          content: '目录比较多，整理时间较长。过几分钟回到教材中心就能看到，识别失败会自动退还额度。',
          showCancel: false,
          confirmText: '知道了',
        });
      }
    } catch (e) {
      wx.hideLoading();
      this.setData({ submitting: false });
      if (e && e.silent) return;
    }
  },

  /**
   * 轮询识别进度
   *
   * 识别耗时 60-120 秒，远超 wx.request 的 30 秒超时，
   * 所以拆成"提交任务 + 轮询状态"，客户端每个请求都很短。
   * 本地最多等 90 秒，超时不报失败（后端有 10 分钟兜底），
   * 用户可稍后去教材中心看结果。
   *
   * @returns {Promise<{status:number, lessonCount:number}>} status 0=识别中 1=可用 2=失败
   */
  waitRecognize(textbookId) {
    const INTERVAL = 3000;
    const MAX_TRIES = 30;

    return new Promise((resolve) => {
      let tries = 0;

      const tick = async () => {
        tries += 1;
        let st = null;
        try {
          st = await api.getTextbookStatus(textbookId);
        } catch (e) {
          // 网络抖动不终止，继续轮询
        }

        if (st && st.status !== 0) return resolve(st);
        if (tries >= MAX_TRIES) return resolve(st || { status: 0, lessonCount: 0 });

        wx.showLoading({ title: `AI 识别目录中 ${tries * 3}s`, mask: true });
        setTimeout(tick, INTERVAL);
        return undefined;
      };

      tick();
    });
  },
});
