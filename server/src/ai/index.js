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
5. 判题前先自己完整算一遍每道题，确保 correct_ans 正确；analysis 中出现的每个算式都要复算，禁止口算失误
6. 只输出 JSON 数组，不要任何解释文字、不要 markdown 代码块

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
async function recognizeCatalog(imageUrls) {  const provider = getProvider();
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

// ============================================================
// 第三步（可选）：按课文出同步练习
// ============================================================

function buildPracticePrompt({ subject, grade, unit, title, count }) {
  const subjectName = SUBJECT_NAME[subject] || '语文';
  const unitText = unit ? `所属单元：${unit}。` : '';
  const mathRule = Number(subject) === 2
    ? `7. 这是数学题，所有选项和 answer 必须是具体数值（可带单位）或算式结果
8. 先在草稿上完整列出每题的解题步骤并验算，确认无误后再输出；analysis 中出现的每个算式都要复算，计算结果必须与 answer 一致，禁止口算失误
`
    : '7. 出每道题前先自己完整做一遍并验算，确认答案准确无误后再写入 answer\n';
  return `你是小学${subjectName}教研老师，请围绕${grade}年级课文《${title}》出一套同步练习。${unitText}

要求：
1. 共 ${count} 道题，全部为单选题，每题 4 个选项
2. 考查课文主题、常见字词与理解，符合${grade}年级水平，不要超纲
3. answer 必须是 options 中某一项的原文，不能写"A""B"或改写
4. analysis 用小学生能听懂的话讲清为什么，60 字内
5. difficulty：1=简单 2=中等 3=稍难
6. 只输出 JSON 数组，不要解释文字、不要 markdown 代码块
${mathRule}
输出格式：
[
  { "stem": "题干", "options": ["选项一", "选项二", "选项三", "选项四"], "answer": "正确选项原文", "analysis": "讲解", "difficulty": 2 }
]`;
}

/**
 * 复核提示词：让另一个角色独立解题、只信自己的计算。
 *
 * 为什么单独一道工序：出题与验证交给同一个上下文，模型倾向于"我觉得我算的没错"，
 * 把原答案照抄回来。换一个没有历史包袱的调用、并明确要求独立解答，
 * 才能把 60-18 写成 38 这类算式与结论自相矛盾的低级错误拦下来。
 */
function buildVerifyPrompt(questions, { subject, grade, title } = {}) {
  const subjectName = SUBJECT_NAME[subject] || '语文';
  const brief = title ? `（${grade ? `${grade}年级` : ''}${subjectName}·课文《${title}》同步练习）` : '';
  return `你是小学${subjectName}阅卷组长，负责复核一组刚出的同步练习题${brief}。
请**独立解答**下面每道题——不要参考题目附带的 answer 和 analysis，先算出你自己的答案，再判断原答案是否正确。

复核要求：
1. 每道题先完整列出你的解题步骤并验算，得到你自己的答案
2. 你的答案与原 answer 一致 → ok 填 true
3. 你的答案与原 answer 不一致 → ok 填 false，answer 改为你的答案（必须与该题 options 中某一项原文完全一致），analysis 用你的正确讲解重写
4. 题目本身有问题（题干条件矛盾、无正确选项、明显超纲）→ ok 填 false，answer 填 null
5. analysis 中出现的每个算式都要复算，结果必须与 answer 一致，禁止口算失误
6. 只输出 JSON 数组，不要解释文字、不要 markdown 代码块

待复核题目（index 对应数组下标）：
${JSON.stringify(questions.map((q, i) => ({ index: i, stem: q.stem, options: q.options, answer: q.answer })), null, 2)}

输出格式：
[
  { "index": 0, "ok": true, "answer": "正确选项原文", "analysis": "讲解" }
]`;
}

/**
 * 独立复核练习题答案。
 *
 * 复核调用失败时**降级而非报错**：复核是质量加固，不是必要条件，
 * 因为复核网络抖动把整套题退掉退款，比带着小概率错题上线更伤体验。
 * @returns {Promise<Array>} 复核后的题目数组（可能比传入的少——坏题被丢弃）
 */
async function verifyPractice(questions, ctx = {}) {
  const provider = getProvider();
  const prompt = buildVerifyPrompt(questions, ctx);

  const raw = await provider.chatText(prompt, {
    system: '你是极严谨的小学阅卷组长，复核时只相信自己的独立计算，绝不迁就原答案。',
    temperature: 0,
  });

  const parsed = BaseProvider.extractJson(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('复核结果无法解析为数组');
  }

  const byIndex = new Map();
  for (const r of parsed) {
    const i = Number(r && r.index);
    if (Number.isInteger(i)) byIndex.set(i, r);
  }

  return questions
    .map((q, i) => {
      const v = byIndex.get(i);
      if (!v) return q; // 复核漏了这题：保守保留原样
      const vAns = v.answer === null || v.answer === undefined ? null : String(v.answer).trim();
      if (v.ok === false) {
        if (!vAns) return null; // 题目本身有问题 → 丢弃
        const hit = q.options.find((o) => o === vAns);
        if (!hit) return null; // 复核给的答案对不上选项 → 宁可不出这道题
        return {
          ...q,
          answer: hit,
          analysis: v.analysis ? String(v.analysis).trim() : q.analysis,
        };
      }
      return q;
    })
    .filter(Boolean);
}

/**
 * 按课文生成同步练习（文本模型）
 *
 * 只用于「没有题库的课文」，比如用户拍目录生成的自定义教材。
 * 两道工序：
 *   1. 出题：answer 必须能在 options 里原样找到，否则判分永远对不上
 *   2. 复核：独立解题再校一遍答案，答案错误的替换、题目有问题的丢弃
 *      数学题出题温度降到 0.2，复核一律温度 0
 */
async function generatePractice({ subject, grade, unit, title, count = 4 }) {
  const provider = getProvider();
  const isMath = Number(subject) === 2;
  const prompt = buildPracticePrompt({ subject, grade, unit, title, count });

  const raw = await provider.chatText(prompt, {
    system: '你是严谨的小学教研老师，只输出 JSON 数组，不编造超纲内容。',
    temperature: isMath ? 0.2 : 0.6,
  });

  const parsed = BaseProvider.extractJson(raw);
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error('生成结果无法解析为题目数组');
  }

  const cleaned = parsed
    .map((q) => {
      const options = Array.isArray(q && q.options)
        ? q.options.map((o) => String(o == null ? '' : o).trim()).filter(Boolean)
        : [];
      const answer = String((q && q.answer) || '').trim();
      const stem = String((q && q.stem) || '').trim();
      if (!stem || options.length < 2) return null;
      // 答案必须与某个选项完全一致，否则判分永远对不上
      const hit = options.find((o) => o === answer);
      if (!hit) return null;
      return {
        type: 1,
        stem,
        options,
        answer: hit,
        analysis: q.analysis ? String(q.analysis).trim() : null,
        difficulty: Math.min(3, Math.max(1, Number(q.difficulty) || 2)),
      };
    })
    .filter(Boolean)
    .slice(0, count);

  if (!cleaned.length) {
    throw new Error('模型没有给出可用的题目，请稍后重试');
  }

  // 第二道工序：独立复核。坏答案替换、坏题丢弃；复核调用本身失败则降级用首次结果
  let verified = cleaned;
  try {
    verified = await verifyPractice(cleaned, { subject, grade, title });
    const dropped = cleaned.length - verified.length;
    if (dropped > 0) {
      logger.warn({ subject, title, dropped }, '练习复核丢弃了不合格题目');
    }
  } catch (e) {
    logger.warn({ err: e.message, subject, title }, '练习复核调用失败，降级使用首次生成结果');
  }

  const final = verified.slice(0, count);
  if (!final.length) {
    throw new Error('题目复核后没有可用题目，请稍后重试');
  }
  return final;
}

module.exports = {
  getProvider,
  recognize,
  judge,
  gradeHomework,
  recognizeCatalog,
  generatePractice,
  verifyPractice,
  toAbsoluteUrls,
  SUBJECT_NAME,
};
