/**
 * 空状态占位
 * 用于列表无数据时给出引导，而不是一片空白
 */
const { getIcon } = require('../../styles/icons');

Component({
  properties: {
    /** 主文案 */
    text: { type: String, value: '这里还什么都没有' },
    /** 补充说明 */
    desc: { type: String, value: '' },
    /** 按钮文案，为空则不显示按钮 */
    action: { type: String, value: '' },
    /** 图标名，见 styles/icons.js PATHS */
    icon: { type: String, value: 'book' },
    /** 图标色 */
    color: { type: String, value: '#FFC857' },
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
    'icon, color': function () {
      this.refreshIcon();
    },
  },

  methods: {
    refreshIcon() {
      this.setData({ iconUrl: getIcon(this.data.icon, this.data.color, 52) });
    },
    onAction() {
      this.triggerEvent('action');
    },
  },
});
