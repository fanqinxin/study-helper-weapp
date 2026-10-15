/**
 * 列表行
 * "我的"页 / 家长端 / 设置项反复出现：左侧图标 + 标题 + 副标题 + 右侧值 + 箭头
 */
const { getIcon } = require('../../styles/icons');

Component({
  properties: {
    /** 图标名 */
    icon: { type: String, value: '' },
    /** 图标底色（CSS 变量或色值） */
    iconBg: { type: String, value: 'var(--bg-subtle)' },
    /** 图标色 */
    iconColor: { type: String, value: '#37352F' },
    title: { type: String, value: '' },
    desc: { type: String, value: '' },
    /** 右侧文字 */
    value: { type: String, value: '' },
    /** 是否显示右箭头 */
    arrow: { type: Boolean, value: true },
    /** 是否显示底部细分隔线 */
    divider: { type: Boolean, value: true },
    /** 红色危险样式（退出登录等） */
    danger: { type: Boolean, value: false },
  },

  data: {
    iconUrl: '',
  },

  lifetimes: {
    attached() {
      this.refreshIcon();
    },
  },

  observers: {
    'icon, iconColor': function () {
      this.refreshIcon();
    },
  },

  methods: {
    refreshIcon() {
      if (!this.data.icon) return this.setData({ iconUrl: '' });
      this.setData({ iconUrl: getIcon(this.data.icon, this.data.iconColor, 24) });
    },
    onTap() {
      this.triggerEvent('tap');
    },
  },
});
