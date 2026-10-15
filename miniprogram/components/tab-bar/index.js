/**
 * 自定义 Tab Bar（胶囊式，与设计稿一致）
 *
 * 说明：必须与 app.json 中 tabBar.list 的顺序和 pagePath 完全一致。
 * 图标用内联 SVG data URI，保证矢量清晰度。
 */
const { getIcon } = require('../../styles/icons');

/** 图标名与 tab 一一对应 */
const TABS = [
  { path: '/pages/home/home', text: '首页', icon: 'home' },
  { path: '/pages/lesson/list', text: '课文', icon: 'lesson' },
  { path: '/pages/plan/plan', text: '计划', icon: 'plan' },
  { path: '/pages/mistake/list', text: '错题', icon: 'mistake' },
  { path: '/pages/mine/mine', text: '我的', icon: 'mine' },
];

const ICON_NORMAL = '#A09884';
const ICON_ACTIVE = '#37352F';

Component({
  properties: {
    /** 当前选中索引，由页面传入 */
    current: { type: Number, value: 0 },
  },

  data: {
    list: [],
  },

  lifetimes: {
    attached() {
      this.buildList();
    },
  },

  observers: {
    // 深色模式切换时重建图标颜色
    'current': function () {
      if (!this.data.list.length) this.buildList();
    },
  },

  methods: {
    buildList() {
      const list = TABS.map((t, i) => ({
        ...t,
        iconNormal: getIcon(t.icon, ICON_NORMAL, 22),
        iconActive: getIcon(t.icon, ICON_ACTIVE, 22),
      }));
      this.setData({ list });
    },

    onTap(e) {
      const { index, path } = e.currentTarget.dataset;
      if (index === this.data.current) return;
      wx.switchTab({ url: path });
    },
  },
});
