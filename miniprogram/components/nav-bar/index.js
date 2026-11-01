/**
 * 自定义导航栏
 * 支持两种形态：
 *   plain  仅状态栏占位（首页等，设计稿 01/02/06-09）
 *   title  返回 + 标题（设计稿 03/04/05/10-16）
 *
 * 注意：本组件只负责「状态栏高度的占位」，绝不绘制时间/信号。
 * navigationStyle: custom 不会隐藏系统状态栏，再画一遍屏幕顶部必然和系统时间打架。
 */
const { getSystemInfo } = require('../../utils/system');

Component({
  options: { multipleSlots: true },

  properties: {
    /** plain | title */
    mode: { type: String, value: 'plain' },
    title: { type: String, value: '' },
    /** 是否显示返回按钮；只有「栈底页」才需要关掉 */
    showBack: { type: Boolean, value: true },
    /** 背景色，传 transparent 则透明 */
    background: { type: String, value: 'transparent' },
    /** 标题下方是否显示分割线 */
    bordered: { type: Boolean, value: false },
  },

  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    /** 是否还有上一页；没有时返回键退化为「回首页」 */
    canGoBack: true,
  },

  lifetimes: {
    attached() {
      const info = getSystemInfo();
      this.setData({
        statusBarHeight: info.statusBarHeight,
        navBarHeight: info.navBarHeight,
        canGoBack: getCurrentPages().length > 1,
      });
    },
  },

  methods: {
    onBack() {
      if (getCurrentPages().length > 1) {
        // 少数情况下（栈被 reLaunch 重置）navigateBack 会失败，兜底回首页
        wx.navigateBack({
          delta: 1,
          fail: () => wx.switchTab({ url: '/pages/home/home' }),
        });
        return;
      }
      // 栈底页：直接回首页，不能让用户卡在二级页里
      wx.switchTab({ url: '/pages/home/home' });
    },
  },
});
