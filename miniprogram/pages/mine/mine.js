/**
 * 我的
 * 对应设计稿 09 / 17（深色）
 */
const api = require('../../utils/api');
const { getUser, setUser, clearToken } = require('../../utils/auth');
const app = getApp();

Page({
  data: {
    theme: 'light',
    isDark: false,
    user: null,
    quotaLeft: 0,
    quotaLow: false,
    /** 概览数据 */
    stats: { homework: 0, mistake: 0, wrongRate: 0 },
    /** 设置项（图标在 build 里生成） */
    groups: [],
    tabIndex: 4,
  },

  onLoad() {
    const theme = app.globalData.theme || 'light';
    this.setData({ theme, isDark: theme === 'dark', user: getUser() });
    this.buildGroups();
  },

  onShow() {
    this.setData({ tabIndex: 4 });
    this.load();
  },

  onThemeChanged(theme) {
    this.setData({ theme, isDark: theme === 'dark' });
    this.buildGroups();
  },

  onQuotaChanged(quota) {
    this.setData({ quotaLeft: quota.totalLeft, quotaLow: quota.low });
  },

  async load() {
    try {
      const user = getUser() || (await api.getProfile().catch(() => null));
      const quota = app.globalData.quota || (await api.getQuotaBalance().catch(() => null));

      if (quota) app.globalData.quota = quota;

      // 概览：批改次数（取总数）+ 错题数
      const [hwRes, stats] = await Promise.all([
        api.listHomework({ page: 1, size: 1 }).catch(() => ({ list: [], total: 0 })),
        api.getMistakeStats().catch(() => null),
      ]);

      this.setData({
        user,
        quotaLeft: quota ? quota.totalLeft : 0,
        quotaLow: quota ? quota.low : false,
        stats: {
          homework: hwRes && hwRes.total ? Number(hwRes.total) : 0,
          mistake: stats ? stats.pending : 0,
        },
      });
      this.buildGroups();
    } catch (e) { /* 静默 */ }
  },

  /** 设置项分组 */
  buildGroups() {
    const dark = this.data.isDark;
    const groups = [
      {
        key: 'learn',
        title: '学习',
        items: [
          {
            key: 'textbook',
            icon: 'book',
            iconColor: '#FFC857',
            iconBg: 'var(--brand-light)',
            title: '我的教材',
            value: this.data.user && this.data.user.textbookId ? '已选择' : '未选择',
            action: 'textbook',
          },
          {
            key: 'record',
            icon: 'lesson',
            iconColor: '#6BB6E0',
            iconBg: 'var(--sky-light)',
            title: '批改记录',
            value: '',
            action: 'record',
          },
          {
            key: 'plan',
            icon: 'plan',
            iconColor: '#7DD3A0',
            iconBg: 'var(--grass-light)',
            title: '学习计划',
            value: '',
            action: 'plan',
          },
        ],
      },
      {
        key: 'family',
        title: '家庭',
        items: [
          {
            key: 'invite',
            icon: 'shield',
            iconColor: '#FF8C7A',
            iconBg: 'var(--coral-light)',
            title: '邀请家长查看',
            desc: '家长可看学习报告，不能改答案',
            value: '',
            action: 'invite',
          },
          {
            key: 'parentMode',
            icon: 'mine',
            iconColor: '#6BB6E0',
            iconBg: 'var(--sky-light)',
            title: '切换到家长端',
            value: '',
            action: 'parentMode',
          },
        ],
      },
      {
        key: 'settings',
        title: '设置',
        items: [
          {
            key: 'theme',
            icon: 'spark',
            iconColor: '#FFC857',
            iconBg: 'var(--brand-light)',
            title: '深色模式',
            desc: dark ? '已开启' : '晚上护眼',
            value: '',
            action: 'theme',
            arrow: false,
          },
          {
            key: 'quota',
            icon: 'bolt',
            iconColor: '#E0A32E',
            iconBg: 'var(--brand-light)',
            title: '使用记录',
            desc: '查看剩余次数与消耗明细',
            value: '',
            action: 'quota',
          },
          {
            key: 'about',
            icon: 'star',
            iconColor: '#A09884',
            iconBg: 'var(--bg-subtle)',
            title: '关于我们',
            value: 'v1.0.0',
            action: 'about',
          },
          {
            key: 'privacy',
            icon: 'shield',
            iconColor: '#7DD3A0',
            iconBg: 'var(--grass-light)',
            title: '隐私政策',
            value: '',
            action: 'privacy',
          },
          {
            key: 'terms',
            icon: 'book',
            iconColor: '#6BB6E0',
            iconBg: 'var(--sky-light)',
            title: '用户协议',
            value: '',
            action: 'terms',
          },
        ],
      },
    ];
    this.setData({ groups });
  },

  /** 深色模式用 switch 更直观 */
  onToggleTheme(e) {
    const on = e.detail.value;
    app.setTheme(on ? 'dark' : 'light');
  },

  /** 通用点击分发 */
  onItemTap(e) {
    const action = e.currentTarget.dataset.action;
    switch (action) {
      case 'textbook':
        wx.navigateTo({ url: '/pages/textbook/center' });
        break;
      case 'record':
        // 批改记录复用家长报告的列表能力，这里先跳课表页兜底
        wx.navigateTo({ url: '/pages/homework/upload' });
        break;
      case 'plan':
        wx.switchTab({ url: '/pages/plan/plan' });
        break;
      case 'invite':
        this.showInvite();
        break;
      case 'parentMode':
        this.switchToParent();
        break;
      case 'quota':
        wx.navigateTo({ url: '/pages/wallet/center' });
        break;
      case 'about':
        wx.showModal({
          title: '关于我们',
          content: '一个帮小学生同步课本练习、AI 批改作业的助手。\n错题会自动收进错题本，学习计划每天只有 3 件事。',
          showCancel: false,
          confirmText: '知道了',
        });
        break;
      case 'privacy':
        wx.navigateTo({ url: '/pages/legal/privacy' });
        break;
      case 'terms':
        wx.navigateTo({ url: '/pages/legal/terms' });
        break;
      default:
        break;
    }
  },

  /** 生成邀请码并展示 */
  async showInvite() {
    try {
      const res = await api.getInviteCode();
      wx.showModal({
        title: '邀请码',
        content: `${res.inviteCode}\n\n让家长在家长端输入这串码即可绑定，绑定后能看到你的学习报告。`,
        confirmText: '复制',
        success(r) {
          if (r.confirm) {
            wx.setClipboardData({ data: res.inviteCode });
          }
        },
      });
    } catch (e) { /* request 层已提示 */ }
  },

  /** 切换家长端：以家长身份重新登录 */
  switchToParent() {
    wx.showModal({
      title: '切换到家长端',
      content: '将使用家长身份重新登录，孩子数据不会丢失。',
      success: async (r) => {
        if (!r.confirm) return;
        wx.showLoading({ title: '切换中', mask: true });
        try {
          const { login } = require('../../utils/auth');
          const data = await login(2);
          setUser(data.user);
          app.globalData.user = data.user;
          wx.hideLoading();
          wx.reLaunch({ url: '/pages/parent/home' });
        } catch (e) {
          wx.hideLoading();
          wx.showToast({ title: '切换失败，请重试', icon: 'none' });
        }
      },
    });
  },

  /** 点击头像编辑昵称 */
  onEditProfile() {
    wx.showModal({
      title: '修改昵称',
      editable: true,
      placeholderText: '输入新的昵称',
      success: async (r) => {
        if (!r.confirm || !r.content) return;
        try {
          const user = await api.updateProfile({ nickname: r.content });
          setUser(user);
          app.globalData.user = user;
          this.setData({ user });
          wx.showToast({ title: '已保存', icon: 'success' });
        } catch (e) { /* 已提示 */ }
      },
    });
  },

  /** 退出登录 */
  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后需要重新登录，学习记录不会丢失。',
      confirmText: '退出',
      confirmColor: '#FF8C7A',
      success(r) {
        if (!r.confirm) return;
        clearToken();
        app.globalData.user = null;
        app.globalData.quota = null;
        wx.reLaunch({ url: '/pages/home/home' });
      },
    });
  },
});
