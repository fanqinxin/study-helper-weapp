/**
 * 额度胶囊 —— 展示剩余次数，紧张时变色提醒
 *
 * 设计意图：额度不足 3 次时提前在首页提示，
 * 避免用户点了上传才被拦，体验更顺。
 */
const { getIcon } = require('../../styles/icons');

Component({
  properties: {
    /** 剩余次数（-1 表示不限量） */
    left: { type: Number, value: 0 },
    /** 是否紧张 */
    low: { type: Boolean, value: false },
    /** 是否可点击跳额度中心 */
    clickable: { type: Boolean, value: true },
  },

  data: {
    boltIcon: '',
  },

  lifetimes: {
    attached() {
      this.setData({ boltIcon: getIcon('bolt', '#E0A32E', 18) });
    },
  },

  methods: {
    onTap() {
      if (!this.data.clickable) return;
      wx.navigateTo({ url: '/pages/wallet/center' });
    },
  },
});
