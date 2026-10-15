/**
 * 家长报告详情
 * 对应设计稿 16
 *
 * Phase 4 说明：完整的周报聚合（时长/页数/环比/AI 点评）需要后端聚合接口，
 * 当前版本用孩子端现有接口在前端拼装：错题统计 + 作业列表 + 本周计划。
 * AI 教师点评先用本地规则生成占位文案，接入后端后替换。
 */
const api = require('../../utils/api');
const { SUBJECT_NAME } = require('../../utils/constants');
const { getIcon } = require('../../styles/icons');
const app = getApp();

const SUBJECT_ORDER = [1, 2, 3, 4];
const SUBJECT_BAR_COLOR = { 1: '#FFC857', 2: '#6BB6E0', 3: '#7DD3A0', 4: '#D6CDBB' };

Page({
  data: {
    theme: 'light',
    loading: true,
    /** 目标孩子 uid（家长可看任意已绑定孩子） */
    uid: 0,
    childName: '',
    weekNo: 0,
    /** 总评 */
    summary: {
      levelText: '',
      trendText: '',
      homeworkCount: 0,
      scoreRate: 0,
      mistakeCount: 0,
      planRate: 0,
    },
    /** 各科投入分布（用错题量反向反映投入，Phase 4 换真实时长） */
    subjects: [],
    /** AI 教师点评（占位规则文案） */
    comment: '',
    iconStar: '',
  },

  onLoad(query) {
    this.setData({
      theme: app.globalData.theme || 'light',
      uid: Number(query.uid) || 0,
      iconStar: getIcon('star', '#E0A32E', 48),
    });
    this.load();
  },

  onThemeChanged(theme) {
    this.setData({ theme });
  },

  async load() {
    try {
      // 家长专用报告接口：按孩子 uid 聚合，服务端校验绑定关系
      const res = await api.getParentReport(this.data.uid);
      const { summary, subjects: bySubject, weakPoints = [] } = res;
      const levelText = summary.levelText || '刚起步';

      // 各科分布：错题量越多说明该科占用精力越大（Phase 4 换真实学习时长）
      const subjectList = Array.isArray(bySubject) ? bySubject : [];
      const subjects = SUBJECT_ORDER
        .map((s) => subjectList.find((x) => Number(x.subject) === s))
        .filter((x) => x && x.count > 0)
        .map((x) => ({
          name: SUBJECT_NAME[Number(x.subject)] || '其他',
          count: Number(x.count),
          color: SUBJECT_BAR_COLOR[Number(x.subject)] || '#D6CDBB',
        }));
      const maxCount = subjects.reduce((m, s) => Math.max(m, s.count), 0);
      subjects.forEach((s) => {
        s.percent = maxCount ? Math.round((s.count / maxCount) * 100) : 0;
      });

      this.setData({
        loading: false,
        weekNo: this.getWeekNo(),
        summary: {
          levelText,
          trendText: summary.trendText || '',
          homeworkCount: summary.homeworkCount || 0,
          scoreRate: summary.scoreRate || 0,
          mistakeCount: summary.mistakeCount || 0,
          planRate: summary.planRate || 0,
        },
        subjects,
        comment: this.buildComment(levelText, weakPoints),
      });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  getWeekNo() {
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 1);
    const days = Math.floor((now - start) / (24 * 60 * 60 * 1000));
    return Math.ceil((days + start.getDay() + 1) / 7);
  },

  /** 本地规则生成 AI 点评占位文案（Phase 4 接后端 LLM 聚合） */
  buildComment(levelText, topPoints) {
    const weak = topPoints.length ? `「${topPoints[0].knowledgePoint}」` : '部分知识点';
    const parts = [];
    if (levelText === '表现优秀') {
      parts.push('这周整体正确率很稳，说明基础扎实。');
    } else if (levelText === '稳步前进') {
      parts.push('这周整体在进步，正确率处于健康区间。');
    } else {
      parts.push('这周错误率偏高，建议放慢节奏把基础吃透。');
    }
    if (topPoints.length) {
      parts.push(`${weak}出错较集中，周末可以针对这个点安排一次小练习。`);
    } else {
      parts.push('错题都已在巩固中，继续保持每天回顾的习惯。');
    }
    return parts.join('');
  },

  /** 生成巩固练习 → 跳到错题本 */
  onGoPractice() {
    wx.switchTab({ url: '/pages/mistake/list' });
  },

  /** 留言鼓励（Phase 4：家长留言板） */
  onEncourage() {
    wx.showModal({
      title: '留言鼓励',
      content: '给孩子留言的功能即将上线，先用一句"你真棒"顶上吧！',
      showCancel: false,
      confirmText: '好的',
    });
  },

  onShareAppMessage() {
    return {
      title: `第 ${this.data.weekNo} 周学习报告`,
      path: `/pages/parent/report?uid=${this.data.uid}`,
    };
  },
});
