/**
 * 圆形分数环
 * 设计稿里多处出现（批改报告 / 学习报告 / 家长报告），抽成组件复用。
 */
Component({
  properties: {
    /** 0-100 */
    score: { type: Number, value: 0 },
    /** 环直径（rpx） */
    size: { type: Number, value: 200 },
    /** 主色 */
    color: { type: String, value: '#FFC857' },
    /** 环底色 */
    track: { type: String, value: '#F5EDDA' },
    /** 环线宽（相对直径的比例） */
    strokeRatio: { type: Number, value: 0.09 },
    /** 中间主文案，留空则显示分数 */
    label: { type: String, value: '' },
    /** 主文案下方小字 */
    sub: { type: String, value: '' },
  },

  data: {
    viewSize: 100,
    strokeWidth: 9,
    radius: 45,
    circumference: 283,
    offset: 283,
    displayScore: 0,
    gradId: '',
  },

  lifetimes: {
    attached() {
      this.build();
    },
  },

  observers: {
    'score, size, strokeRatio': function () {
      this.build();
    },
  },

  methods: {
    build() {
      const size = Number(this.data.size) || 200;
      const stroke = Math.max(4, size * Number(this.data.strokeRatio || 0.09));
      const r = (size - stroke) / 2;
      const c = 2 * Math.PI * r;
      const score = Math.max(0, Math.min(100, Number(this.data.score) || 0));

      this.setData({
        viewSize: size,
        strokeWidth: stroke,
        radius: r,
        circumference: c,
        offset: c * (1 - score / 100),
        displayScore: score,
        gradId: `grad_${this.__wxExparserNodeId || Math.random().toString(36).slice(2, 8)}`,
      });
    },
  },
});
