/**
 * 今日作业 · 闯关清单
 *
 * 家长把老师布置的作业交上来：粘贴班级群文字（主要方式）或拍照截图（辅助），
 * AI 按学科整理成可逐项打勾的任务清单；全部完成 = 闯关成功。
 *
 * 识别是长耗时调用：入队立即返回，这里轮询 status（与教材识别同一套模式）。
 */
const api = require('../../utils/api');
const { getUser, ensureLogin } = require('../../utils/auth');
const { chooseImages, uploadImages } = require('../../utils/image');

const app = getApp();

/** 学科分组顺序与名称（与服务端 SUBJECT_NAME 对齐） */
const GROUP_ORDER = [0, 1, 2, 3, 4];
const GROUP_NAME = { 0: '每日必做', 1: '语文', 2: '数学', 3: '英语', 4: '其他' };

/** 本地日期 YYYY-MM-DD（手机在国内就是东八区，直接拼即可） */
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 把任务单 items 按学科分组 */
function groupItems(items) {
  return GROUP_ORDER.map((s) => ({
    subject: s,
    name: GROUP_NAME[s],
    items: items.filter((it) => it.subject === s),
  })).filter((g) => g.items.length);
}

function calcProgress(items) {
  const total = items.length;
  const done = items.filter((it) => it.done).length;
  return {
    doneCount: done,
    totalCount: total,
    allDone: total > 0 && done === total,
    percent: total ? Math.round((done / total) * 100) : 0,
  };
}

Page({
  data: {
    theme: 'light',
    loading: true,
    /** 今天的任务单（含 items） */
    assignment: null,
    /** 按学科分组后的条目 */
    groups: [],
    doneCount: 0,
    totalCount: 0,
    allDone: false,
    percent: 0,
    /** 上传中（选图+传图） */
    uploading: false,
    /** 粘贴的作业文字 */
    draftText: '',
    /** AI 识别中 */
    parsing: false,
    parseSeconds: 0,
  },

  onLoad() {
    this.setData({ theme: app.globalData.theme || 'light' });
  },

  onShow() {
    this.load();
  },

  onHide() {
    this.stopPoll();
  },

  onUnload() {
    this.stopPoll();
  },

  onThemeChanged(theme) {
    this.setData({ theme });
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    try {
      let user = getUser();
      if (!user) user = await ensureLogin();
      if (!user) {
        this.setData({ loading: false });
        return;
      }

      const list = await api.listAssignments({ limit: 5 }).catch(() => []);
      const today = list.find((a) => a.taskDate === todayStr() && a.statusText === 'ready');

      this.stopPoll();
      if (!today) {
        // 今天还没任务单：可能是识别中/失败的那份也在列表里，拿出来给用户看进度
        const pending = list.find((a) => a.taskDate === todayStr());
        if (pending && pending.statusText === 'pending') {
          this.setData({ loading: false, assignment: null, parsing: true, parseSeconds: 0 });
          this.pollParse(pending.id);
          return;
        }
        this.setData({ loading: false, assignment: null, groups: [], parsing: false });
        return;
      }

      this.applyAssignment(today);
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  applyAssignment(a) {
    const items = (a.items || []).map((it) => ({ ...it }));
    const progress = calcProgress(items);
    this.setData({
      loading: false,
      parsing: false,
      assignment: { ...a, items },
      groups: groupItems(items),
      ...progress,
    });
  },

  /** ===== 提交作业 ===== */

  /** 粘贴文字输入 */
  onDraftInput(e) {
    this.setData({ draftText: e.detail.value || '' });
  },

  /** 把粘贴的文字交给 AI 整理成任务单（主要方式：比拍照清楚，识别也更稳） */
  async onSubmitText() {
    if (this.data.uploading || this.data.parsing) return;
    const text = (this.data.draftText || '').trim();
    if (!text) {
      wx.showToast({ title: '先粘贴老师布置的作业', icon: 'none' });
      return;
    }

    this.setData({ uploading: true, parsing: true, parseSeconds: 0, assignment: null });
    try {
      const res = await api.createAssignment({ text, taskDate: todayStr() });
      if (!res || !res.assignmentId) {
        this.setData({ uploading: false, parsing: false });
        wx.showToast({ title: '提交失败，请重试', icon: 'none' });
        return;
      }
      if (app.refreshQuota) app.refreshQuota();

      // 命中幂等且已识别完成：直接刷新
      if (res.status === 'ready') {
        this.setData({ uploading: false });
        await this.load();
        return;
      }
      this.setData({ uploading: false });
      this.pollParse(res.assignmentId);
    } catch (e) {
      // request 层已提示（额度不足会跳拦截页）
      this.setData({ uploading: false, parsing: false });
    }
  },

  /** ===== 拍照识别（辅助方式） ===== */

  async onUpload() {
    if (this.data.uploading || this.data.parsing) return;
    let paths;
    try {
      paths = await chooseImages(3);
    } catch (e) {
      wx.showToast({ title: '选图失败，请重试', icon: 'none' });
      return;
    }
    if (!paths || !paths.length) return;

    this.setData({ uploading: true });
    try {
      const urls = await uploadImages(paths);
      const res = await api.createAssignment({ imageUrls: urls, taskDate: todayStr() });
      if (!res || !res.assignmentId) {
        wx.showToast({ title: '提交失败，请重试', icon: 'none' });
        return;
      }
      if (app.refreshQuota) app.refreshQuota();

      // 命中幂等且已识别完成：直接刷新
      if (res.status === 'ready') {
        await this.load();
        return;
      }
      this.setData({ uploading: false, parsing: true, parseSeconds: 0, assignment: null });
      this.pollParse(res.assignmentId);
    } catch (e) {
      // request 层已提示（额度不足会跳拦截页）
    } finally {
      this.setData({ uploading: false });
    }
  },

  /** 轮询识别结果，最多等 90 秒 */
  pollParse(assignmentId) {
    const startedAt = Date.now();
    this.stopPoll();

    this._tick = setInterval(() => {
      this.setData({ parseSeconds: this.data.parseSeconds + 1 });
    }, 1000);

    const step = async () => {
      if (!this.data.parsing) return this.stopPoll();

      if (Date.now() - startedAt > 90000) {
        this.stopPoll();
        this.setData({ parsing: false });
        wx.showToast({ title: '识别时间有点久，稍后下拉刷新看看', icon: 'none' });
        return;
      }

      try {
        const st = await api.getAssignmentStatus(assignmentId);
        if (st.status === 'ready') {
          this.stopPoll();
          wx.showToast({ title: '任务单生成好了', icon: 'success' });
          await this.load();
          return;
        }
        if (st.status === 'failed') {
          this.stopPoll();
          this.setData({ parsing: false });
          wx.showModal({
            title: '没识别出作业',
            content: st.error || '请确认拍的是老师布置的作业内容，再试一次。',
            showCancel: false,
          });
          return;
        }
      } catch (e) {
        // 单次失败不终止，下一轮继续
      }
      this._poll = setTimeout(step, 3000);
    };

    this._poll = setTimeout(step, 2000);
  },

  stopPoll() {
    if (this._poll) clearTimeout(this._poll);
    if (this._tick) clearInterval(this._tick);
    this._poll = null;
    this._tick = null;
  },

  /** ===== 打卡 ===== */

  async onToggleItem(e) {
    const { id } = e.currentTarget.dataset;
    if (!id || !this.data.assignment) return;

    const prevItems = this.data.assignment.items;
    const target = prevItems.find((it) => it.id === id);
    if (!target) return;

    // 乐观更新：点了立刻打勾，失败再回滚（打卡是高频轻操作，别让人等网络）
    const items = prevItems.map((it) => (it.id === id ? { ...it, done: !it.done } : it));
    this.applyAssignment({ ...this.data.assignment, items });

    try {
      await api.toggleAssignmentItem(id, !target.done);
    } catch (err) {
      this.applyAssignment({ ...this.data.assignment, items: prevItems });
      wx.showToast({ title: '网络不太顺畅，再试一次', icon: 'none' });
    }
  },

  /** ===== 导出打印闯关单 ===== */

  async onExportPrint() {
    if (!this.data.assignment) return;
    try {
      const res = await api.getAssignmentPrintUrl(this.data.assignment.id);
      if (!res || !res.url) return;
      wx.setClipboardData({
        data: res.url,
        success: () => {
          wx.showModal({
            title: '链接已复制',
            content: '把链接粘贴到电脑浏览器打开，按 Ctrl+P 打印就是闯关任务单。链接 7 天内有效。',
            showCancel: false,
            confirmText: '知道了',
          });
        },
      });
    } catch (e) {
      // request 层已提示
    }
  },
});
