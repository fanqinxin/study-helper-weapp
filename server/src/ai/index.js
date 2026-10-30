/**
 * AI 批改服务层 —— 对外统一入口
 *
 * 核心设计：两步走
 *   第一步 识别：图片 → 结构化题目（视觉模型）
 *   第二步 判题：题目 + 课文上下文 → 对错与解析（文本模型）
 *
 * 为什么不一步到位：
 *   直接让多模态模型"看图判对错"，手写体识别误差会直接传导成判错，
 *   拆开后识别可重试、判题可用更便宜的文本模型，准确率与成本都更优。
 *
 * 业务代码只需调用 gradeHomework()，不感知具体模型。
 */
const config = require('../config');
const logger = require('../utils/logger');
const BaseProvider = require('./provider/base');
const QwenProvider = require('./provider/qwen');
const HunyuanProvider = require('./provider/hunyuan');
const OpenAICompatProvider = require('./provider/openaiCompat');

const PROVIDERS = {
  qwen: QwenProvider,
  hunyuan: HunyuanProvider,
  openai: OpenAICompatProvider,
};

/** 学科名称映射 */
const SUBJECT_NAME = { 1: '语文', 2: '数学', 3: '英语' };

/**
 * 把库里的相对图片路径补全成公网绝对 URL。
 *
 * 背景：upload 接口返回 /static/uploads/...，小程序原样存库、原样传回。
 * 视觉模型是百炼服务器**回源拉图**，只认公网绝对地址，
 * 传相对路径会报 InvalidParameter: The provided URL does not appear to be valid。
 * 数据库仍存相对路径（换域名/上 CDN 不用迁移数据），只在 AI 边界转换。
 */
function toAbsoluteUrls(imageUrls) {
  const base = config.upload.publicBaseUrl;
  return (Array.isArray(imageUrls) ? imageUrls : [imageUrls]).map((url) => {
    if (/^(https?:\/\/|data:image\/)/.test(url)) return url;
    if (!base) {
      throw new Error('未配置 PUBLIC_BASE_URL，无法把相对图片路径交给 AI 识别');
    }
    return url.startsWith('/') ? `${base}${url}` : `${base}/${url}`;
  });
}

/** 单例 provider */
let providerInstance = null;

function getProvider() {
  if (providerInstance) return providerInstance;
  const Cls = PROVIDERS[config.ai.provider] || OpenAICompatProvider;
  providerInstance = new Cls(config.ai);
  logger.info({ provider: providerInstance.name, vision: config.ai.visionModel, text: config.ai.textModel }, 'AI Provider 已初始化');
  return providerInstance;
}

// ============================================================
// 第一步：识别
// ============================================================

function buildRecognizePrompt(subject, lessonTitle) {
  const subjectName = SUBJECT_NAME[subject] || '语文';
  const ctx = lessonTitle ? `这是${subjectName}作业，对应课文《${lessonTitle}》。` : '';
  return `${ctx}请识别图片中学生的${subjectName}作业。

要求：
1. 逐题提取，按题号顺序输出
2. student_ans 填写学生手写的答案原样（看不清填 null，不要猜测）
3. 只输出 JSON 数组，不要任何解释文字、不要 markdown 代码块

输出格式：
[
  { "seq": 1, "stem": "题干完整内容", "student_ans": "学生答案" }
]`;
}

/**
 * 识别作业图片 → 结构化题目数组
 * @returns {Promise<Array<{seq:number, stem:string, student_ans:string|null}>>}
 */
async function recognize(imageUrls, { subject, lessonTitle } = {}) {
  const provider = getProvider();
  const prompt = buildRecognizePrompt(subject, lessonTitle);

  const raw = await provider.chatVision(toAbsoluteUrls(imageUrls), prompt);
  const parsed = BaseProvider.extractJson(raw);

  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error('识别结果无法解析为题目数组');
  }

  // 规范化：补齐 seq、清理空值
  return parsed
    .filter((q) => q && (q.stem || q.student_ans))
    .map((q, i) => ({
      seq: Number(q.seq) || i + 1,
      stem: String(q.stem || '').trim(),
      student_ans: q.student_ans === null || q.student_ans === undefined
        ? null
        : String(q.student_ans).trim(),
    }));
}

// ============================================================
// 第二步：判题
// ============================================================

function buildJudgePrompt(questions, { subject, lessonTitle, knowledgePoints } = {}) {
  const subjectName = SUBJECT_NAME[subject] || '语文';
  const ctx = lessonTitle ? `本次作业对应课文《${lessonTitle}》。` : '';
  const kp = knowledgePoints?.length ? `课文涉及知识点：${knowledgePoints.join('、')}。` : '';

  return `你是经验丰富的小学${subjectName}老师，正在批改学生作业。${ctx}${kp}

请逐题判断对错，并给出讲解。

批改要求：
1. 以小学${subjectName}课程标准为准，答案表述不同但意思正确的算对
2. 学生答案为 null（看不清或未作答）时，is_correct 填 null
3. analysis 用小学生能听懂的话讲解，控制在 60 字内
4. knowledge_point 填该题对应的知识点，如"拟人修辞""两位数乘法"
5. 只输出 JSON 数组，不要任何解释文字、不要 markdown 代码块

待批改题目：
${JSON.stringify(questions, null, 2)}

输出格式：
[
  { "seq": 1, "is_correct": true, "correct_ans": "标准答案", "analysis": "讲解", "knowledge_point": "知识点" }
]`;
}

/**
 * 判定题目对错
 * @returns {Promise<Array>} 逐题批改结果
 */
async function judge(questions, ctx = {}) {
  const provider = getProvider();
  const prompt = buildJudgePrompt(questions, ctx);

  const raw = await provider.chatText(prompt, {
    system: '你是一位耐心、专业的小学老师，批改准确且讲解通俗易懂。',
    temperature: 0.2,
  });
  const parsed = BaseProvider.extractJson(raw);

  if (!Array.isArray(parsed)) {
    throw new Error('判题结果无法解析为数组');
  }

  return parsed.map((r, i) => ({
    seq: Number(r.seq) || i + 1,
    is_correct: r.is_correct === true ? 1 : r.is_correct === false ? 0 : null,
    correct_ans: r.correct_ans ? String(r.correct_ans).trim() : null,
    analysis: r.analysis ? String(r.analysis).trim() : null,
    knowledge_point: r.knowledge_point ? String(r.knowledge_point).trim() : null,
  }));
}

// ============================================================
// 编排：完整批改流程
// ============================================================

/**
 * 批改一份作业（识别 + 判题 + 汇总）
 *
 * 注意：本函数只负责"算"，不负责额度扣减与任务状态。
 * 额度与状态由 services/homework.js 编排，职责分离。
 *
 * @returns {Promise<{items:Array, total:number, correct:number, score:number, raw:object}>}
 */
async function gradeHomework(imageUrls, ctx = {}) {
  const t0 = Date.now();

  // 第一步：识别
  const questions = await recognize(imageUrls, ctx);
  logger.info({ count: questions.length, cost: Date.now() - t0 }, '题目识别完成');

  if (!questions.length) {
    throw new Error('未识别到任何题目，请确认照片清晰、光线充足');
  }

  // 第二步：判题
  const results = await judge(questions, ctx);

  // 合并识别与判题结果
  const bySeq = new Map(results.map((r) => [r.seq, r]));
  const items = questions.map((q) => {
    const r = bySeq.get(q.seq) || {};
    return {
      seq: q.seq,
      stem: q.stem,
      student_ans: q.student_ans,
      correct_ans: r.correct_ans || null,
      is_correct: r.is_correct ?? null,
      analysis: r.analysis || null,
      knowledge_point: r.knowledge_point || null,
    };
  });

  // 汇总：只统计已判定的题目
  const judged = items.filter((i) => i.is_correct !== null);
  const correct = judged.filter((i) => i.is_correct === 1).length;
  const score = judged.length ? Math.round((correct / judged.length) * 100) : 0;

  const cost = Date.now() - t0;
  logger.info({ total: items.length, judged: judged.length, correct, score, cost }, '批改完成');

  return {
    items,
    total: judged.length,
    correct,
    score,
    raw: { questions, results }, // 保留原始输出，便于回溯调优
  };
}

/**
 * 识别课本目录 → 课文结构（用于自定义教材）
 */
async function recognizeCatalog(imageUrls) {
  const provider = getProvider();
  const prompt = `请识别图片中的课本目录页，提取课文结构。

要求：只输出 JSON 数组，不要解释、不要 markdown 代码块。

输出格式：
[
  { "unit": "第一单元", "seq": 1, "title": "课文标题" }
]`;

  const raw = await provider.chatVision(toAbsoluteUrls(imageUrls), prompt);
  const parsed = BaseProvider.extractJson(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('目录识别失败，请重新拍摄');
  }
  return parsed
    .filter((l) => l && l.title)
    .map((l, i) => ({
      unit: l.unit ? String(l.unit).trim() : null,
      seq: Number(l.seq) || i + 1,
      title: String(l.title).trim(),
    }));
}

module.exports = {
  getProvider,
  recognize,
  judge,
  gradeHomework,
  recognizeCatalog,
  toAbsoluteUrls,
  SUBJECT_NAME,
};
