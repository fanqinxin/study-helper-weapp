/**
 * 常量与枚举 —— 与后端保持一致
 */

/** 业务错误码 */
const CODE = {
  OK: 0,
  BAD_REQUEST: 4000,
  UNAUTHORIZED: 4001,
  NOT_FOUND: 4040,
  QUOTA_INSUFFICIENT: 4010,
  RATE_LIMITED: 4029,
  SERVER_ERROR: 5000,
  AI_FAILED: 5001,
};

/** 学科 */
const SUBJECT = { CHINESE: 1, MATH: 2, ENGLISH: 3 };
const SUBJECT_NAME = { 1: '语文', 2: '数学', 3: '英语' };

/** 作业状态 */
const HW_STATUS = {
  PENDING: 0,
  PROCESSING: 1,
  DONE: 2,
  FAILED: 3,
};

/** 额度流水来源 */
const QUOTA_SOURCE = {
  1: '周期发放',
  2: '购买到账',
  3: '批改消耗',
  4: '失败退还',
  5: '后台调整',
};

/** 学习计划任务类型 */
const PLAN_TYPE = { 1: '课文练习', 2: '错题巩固', 3: '作业批改', 4: '小游戏' };

/** 本地存储 key */
const STORAGE_KEY = {
  TOKEN: 'sh_token',
  USER: 'sh_user',
  THEME: 'sh_theme',
  TEXTBOOK: 'sh_textbook',
};

module.exports = {
  CODE,
  SUBJECT,
  SUBJECT_NAME,
  HW_STATUS,
  QUOTA_SOURCE,
  PLAN_TYPE,
  STORAGE_KEY,
};
