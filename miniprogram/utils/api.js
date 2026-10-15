/**
 * API 层 —— 所有接口集中在此，页面不直接拼 URL
 *
 * 约定：
 * - 页面只调这里的方法，URL 与参数拼装都收在这一层
 * - 需要在错误时特殊处理的，通过第三个参数透传 opts
 */
const { http } = require('./request');

module.exports = {
  // ============ 用户 ============
  getProfile: () => http.get('/user/profile'),
  updateProfile: (data) => http.post('/user/profile', data),
  getInviteCode: () => http.get('/family/qrcode'),
  bindFamily: (inviteCode) => http.post('/family/bind', { inviteCode }),
  listChildren: () => http.get('/family/children'),

  // ============ 教材 ============
  listTextbook: (params) => http.get('/textbook/list', params),
  listLesson: (textbookId) => http.get(`/textbook/${textbookId}/lessons`),
  selectTextbook: (data) => http.post('/textbook/select', data),
  uploadCustomTextbook: (data) => http.post('/textbook/custom', data, { loading: true }),
  /** 课文详情（含练习题，不含答案） */
  getLesson: (lessonId) => http.get(`/lesson/${lessonId}`),
  /** 提交练习答案并判分 */
  submitLesson: (lessonId, answers) => http.post(`/lesson/${lessonId}/submit`, { answers }),

  // ============ 作业批改 ============
  /** 提交批改（额度扣减在服务端完成） */
  analyzeHomework: (data) => http.post('/homework/analyze', data, { loading: true }),
  /** 查询批改进度（轮询，不需要 loading 也不要自动跳额度页） */
  getHomeworkStatus: (id) => http.get(`/homework/${id}/status`, {}, { handleQuota: false }),
  /** 批改报告 */
  getHomeworkReport: (id) => http.get(`/homework/${id}/report`, {}, { loading: true }),
  /** 历史作业 */
  listHomework: (params) => http.get('/homework/list', params),
  /** 上传单张图片，返回可访问 URL（可能被 request 层拦截，故传 handleQuota:false） */
  uploadImage: (filePath) => require('./image').uploadImage(filePath),

  // ============ 错题 ============
  listMistake: (params) => http.get('/mistake/list', params),
  getMistake: (id) => http.get(`/mistake/${id}`),
  retryMistake: (id, answer) => http.post(`/mistake/${id}/retry`, { answer }),
  getMistakeStats: () => http.get('/mistake/stats'),

  // ============ 学习计划 ============
  getTodayPlan: () => http.get('/plan/today'),
  getWeekPlan: () => http.get('/plan/week'),
  getParentOverview: (uid) => http.get(`/parent/overview?uid=${uid}`),
  getParentReport: (uid) => http.get(`/parent/report?uid=${uid}`),
  togglePlanTask: (id, done = true) => http.post(`/plan/task/${id}/toggle`, { done }),

  // ============ 额度 ============
  getQuotaBalance: () => http.get('/quota/balance'),
  getQuotaPacks: () => http.get('/quota/packs'),
  getQuotaLogs: (params) => http.get('/quota/logs', params),
  createOrder: (packId) => http.post('/order/create', { packId }, { loading: true }),
};
