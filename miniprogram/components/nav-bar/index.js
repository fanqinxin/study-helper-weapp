/**
 * 自定义导航栏
 * 支持两种形态：
 *   plain  仅状态栏占位（首页等，设计稿 01/02/06-09）
 *   title  返回 + 标题（设计稿 03/04/05/10-16）
 */
const { getSystemInfo } = require('../../utils/system');

Component({
  options: { multipleSlots: true },

  properties: {
    /** plain | title */
    mode: { type: String, value: 'plain' },
    title: { type: String, value: '' },
    /** 是否显示返回箭头 */
    showBack: { type: Boolean, value: true },
    /** 背景色，传 transparent 则透明 */
    background: { type: String, value: 'transparent' },
    /** 标题下方是否显示分割线 */
    bordered: { type: Boolean, value: false },
  },

  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    timeText: '9:41',
  },

  lifetimes: {
    attached() {
      const info = getSystemInfo();
      this.setData({
        statusBarHeight: info.statusBarHeight,
        navBarHeight: info.navBarHeight,
        timeText: this.formatTime(),
      });
      // 每分钟更新一次时间，保持与真实状态栏一致
      this._timer = setInterval(() => {
        this.setData({ timeText: this.formatTime() });
      }, 60000);
    },
    detached() {
      if (this._timer) clearInterval(this._timer);
    },
  },

  methods: {
    formatTime() {
      const d = new Date();
      return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    },

    onBack() {
      const pages = getCurrentPages();
      if (pages.length > 1) {
        wx.navigateBack();
      } else {
        wx.switchTab({ url: '/pages/home/home' });
      }
    },
  },
});
