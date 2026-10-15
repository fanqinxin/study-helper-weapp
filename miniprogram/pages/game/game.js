/**
 * 学习小游戏 —— 识字连线
 * 对应设计稿 08
 *
 * 为什么不做复杂游戏：
 * 1. 小游戏的目标是"每天愿意打开一次"，不是好玩
 * 2. 内容必须和课本强相关，否则家长会认为是浪费时间
 * 3. 纯本地逻辑，不调 AI，所以不消耗额度，可以作为额度不足时的兜底出口
 */
const { getIcon } = require('../../styles/icons');
const app = getApp();

/** 词库：拼音 → 汉字（同步小学低年级常见字） */
const BANK = [
  { pinyin: 'chūn', word: '春' },
  { pinyin: 'xià', word: '夏' },
  { pinyin: 'qiū', word: '秋' },
  { pinyin: 'dōng', word: '冬' },
  { pinyin: 'shān', word: '山' },
  { pinyin: 'shuǐ', word: '水' },
  { pinyin: 'huā', word: '花' },
  { pinyin: 'cǎo', word: '草' },
  { pinyin: 'yún', word: '云' },
  { pinyin: 'yuè', word: '月' },
];

const ROUND = 5;

Page({
  data: {
    theme: 'light',
    /** 游戏状态：ready | playing | over */
    stage: 'ready',
    /** 本局题目 */
    items: [],
    /** 当前索引 */
    index: 0,
    /** 当前题目 */
    current: null,
    /** 打乱后的选项 */
    options: [],
    /** 选中项 */
    picked: '',
    /** 是否已判定 */
    judged: false,
    correct: false,
    /** 统计 */
    score: 0,
    combo: 0,
    bestCombo: 0,
    iconStar: '',
  },

  onLoad() {
    this.setData({
      theme: app.globalData.theme || 'light',
      iconStar: getIcon('star', '#FFC857', 28),
    });
  },

  onThemeChanged(theme) {
    this.setData({ theme });
  },

  /** 洗牌 */
  shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  /** 开始游戏 */
  onStart() {
    const items = this.shuffle(BANK).slice(0, ROUND);
    this.setData({
      stage: 'playing',
      items,
      index: 0,
      score: 0,
      combo: 0,
      bestCombo: 0,
    });
    this.showQuestion(0);
  },

  showQuestion(index) {
    const current = this.data.items[index];
    if (!current) return;

    // 干扰项从同一题库里取，避免出现明显不同的类别
    const others = BANK.filter((b) => b.word !== current.word);
    const wrong = this.shuffle(others).slice(0, 2);
    const options = this.shuffle([current, ...wrong]);

    this.setData({ index, current, options, picked: '', judged: false, correct: false });
  },

  /** 选择答案 */
  onPick(e) {
    if (this.data.judged) return;

    const word = e.currentTarget.dataset.word;
    const correct = word === this.data.current.word;
    const score = correct ? this.data.score + 10 : this.data.score;
    const combo = correct ? this.data.combo + 1 : 0;
    const bestCombo = Math.max(this.data.bestCombo, combo);

    this.setData({ picked: word, judged: true, correct, score, combo, bestCombo });

    // 答对给一点轻反馈，答错直接进下一题（不惩罚，避免挫败）
    if (correct) {
      wx.vibrateShort && wx.vibrateShort({ type: 'light' });
    }

    setTimeout(() => this.next(), correct ? 500 : 1200);
  },

  next() {
    const { index, items } = this.data;
    if (index + 1 >= items.length) {
      this.setData({ stage: 'over' });
      return;
    }
    this.showQuestion(index + 1);
  },

  /** 再来一局 */
  onRestart() {
    this.onStart();
  },

  /** 回到计划页 */
  onBackToPlan() {
    wx.switchTab({ url: '/pages/plan/plan' });
  },

  /** 退出游戏 */
  onExit() {
    wx.navigateBack({
      fail: () => wx.switchTab({ url: '/pages/plan/plan' }),
    });
  },
});
