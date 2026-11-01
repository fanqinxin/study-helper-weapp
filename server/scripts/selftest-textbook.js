/**
 * 自定义教材识别自测（不依赖 MySQL / Redis / 真实 AI）
 *
 * 为什么要这个脚本：
 *   教材识别原本是「同步跑 AI」，60 秒视觉调用必然撞上小程序的 30 秒请求超时，
 *   用户看到失败、模型还在跑，额度照扣。改成「建记录 + 投递任务 + 轮询状态」后，
 *   出现了一批只有真跑才炸的路径：
 *
 *   1. 扣额度在事务外，入队失败时必须把额度退回，否则用户白扣
 *   2. runRecognize 必须幂等：重复投递、用户重复点都能安全跳过
 *   3. 识别失败要标 FAILED 并退款，不能只在日志里留一句
 *   4. worker 挂了 / 队列消息丢了，记录会永远停在"识别中"，必须有超时兜底
 *
 * 这些用静态检查全查不出来，所以这里用假 DB / 假 Redis / 假 AI 跑一遍。
 *
 * 用法：node scripts/selftest-textbook.js
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
  textbook: null,
  lessons: [],
  calls: [],
  clock: Date.now(),
};

let nextId = 1;
/** 让 created_at / 超时判断可控 */
function setNow(ms) {
  state.clock = ms;
}

async function route(sql, params) {
  const s = sql.replace(/\s+/g, ' ').trim();
  state.calls.push(s);

  if (/^INSERT INTO textbook/.test(s)) {
    state.textbook = {
      id: nextId++,
      name: params[0],
      subject: params[1],
      grade: params[2],
      volume: params[3],
      is_custom: 1,
      owner_uid: params[4],
      status: params[5],
      created_at: new Date(state.clock),
    };
    return { insertId: state.textbook.id, affectedRows: 1 };
  }
  if (/^DELETE FROM textbook WHERE id = \? AND owner_uid = \? AND status = \?/.test(s)) {
    const match = state.textbook && state.textbook.id === params[0];
    if (match) state.textbook = null;
    return { affectedRows: match ? 1 : 0 };
  }
  if (/^SELECT \* FROM textbook WHERE id = \?$/.test(s)) {
    return state.textbook && state.textbook.id === params[0] ? [{ ...state.textbook }] : [];
  }
  if (/^SELECT id, status, created_at AS createdAt FROM textbook/.test(s)) {
    if (!state.textbook || state.textbook.id !== params[0]) return [];
    return [{
      id: state.textbook.id,
      status: state.textbook.status,
      createdAt: state.textbook.created_at,
    }];
  }
  if (/^UPDATE textbook SET status = \? WHERE id = \?$/.test(s)) {
    if (state.textbook) state.textbook.status = params[0];
    return { affectedRows: 1 };
  }
  if (/^DELETE FROM lesson WHERE textbook_id = \?$/.test(s)) {
    const before = state.lessons.length;
    state.lessons = state.lessons.filter((l) => l.textbook_id !== params[0]);
    return { affectedRows: before - state.lessons.length };
  }
  if (/^INSERT INTO lesson/.test(s)) {
    state.lessons.push({
      textbook_id: params[0],
      seq: params[1],
      title: params[2],
      unit: params[3],
      knowledge_points: params[4],
    });
    return { insertId: state.lessons.length, affectedRows: 1 };
  }
  if (/^SELECT COUNT\(\*\) AS cnt FROM lesson WHERE textbook_id = \?$/.test(s)) {
    return [{ cnt: state.lessons.filter((l) => l.textbook_id === params[0]).length }];
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
    throw new Error('教材服务不应直接取连接');
  },
  async ping() {
    return true;
  },
};

/** ── 假 AI ──────────────────────────────────────────────── */
const aiState = { calls: 0, result: [], fail: null };
const fakeAi = {
  async recognizeCatalog() {
    aiState.calls += 1;
    if (aiState.fail) throw new Error(aiState.fail);
    return aiState.result;
  },
  SUBJECT_NAME: { 1: '语文' },
};

/** ── 假 Redis ───────────────────────────────────────────── */
const queueState = { pushed: [] };
const fakeRedis = {
  async lpush(key, value) {
    queueState.pushed.push({ key, value });
    return 1;
  },
  async brpop() {
    return null;
  },
};

/** ── 假额度 ─────────────────────────────────────────────── */
const quotaState = { consumed: [], refunded: [] };
const fakeQuota = {
  ERR: { INSUFFICIENT: 4010 },
  SOURCE: { CONSUME: 1, REFUND: 2 },
  async consume(uid, refId, remark) {
    quotaState.consumed.push({ uid, refId, remark });
    return { ok: true, from: 'free' };
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

const textbook = require(path.join(SRC, 'services/textbook.js'));

/** ── 测试骨架 ───────────────────────────────────────────── */
function reset() {
  state.textbook = null;
  state.lessons = [];
  state.calls = [];
  state.clock = Date.now();
  aiState.calls = 0;
  aiState.result = [];
  aiState.fail = null;
  queueState.pushed = [];
  quotaState.consumed = [];
  quotaState.refunded = [];
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

/** ── 用例 ───────────────────────────────────────────────── */

test('建任务：立即返回识别中，扣 1 次额度并入队', async () => {
  reset();
  const r = await textbook.createCustomTextbook(1, {
    subject: 2,
    grade: 3,
    volume: 1,
    imageUrls: ['/static/uploads/a.jpg', '/static/uploads/b.jpg'],
  });

  assert.strictEqual(r.status, textbook.STATUS.RECOGNIZING, '应返回识别中');
  assert.strictEqual(r.lessonCount, 0, '此时还没有课文');
  assert.strictEqual(state.textbook.status, textbook.STATUS.RECOGNIZING);
  assert.strictEqual(quotaState.consumed.length, 1, '应扣 1 次额度');
  assert.strictEqual(quotaState.consumed[0].refId, `tb-${r.textbookId}`, '流水号应与教材对应');
  assert.strictEqual(queueState.pushed.length, 1, '应投递 1 条识别任务');
  assert.strictEqual(queueState.pushed[0].key, textbook.TEXTBOOK_QUEUE);

  const msg = JSON.parse(queueState.pushed[0].value);
  assert.strictEqual(msg.textbookId, r.textbookId);
  assert.deepStrictEqual(msg.imageUrls, ['/static/uploads/a.jpg', '/static/uploads/b.jpg']);
});

test('入队失败：删除记录并退还额度', async () => {
  reset();
  fakeRedis.lpush = async () => {
    throw new Error('redis down');
  };
  await assert.rejects(
    () => textbook.createCustomTextbook(1, { subject: 1, grade: 1, imageUrls: ['/static/uploads/a.jpg'] }),
    /redis down/
  );

  assert.strictEqual(state.textbook, null, '失败后不应残留半成品记录');
  assert.strictEqual(quotaState.refunded.length, 1, '应退还额度');
  assert.strictEqual(quotaState.refunded[0].refId, `tb-${quotaState.refunded[0].refId.split('-')[1]}`);

  // 复原，避免影响后续用例
  fakeRedis.lpush = async (key, value) => {
    queueState.pushed.push({ key, value });
    return 1;
  };
});

test('worker 识别成功：写入课文并置为可用', async () => {
  reset();
  aiState.result = [
    { unit: '第一单元', seq: 1, title: '秋天' },
    { unit: '第一单元', seq: 2, title: '小小的船' },
  ];

  const { textbookId } = await textbook.createCustomTextbook(1, {
    subject: 1,
    grade: 1,
    imageUrls: ['/static/uploads/a.jpg'],
  });

  await textbook.runRecognize(textbookId, ['/static/uploads/a.jpg']);

  assert.strictEqual(state.textbook.status, textbook.STATUS.READY);
  assert.strictEqual(state.lessons.length, 2, '应写入 2 篇课文');

  const st = await textbook.getCustomStatus(1, textbookId);
  assert.strictEqual(st.status, textbook.STATUS.READY);
  assert.strictEqual(st.lessonCount, 2);
  assert.strictEqual(quotaState.refunded.length, 0, '成功路径不应退款');
});

test('worker 识别失败：标记失败并退还额度', async () => {
  reset();
  aiState.fail = '模型超时';

  const { textbookId } = await textbook.createCustomTextbook(1, {
    subject: 1,
    grade: 1,
    imageUrls: ['/static/uploads/a.jpg'],
  });

  await textbook.runRecognize(textbookId, ['/static/uploads/a.jpg']);

  assert.strictEqual(state.textbook.status, textbook.STATUS.FAILED);
  assert.strictEqual(quotaState.refunded.length, 1, '失败必须退款');
  assert.strictEqual(quotaState.refunded[0].refId, `tb-${textbookId}`);
});

test('worker 幂等：已可用的教材不再重复识别', async () => {
  reset();
  aiState.result = [{ unit: null, seq: 1, title: 'a' }];

  const { textbookId } = await textbook.createCustomTextbook(1, {
    subject: 1,
    grade: 1,
    imageUrls: ['/static/uploads/a.jpg'],
  });
  await textbook.runRecognize(textbookId, ['/static/uploads/a.jpg']);
  const callsAfterFirst = aiState.calls;

  // 模拟消息重复投递
  await textbook.runRecognize(textbookId, ['/static/uploads/a.jpg']);

  assert.strictEqual(aiState.calls, callsAfterFirst, '重复投递不应再次调 AI');
  assert.strictEqual(state.lessons.length, 1, '课文不应重复堆积');
});

test('超时兜底：卡在识别中超过 10 分钟自动判失败并退款', async () => {
  reset();
  state.clock = Date.now() - 11 * 60 * 1000; // 11 分钟前创建

  const { textbookId } = await textbook.createCustomTextbook(1, {
    subject: 1,
    grade: 1,
    imageUrls: ['/static/uploads/a.jpg'],
  });

  const st = await textbook.getCustomStatus(1, textbookId);
  assert.strictEqual(st.status, textbook.STATUS.FAILED, '超时应判失败');
  assert.strictEqual(quotaState.refunded.length, 1, '超时也要退款');
});

test('参数校验：非法学科 / 过多图片直接报错，且不扣额度', async () => {
  reset();
  await assert.rejects(
    () => textbook.createCustomTextbook(1, { subject: 'undefined', grade: 1, imageUrls: ['/a.jpg'] }),
    /请选择学科和年级/
  );
  await assert.rejects(
    () => textbook.createCustomTextbook(1, { subject: 1, grade: 1, imageUrls: new Array(7).fill('/a.jpg') }),
    /最多 6 张/
  );
  assert.strictEqual(quotaState.consumed.length, 0, '校验失败不应扣额度');
  assert.strictEqual(state.textbook, null);
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
    console.error(`\n教材识别自测失败：${failed}/${tests.length}`);
    process.exit(1);
  }
  console.log(`\n教材识别自测通过（${tests.length} 项）`);
})();
