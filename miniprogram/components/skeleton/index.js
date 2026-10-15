/**
 * 骨架屏
 * 加载中先占位，避免页面结构跳动（小学生家长对"卡"很敏感）
 */
Component({
  properties: {
    /** 显示几行 */
    rows: { type: Number, value: 3 },
    /** 是否显示顶部大块 */
    hero: { type: Boolean, value: false },
  },
});
