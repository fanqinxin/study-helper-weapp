/**
 * 家长首页
 * 对应设计稿 15
 *
 * 设计原则（家长视角与孩子完全不同）：
 * 1. 家长没时间逐题看，只关心三件事：学了没、学得怎样、哪里弱
 * 2. 不做实时监控，只给周期性报告，避免变成"盯梢工具"引发逆反
 * 3. 一屏看完，不要跳来跳去
 */
const api = require('../../utils/api');
const { SUBJECT_NAME } = require('../../utils/constants');
const { getIcon } = require('../../styles/icons');
const app = getApp();

Page({
  data: {
    theme: 'light',
    loading: true,
    /** 孩子列表（支持多孩） */
    children: [],
    /** 当前选中孩子的 uid */
    currentUid: 0,
    /** 当前孩子信息 */
    child: null,
    /** 本周概览 */
    overview: {
      planRate: 0,
      homeworkCount: 0,
      mistakePending: 0,
      weekRate: 0,
    },
    /** 需要关注的知识点 */
    weakPoints: [],
    /** 周趋势 */
    weekBars: [],
    /** 最近一次批改 */
    latest: null,
    /** 图标 */
    iconBell: '',
    iconWarning: '',
    iconReport: '',
    iconBind: '',
  },

  onLoad() {
    this.setData({
      theme: app.globalData.theme || 'light',
      // 家长端统一用低饱和的深灰系图标，避免儿童端的明快配色
      iconBell: getIcon('clock', '#37352F', 40),
      iconWarning: getIcon('warning', '#FF8C7A', 40),
      iconReport: getIcon('book', '#6BB6E0', 36),
      iconBind: getIcon('plus', '#7DD3A0', 36),
    });
    this.load();
  },

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  onThemeChanged(theme) {
    this.setData({ theme });
  },

  async load() {
    try {
      const children = await api.listChildren();
      if (!children.length) {
        this.setData({ loading: false, children: [] });
        return;
      }

      const currentUid = this.data.currentUid && children.some((c) => c.uid === this.data.currentUid)
        ? this.data.currentUid
        : children[0].uid;
      const child = children.find((c) => c.uid === currentUid) || children[0];

      // 家长端专用接口：按孩子 uid 聚合，服务端校验绑定关系
      const res = await api.getParentOverview(currentUid);
      const { overview, weakPoints, weekBars: rawBars, latest: rawLatest } = res;

      const weekBars = (rawBars || []).map((d) => ({
        label: this.weekdayLabel(d.planDate),
        height: d.total ? Math.round((d.done / d.total) * 100) : 0,
      }));

      this.setData({
        loading: false,
        children,
        currentUid,
        child,
        overview: {
          planRate: overview.planRate || 0,
          homeworkCount: overview.homeworkCount || 0,
          mistakePending: overview.mistakePending || 0,
          weekRate: overview.weekRate || 0,
        },
        weakPoints: weakPoints || [],
        weekBars,
        latest: rawLatest
          ? {
            ...rawLatest,
            subjectName: SUBJECT_NAME[rawLatest.subject] || '',
            timeText: this.formatTime(rawLatest.createdAt),
          }
          : null,
      });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  weekdayLabel(dateStr) {
    if (!dateStr) return '';
    const d = new Date(String(dateStr).replace(/-/g, '/'));
    return ['日', '一', '二', '三', '四', '五', '六'][d.getDay()] || '';
  },

  formatTime(str) {
    if (!str) return '';
    return String(str).replace('T', ' ').slice(5, 16);
  },

  /** 切换孩子 */
  onChildTap(e) {
    const uid = Number(e.currentTarget.dataset.uid);
    if (uid === this.data.currentUid) return;
    this.setData({ currentUid: uid, loading: true });
    this.load();
  },

  /** 查看详情报告 */
  onGoReport() {
    wx.navigateTo({ url: `/pages/parent/report?uid=${this.data.currentUid}` });
  },

  /** 进绑定页 */
  onGoBind() {
    wx.navigateTo({ url: '/pages/parent/bind' });
  },

  /** 切回孩子端 */
  onSwitchToChild() {
    wx.showModal({
      title: '切换到孩子端',
      content: '将以孩子身份重新登录。',
      success: async (r) => {
        if (!r.confirm) return;
        wx.showLoading({ title: '切换中', mask: true });
        try {
          const { login, setUser } = require('../../utils/auth');
          const data = await login(1);
          setUser(data.user);
          app.globalData.user = data.user;
          wx.hideLoading();
          wx.reLaunch({ url: '/pages/home/home' });
        } catch (e) {
          wx.hideLoading();
          wx.showToast({ title: '切换失败', icon: 'none' });
        }
      },
    });
  },
});
