/**
 * 练习出题质量自测（不依赖 MySQL / Redis / 真实 AI）
 *
 * 背景：AI 出的数学题出现过"60-18=38"这种算式与结论自相矛盾的答案，
 * 用户答对（42）反被判错。修复方案是给 generatePractice 加第二道工序：
 *   出题（教研老师）→ 独立复核（阅卷组长，温度 0，只信自己的计算）
 * 本脚本用假 provider 脚本化两个环节的返回，锁住这些只有真跑才炸的路径：
 *
 *   1. 复核发现答案错误且能对上选项 → 替换答案与解析
 *   2. 复核判定题目本身有问题（answer 为 null）→ 丢弃该题
 *   3. 复核给的答案对不上 options → 宁可丢弃，不能入库判错
 *   4. 复核接口本身挂掉 → 降级用首次生成结果，不能让用户白扣额度
 *   5. 复核确认无误 → 原样保留
 *   6. 数学题出题温度必须是 0.2，复核温度必须是 0
 *
 * 用法：node scripts/selftest-practice-quality.js
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');

/** 缺依赖时兜底（CI lint 阶段不装 node_modules） */
(() => {
  const canResolve = (name) => {
    try {
      require.resolve(name);
      return true;
    } catch {
      return false;
    }
  };
  const noop = () => {};
  const fakeLogger = {
    info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop,
    child: () => fakeLogger,
  };
  const stubs = {};
  if (!canResolve('dotenv')) stubs.dotenv = { config: noop };
  if (!canResolve('pino')) stubs.pino = () => fakeLogger;

  if (Object.keys(stubs).length) {
    const origLoad = Module._load;
    Module._load = function (request, ...rest) {
      if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
      return origLoad.call(this, request, ...rest);
    };
  }
})();

const SRC = path.resolve(__dirname, '../src');

/** 把假模块塞进 require 缓存，必须在 require 业务代码之前 */
function stub(absPath, exports) {
  const resolved = require.resolve(absPath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
    children: [],
    paths: [],
  };
}

/** ── 假配置（ai/index.js 只用到这几个字段） ─────────────── */
stub(path.resolve(SRC, 'config'), {
  ai: { provider: 'qwen', textModel: 'fake-text', visionModel: 'fake-vision' },
  upload: { publicBaseUrl: 'https://example.com' },
  log: { level: 'info', pretty: false },
});

/** ── 假 provider：按提示词区分「出题」和「复核」两次调用 ── */
const calls = [];

class FakeProvider {
  constructor() {
    this.name = 'qwen';
  }

  async chatText(prompt, opts = {}) {
    const isVerify = prompt.includes('阅卷组长');
    calls.push({ kind: isVerify ? 'verify' : 'generate', temperature: opts.temperature });
    if (isVerify) {
      if (state.verifyFail) throw new Error('复核服务超时');
      state.verifySeq += 1;
      if (Array.isArray(state.verifyQueue) && state.verifyQueue.length) {
        const idx = Math.min(state.verifySeq - 1, state.verifyQueue.length - 1);
        return JSON.stringify(state.verifyQueue[idx]);
      }
      return JSON.stringify(state.verifyResult);
    }
    state.genSeq += 1;
    if (state.generateFail) throw new Error(state.generateFail);
    // 指定「第 N 批出题失败」，用来自测补题逻辑
    if (state.generateFailAt && state.genSeq === state.generateFailAt) {
      throw new Error('这一批请求超时');
    }
    const result = state.generateFactory
      ? state.generateFactory(state.genSeq)
      : state.generateResult;
    return JSON.stringify(result);
  }

  async chatVision() {
    throw new Error('本自测不涉及视觉调用');
  }
}

stub(path.resolve(SRC, 'ai/provider/qwen'), FakeProvider);
// 这两个 provider 依赖 axios（本机/CI 未装 node_modules），与本次自测无关，一并桩掉
class UnusedProvider {
  constructor() { this.name = 'unused'; }
  async chatText() { throw new Error('本自测不应走到该 provider'); }
  async chatVision() { throw new Error('本自测不应走到该 provider'); }
}
stub(path.resolve(SRC, 'ai/provider/hunyuan'), UnusedProvider);
stub(path.resolve(SRC, 'ai/provider/openaiCompat'), UnusedProvider);

const state = {
  generateResult: [],
  verifyResult: [],
  /** 按调用顺序消费的复核结果队列（用完后沿用最后一项） */
  verifyQueue: null,
  /** (seq) => 题目数组：用于生成带唯一题干的批次，验证补题去重 */
  generateFactory: null,
  generateFail: null,
  /** 指定第几次出题调用失败，用于自测补题 */
  generateFailAt: null,
  verifyFail: null,
  genSeq: 0,
  verifySeq: 0,
};

const ai = require(path.resolve(SRC, 'ai/index.js'));

const MATH_Q = {
  stem: '小红做加法时把24看成了42，结果得数是60，正确的得数应该是多少？',
  options: ['38', '42', '46', '60'],
  answer: '38', // 模型首答就是错的
  analysis: '她多加了42-24=18，所以正确结果是60-18=38。',
  difficulty: 2,
};

const GOOD_Q = {
  stem: '比35多12的数是多少？',
  options: ['23', '47', '45', '37'],
  answer: '47',
  analysis: '35+12=47。',
  difficulty: 1,
};

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function reset() {
  calls.length = 0;
  state.generateResult = [];
  state.verifyResult = [];
  state.verifyQueue = null;
  state.generateFactory = null;
  state.generateFail = null;
  state.generateFailAt = null;
  state.verifyFail = null;
  state.genSeq = 0;
  state.verifySeq = 0;
}

/** 造一批题干唯一、答案全部正确的题，用于验证补题与去重 */
const makeBatch = (seq, size = 5) =>
  Array.from({ length: size }, (_, i) => ({
    stem: `第${seq}批第${i}题：比35多12的数是多少？`,
    options: ['23', '47', '45', '37'],
    answer: '47',
    analysis: '35+12=47。',
    difficulty: 1,
  }));

/** ── 用例 ───────────────────────────────────────────────── */

test('复核发现答案错误且能对上选项：替换答案与解析', async () => {
  reset();
  state.generateResult = [MATH_Q];
  state.verifyResult = [
    {
      index: 0,
      ok: false,
      answer: '42',
      analysis: '另一个加数是60-42=18，正确得数是24+18=42。',
    },
  ];

  const out = await ai.generatePractice({ subject: 2, grade: 1, title: '加法', count: 4 });

  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].answer, '42', '必须用复核的正确答案');
  assert.ok(out[0].analysis.includes('24+18=42'), '解析应被复核版重写');
  assert.strictEqual(out[0].type, 1);
});

test('复核判定题目本身有问题：丢弃该题', async () => {
  reset();
  state.generateResult = [MATH_Q, GOOD_Q];
  state.verifyResult = [
    { index: 0, ok: false, answer: null, analysis: null },
    { index: 1, ok: true, answer: '47', analysis: '' },
  ];

  const out = await ai.generatePractice({ subject: 2, grade: 1, title: '加法', count: 4 });

  assert.strictEqual(out.length, 1, '问题题目不应入库');
  assert.strictEqual(out[0].stem, GOOD_Q.stem);
});

test('全部题目被复核丢弃：报错而不是返回空数组', async () => {
  reset();
  state.generateResult = [MATH_Q];
  state.verifyResult = [{ index: 0, ok: false, answer: null, analysis: null }];

  await assert.rejects(
    () => ai.generatePractice({ subject: 2, grade: 1, title: '加法', count: 4 }),
    /复核后没有可用题目/
  );
});

test('复核答案对不上 options：宁可丢弃，不能入库判错', async () => {
  reset();
  state.generateResult = [MATH_Q, GOOD_Q];
  state.verifyResult = [
    { index: 0, ok: false, answer: '40', analysis: '乱说的' },
    { index: 1, ok: true, answer: '47', analysis: '' },
  ];

  const out = await ai.generatePractice({ subject: 2, grade: 1, title: '加法', count: 4 });

  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].stem, GOOD_Q.stem);
});

test('复核接口挂掉：降级用首次生成结果，不报错', async () => {
  reset();
  state.generateResult = [MATH_Q];
  state.verifyFail = true;

  const out = await ai.generatePractice({ subject: 2, grade: 1, title: '加法', count: 4 });

  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].answer, '38', '降级时保留原结果');
});

test('复核确认无误：原样保留', async () => {
  reset();
  state.generateResult = [MATH_Q];
  state.verifyResult = [{ index: 0, ok: true, answer: '38', analysis: MATH_Q.analysis }];

  const out = await ai.generatePractice({ subject: 2, grade: 1, title: '加法', count: 4 });

  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].answer, '38');
  assert.strictEqual(out[0].analysis, MATH_Q.analysis);
});

test('复核漏掉某题：该题保守保留原样', async () => {
  reset();
  const q2 = { stem: '题二', options: ['甲', '乙', '丙', '丁'], answer: '甲', analysis: '', difficulty: 1 };
  state.generateResult = [MATH_Q, q2];
  state.verifyResult = [{ index: 1, ok: true, answer: '甲', analysis: '' }];

  const out = await ai.generatePractice({ subject: 2, grade: 1, title: '加法', count: 4 });

  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].answer, '38');
  assert.strictEqual(out[1].stem, '题二');
});

test('调用序与温度：先出题后复核；数学出题 0.2、复核 0', async () => {
  reset();
  state.generateResult = [MATH_Q];
  state.verifyResult = [{ index: 0, ok: true, answer: '38', analysis: '' }];

  // 只要 1 道：一轮就够，正好也验证「够数就不再补题」
  await ai.generatePractice({ subject: 2, grade: 1, title: '加法', count: 1 });

  assert.strictEqual(calls.length, 2, '应恰好两次调用：出题 + 复核');
  assert.strictEqual(calls[0].kind, 'generate');
  assert.strictEqual(calls[1].kind, 'verify');
  assert.strictEqual(calls[0].temperature, 0.2, '数学出题必须低温');
  assert.strictEqual(calls[1].temperature, 0, '复核必须零温度');
});

test('非数学学科：出题温度 0.6', async () => {
  reset();
  state.generateResult = [
    { stem: '《小小的船》的作者是谁？', options: ['叶圣陶', '李白', '安徒生', '冰心'], answer: '叶圣陶', analysis: '', difficulty: 1 },
  ];
  state.verifyResult = [{ index: 0, ok: true, answer: '叶圣陶', analysis: '' }];

  await ai.generatePractice({ subject: 1, grade: 1, title: '小小的船', count: 4 });

  assert.strictEqual(calls[0].temperature, 0.6);
});

test('要 10 道题：首轮拆成 2 批并行，每批各自复核', async () => {
  reset();
  state.generateResult = [MATH_Q, GOOD_Q];
  state.verifyResult = [
    { index: 0, ok: true, answer: '38', analysis: '' },
    { index: 1, ok: true, answer: '47', analysis: '' },
  ];

  const out = await ai.generatePractice({ subject: 2, grade: 1, title: '加法', count: 10 });

  const firstRound = calls.slice(0, 4);
  assert.strictEqual(firstRound.filter((c) => c.kind === 'generate').length, 2, '首轮 2 批');
  assert.strictEqual(firstRound.filter((c) => c.kind === 'verify').length, 2, '每批各自复核');
  assert.strictEqual(out.length, 2, '两批题干相同，去重后只剩 2 道');
});

test('某批超时导致题量不足：自动补一批，补到目标题量', async () => {
  reset();
  state.generateFactory = (seq) => makeBatch(seq);
  state.verifyResult = []; // 复核未给条目 → 保守保留
  state.generateFailAt = 2; // 第二批（并行里的第二道调用）超时

  const out = await ai.generatePractice({ subject: 2, grade: 1, title: '加法', count: 10 });

  assert.strictEqual(out.length, 10, '少一批必须补回来，不能只交 5 道');
  assert.strictEqual(
    calls.filter((c) => c.kind === 'generate').length,
    3,
    '首轮 2 批 + 补 1 批'
  );
  const stems = new Set(out.map((q) => q.stem));
  assert.strictEqual(stems.size, 10, '补出来的题不能和已有题重复');
});

test('复核丢弃题目导致题量不足：自动补题到目标', async () => {
  reset();
  state.generateFactory = (seq) => makeBatch(seq);
  // 第一次复核丢掉 2 道，第二次复核没有返回条目（保守全保留）
  state.verifyQueue = [
    [
      { index: 0, ok: true, answer: '47', analysis: '' },
      { index: 1, ok: true, answer: '47', analysis: '' },
      { index: 2, ok: true, answer: '47', analysis: '' },
      { index: 3, ok: false, answer: null, analysis: null },
      { index: 4, ok: false, answer: null, analysis: null },
    ],
    [],
  ];

  const out = await ai.generatePractice({ subject: 2, grade: 1, title: '加法', count: 5 });

  assert.strictEqual(out.length, 5, '复核丢题后要补到用户选的题量');
  assert.strictEqual(calls.filter((c) => c.kind === 'generate').length, 2);
});

test('题量收敛：传 100 也只出到 20 道的批次上限', async () => {
  reset();
  state.generateResult = [GOOD_Q];
  state.verifyResult = [{ index: 0, ok: true, answer: '47', analysis: '' }];

  await ai.generatePractice({ subject: 2, grade: 1, title: '加法', count: 100 });

  assert.strictEqual(calls.slice(0, 8).filter((c) => c.kind === 'generate').length, 4, '首轮 20 道 = 4 批');
});

test('单批失败不影响其它批：返回已成功的部分', async () => {
  reset();
  // 让第一批（第一次出题调用）失败，后续批正常
  let n = 0;
  const realChatText = FakeProvider.prototype.chatText;
  FakeProvider.prototype.chatText = async function (prompt, opts) {
    if (!prompt.includes('阅卷组长') && n++ === 0) {
      calls.push({ kind: 'generate', temperature: opts && opts.temperature });
      throw new Error('第一批超时');
    }
    return realChatText.call(this, prompt, opts);
  };

  try {
    state.generateResult = [GOOD_Q];
    state.verifyResult = [{ index: 0, ok: true, answer: '47', analysis: '' }];
    const out = await ai.generatePractice({ subject: 2, grade: 1, title: '加法', count: 10 });
    assert.ok(out.length >= 1, '一批失败不应拖垮整套');
  } finally {
    FakeProvider.prototype.chatText = realChatText;
  }
});

/** ── 执行 ───────────────────────────────────────────────── */
(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`✓ ${t.name}`);
    } catch (e) {
      failed += 1;
      console.log(`✗ ${t.name}`);
      console.log(`  ${e.message}`);
    }
  }

  if (failed) {
    console.error(`\n出题质量自测失败：${failed}/${tests.length}`);
    process.exit(1);
  }
  console.log(`\n出题质量自测通过（${tests.length} 项）`);
})();
