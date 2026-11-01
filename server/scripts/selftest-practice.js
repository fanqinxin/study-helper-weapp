/**
 * 课后练习生成自测（不依赖 MySQL / Redis / 真实 AI）
 *
 * 为什么要这个脚本：
 *   自定义教材只有课文目录、没有题目，练习页会提示"这一课还没有练习题"。
 *   补救办法是按需让 AI 出一套题，而这段逻辑有几条「只有真跑才炸」的路径：
 *
 *   1. 扣费与入队的顺序：入队失败必须退款，否则用户白扣
 *   2. 连点两次只能扣一次，生成中的标记要挡住并发请求
 *   3. worker 重试前要清掉旧题目，否则同一课会堆出重复题
 *   4. 失败必须退款并清标记，否则用户永远停在"生成中"
 *
 * 用法：node scripts/selftest-practice.js
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

/** ── 假数据库 ───────────────────────────────────────────── */
const state = {
  lesson: null,
  textbook: null,
  questions: [],
  calls: [],
};

async function route(sql, params) {
  const s = sql.replace(/\s+/g, ' ').trim();
  state.calls.push(s);

  if (/^SELECT l\.id, l\.seq, l\.title/.test(s)) {
    const [lessonId, uid] = params;
    if (!state.lesson || state.lesson.id !== lessonId) return [];
    const tb = state.textbook;
    const owned = Number(tb.is_custom) === 0 || Number(tb.owner_uid) === Number(uid);
    if (!owned) return [];
    return [{
      ...state.lesson,
      textbookId: tb.id,
      subject: tb.subject,
      grade: tb.grade,
      textbookName: tb.name,
      isCustom: tb.is_custom,
    }];
  }
  if (/^SELECT COUNT\(\*\) AS cnt FROM question WHERE lesson_id = \?$/.test(s)) {
    return [{ cnt: state.questions.filter((q) => q.lesson_id === params[0]).length }];
  }
  if (/^DELETE FROM question WHERE lesson_id = \?$/.test(s)) {
    const before = state.questions.length;
    state.questions = state.questions.filter((q) => q.lesson_id !== params[0]);
    return { affectedRows: before - state.questions.length };
  }
  if (/^INSERT INTO question/.test(s)) {
    state.questions.push({
      lesson_id: params[0],
      type: params[1],
      stem: params[2],
      options: params[3],
      answer: params[4],
      analysis: params[5],
      difficulty: params[6],
    });
    return { insertId: state.questions.length, affectedRows: 1 };
  }
  throw new Error('假数据库未适配的 SQL：' + s);
}

const fakeDb = {
  pool: {},
  async query(sql, params) {
    return route(sql, params || []);
  },
  async transaction(fn) {
    return fn({ query: (sql, params) => route(sql, params || []) });
  },
  async getConnection() {
    throw new Error('练习服务不应直接取连接');
  },
  async ping() {
    return true;
  },
};

/** ── 假 AI ──────────────────────────────────────────────── */
const aiState = { calls: 0, result: [], fail: null, args: null };
const fakeAi = {
  async generatePractice(args) {
    aiState.calls += 1;
    aiState.args = args;
    if (aiState.fail) throw new Error(aiState.fail);
    return aiState.result;
  },
};

/** ── 假 Redis ───────────────────────────────────────────── */
const redisState = { store: new Map(), pushed: [], pushFail: null };
const fakeRedis = {
  async set(key, value) {
    if (redisState.store.has(key)) return null; // NX 语义
    redisState.store.set(key, value);
    return 'OK';
  },
  async get(key) {
    return redisState.store.has(key) ? redisState.store.get(key) : null;
  },
  async del(key) {
    return redisState.store.delete(key) ? 1 : 0;
  },
  async lpush(key, value) {
    if (redisState.pushFail) throw new Error(redisState.pushFail);
    redisState.pushed.push({ key, value });
    return 1;
  },
};

/** ── 假额度 ─────────────────────────────────────────────── */
const quotaState = { consumed: [], refunded: [], insufficient: false };
const fakeQuota = {
  ERR: { INSUFFICIENT: 4010 },
  async consume(uid, refId, remark) {
    if (quotaState.insufficient) {
      const e = new Error('本周免费额度已用完');
      e.code = 4010;
      throw e;
    }
    quotaState.consumed.push({ uid, refId, remark });
    return { ok: true };
  },
  async refund(uid, refId, remark) {
    quotaState.refunded.push({ uid, refId, remark });
    return { ok: true };
  },
};

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

stub(path.join(SRC, 'models/db.js'), fakeDb);
stub(path.join(SRC, 'ai/index.js'), fakeAi);
stub(path.join(SRC, 'utils/redis.js'), { redis: fakeRedis, KEY: {} });
stub(path.join(SRC, 'services/quota.js'), fakeQuota);

const practice = require(path.join(SRC, 'services/practice.js'));

/** ── 测试骨架 ───────────────────────────────────────────── */
function seedLesson({ ownerUid = 1, isCustom = 1 } = {}) {
  state.lesson = {
    id: 7,
    seq: 3,
    title: '小小的船',
    unit: '第一单元',
    kp: '[]',
  };
  state.textbook = {
    id: 2,
    name: '我的教材',
    subject: 1,
    grade: 1,
    is_custom: isCustom,
    owner_uid: ownerUid,
  };
}

function reset() {
  state.lesson = null;
  state.textbook = null;
  state.questions = [];
  state.calls = [];
  aiState.calls = 0;
  aiState.result = [];
  aiState.fail = null;
  redisState.store = new Map();
  redisState.pushed = [];
  redisState.pushFail = null;
  quotaState.consumed = [];
  quotaState.refunded = [];
  quotaState.insufficient = false;
  aiState.args = null;
  seedLesson();
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

/** ── 用例 ───────────────────────────────────────────────── */

test('已有题目：不再扣费，直接返回 ready', async () => {
  reset();
  state.questions.push({ lesson_id: 7, stem: 'a', answer: 'A' });

  const r = await practice.createPractice(1, 7);

  assert.strictEqual(r.status, 'ready');
  assert.strictEqual(r.count, 1);
  assert.strictEqual(quotaState.consumed.length, 0, '已有题目不应再扣额度');
  assert.strictEqual(redisState.pushed.length, 0, '不应入队');
});

test('首次生成：扣 1 次额度、入队、返回 pending', async () => {
  reset();
  const r = await practice.createPractice(1, 7);

  assert.strictEqual(r.status, 'pending');
  assert.strictEqual(quotaState.consumed.length, 1, '应扣 1 次额度');
  assert.strictEqual(quotaState.consumed[0].refId, 'lp-7', '流水号应与课文对应');
  assert.strictEqual(redisState.pushed.length, 1);
  assert.strictEqual(redisState.pushed[0].key, practice.PRACTICE_QUEUE);

  const msg = JSON.parse(redisState.pushed[0].value);
  assert.strictEqual(msg.lessonId, 7);
  assert.strictEqual(msg.uid, 1);
  assert.strictEqual(redisState.store.get('practice:gen:7'), '1', '应留下生成中标记');
});

test('生成中重复点击：不会重复扣费', async () => {
  reset();
  await practice.createPractice(1, 7);
  const again = await practice.createPractice(1, 7);

  assert.strictEqual(again.status, 'pending');
  assert.strictEqual(quotaState.consumed.length, 1, '只应扣一次');
  assert.strictEqual(redisState.pushed.length, 1, '只应入队一次');
});

test('入队失败：退还额度并清掉生成中标记', async () => {
  reset();
  redisState.pushFail = 'redis down';

  await assert.rejects(() => practice.createPractice(1, 7), /redis down/);

  assert.strictEqual(quotaState.refunded.length, 1, '入队失败必须退款');
  assert.strictEqual(quotaState.refunded[0].refId, 'lp-7');
  assert.strictEqual(redisState.store.get('practice:gen:7'), undefined, '标记必须清掉，否则永远卡生成中');
});

test('额度不足：报 4010 且不留标记', async () => {
  reset();
  quotaState.insufficient = true;

  await assert.rejects(() => practice.createPractice(1, 7), (e) => e.code === 4010);
  assert.strictEqual(redisState.store.get('practice:gen:7'), undefined);
  assert.strictEqual(redisState.pushed.length, 0);
});

test('worker 生成成功：写入题目、清标记、状态变 ready', async () => {
  reset();
  await practice.createPractice(1, 7);

  aiState.result = [
    { type: 1, stem: '题一', options: ['甲', '乙'], answer: '甲', analysis: '解析', difficulty: 1 },
    { type: 1, stem: '题二', options: ['丙', '丁'], answer: '丁', analysis: '解析', difficulty: 2 },
  ];

  await practice.runGeneratePractice(7, 1, 'lp-7');

  assert.strictEqual(state.questions.length, 2, '应写入 2 道题');
  assert.strictEqual(redisState.store.get('practice:gen:7'), undefined, '成功后应清标记');
  assert.strictEqual(quotaState.refunded.length, 0, '成功不应退款');

  const st = await practice.getPracticeStatus(1, 7);
  assert.strictEqual(st.status, 'ready');
  assert.strictEqual(st.count, 2);
});

test('worker 生成失败：退款、清标记、状态回到 none', async () => {
  reset();
  await practice.createPractice(1, 7);
  aiState.fail = '模型超时';

  await practice.runGeneratePractice(7, 1, 'lp-7');

  assert.strictEqual(state.questions.length, 0);
  assert.strictEqual(quotaState.refunded.length, 1, '失败必须退款');
  assert.strictEqual(quotaState.refunded[0].refId, 'lp-7');
  assert.strictEqual(redisState.store.get('practice:gen:7'), undefined);

  const st = await practice.getPracticeStatus(1, 7);
  assert.strictEqual(st.status, 'none', '清标记后应回到可重新生成的初始态');
});

test('重试不堆题：再次生成会先清空旧题', async () => {
  reset();
  state.questions.push({ lesson_id: 7, stem: '旧题', answer: 'A' });

  await practice.runGeneratePractice(7, 1, 'lp-7');
  aiState.result = [
    { type: 1, stem: '新题', options: ['甲', '乙'], answer: '乙', analysis: '', difficulty: 1 },
  ];
  await practice.runGeneratePractice(7, 1, 'lp-7');

  assert.strictEqual(state.questions.length, 1, '同一课不应堆出重复题');
  assert.strictEqual(state.questions[0].stem, '新题');
});

test('别人的自定义教材：不可生成，也不扣费', async () => {
  reset();
  seedLesson({ ownerUid: 999 });

  await assert.rejects(() => practice.createPractice(1, 7), /课文不存在/);
  assert.strictEqual(quotaState.consumed.length, 0);
});

test('题量透传：选了 15 道，入队消息带 15', async () => {
  reset();
  await practice.createPractice(1, 7, 15);

  const msg = JSON.parse(redisState.pushed[0].value);
  assert.strictEqual(msg.count, 15, '题量必须进队列，否则 worker 按默认档出题');
});

test('非法题量：回落默认 5，不报错', async () => {
  reset();
  const r = await practice.createPractice(1, 7, 999);

  assert.strictEqual(r.status, 'pending');
  const msg = JSON.parse(redisState.pushed[0].value);
  assert.strictEqual(msg.count, 5, '只认 5/10/15/20，其它值回落默认档');
});

test('worker 按队列里的题量出题', async () => {
  reset();
  await practice.createPractice(1, 7, 20);
  aiState.result = [{ type: 1, stem: '题', options: ['甲', '乙'], answer: '甲', analysis: '', difficulty: 1 }];

  await practice.runGeneratePractice(7, 1, 'lp-7', 20);

  assert.strictEqual(aiState.args.count, 20, 'AI 层收到的题量必须与用户选择一致');
});

test('老队列消息没有 count：按默认 5 道出题', async () => {
  reset();
  aiState.result = [{ type: 1, stem: '题', options: ['甲', '乙'], answer: '甲', analysis: '', difficulty: 1 }];

  await practice.runGeneratePractice(7, 1, 'lp-7', undefined);

  assert.strictEqual(aiState.args.count, 5);
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
    console.error(`\n课后练习自测失败：${failed}/${tests.length}`);
    process.exit(1);
  }
  console.log(`\n课后练习自测通过（${tests.length} 项）`);
})();
