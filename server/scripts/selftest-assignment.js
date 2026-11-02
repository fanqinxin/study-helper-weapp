/**
 * 作业任务单自测（不依赖 MySQL / Redis / 真实 AI）
 *
 * 覆盖只有真跑才炸的路径：
 *   1. 扣额度与建记录之间失败必须退款
 *   2. 同一组截图重复提交幂等返回，不重复扣费
 *   3. runParseAssignment 幂等：已 READY 的任务单不重复识别
 *   4. 识别失败置 FAILED + 退款
 *   5. 打卡归属校验：别人的任务打不了勾
 *
 * 用法：node scripts/selftest-assignment.js
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
  assignments: [],
  items: [],
  nextId: 1,
};

async function route(sql, params) {
  const s = sql.replace(/\s+/g, ' ').trim();

  if (/^SELECT id, status FROM assignment WHERE uid = \? AND image_hash = \? LIMIT 1$/.test(s)) {
    return state.assignments
      .filter((a) => a.uid === params[0] && a.image_hash === params[1])
      .slice(0, 1)
      .map((a) => ({ id: a.id, status: a.status }));
  }
  if (/^SELECT \* FROM assignment WHERE id = \? AND uid = \?$/.test(s)) {
    return state.assignments
      .filter((a) => a.id === params[0] && a.uid === params[1])
      .map((a) => ({ ...a }));
  }
  if (/^INSERT INTO assignment \(uid, task_date, image_urls, source_text, image_hash, status\)/.test(s)) {
    const a = {
      id: state.nextId++,
      uid: params[0],
      task_date: params[1],
      image_urls: params[2],
      source_text: params[3],
      image_hash: params[4],
      status: params[5],
      title: null,
      note: null,
      error: null,
    };
    state.assignments.push(a);
    return { insertId: a.id, affectedRows: 1 };
  }
  if (/^UPDATE quota_log SET ref_id = \?/.test(s)) {
    return { affectedRows: 1 };
  }
  if (/^DELETE FROM assignment_item WHERE assignment_id = \?$/.test(s)) {
    const before = state.items.length;
    state.items = state.items.filter((it) => it.assignment_id !== params[0]);
    return { affectedRows: before - state.items.length };
  }
  if (/^INSERT INTO assignment_item \(assignment_id, subject, content, sort\)/.test(s)) {
    state.items.push({
      id: state.items.length + 1,
      assignment_id: params[0],
      subject: params[1],
      content: params[2],
      sort: params[3],
      done: 0,
      done_at: null,
    });
    return { insertId: state.items.length, affectedRows: 1 };
  }
  if (/^UPDATE assignment SET title = \?, note = \?, status = \?, error = NULL WHERE id = \?$/.test(s)) {
    const a = state.assignments.find((x) => x.id === params[3]);
    if (a) {
      a.title = params[0];
      a.note = params[1];
      a.status = params[2];
      a.error = null;
    }
    return { affectedRows: a ? 1 : 0 };
  }
  if (/^UPDATE assignment SET status = \?, error = \? WHERE id = \?$/.test(s)) {
    const a = state.assignments.find((x) => x.id === params[2]);
    if (a) {
      a.status = params[0];
      a.error = params[1];
    }
    return { affectedRows: a ? 1 : 0 };
  }
  if (/^SELECT id, subject, content, sort, done, done_at AS doneAt FROM assignment_item WHERE assignment_id = \?/.test(s)) {
    return state.items
      .filter((it) => it.assignment_id === params[0])
      .sort((x, y) => x.sort - y.sort || x.id - y.id)
      .map((it) => ({ ...it, doneAt: it.done_at }));
  }
  if (/^SELECT id, task_date AS taskDate, title, note, status, created_at AS createdAt FROM assignment WHERE uid = \? AND task_date = \?/.test(s)) {
    return state.assignments
      .filter((a) => a.uid === params[0] && a.task_date === params[1])
      .sort((x, y) => y.id - x.id)
      .slice(0, params[2])
      .map((a) => ({
        id: a.id, taskDate: a.task_date, title: a.title, note: a.note, status: a.status, createdAt: null,
      }));
  }
  if (/^SELECT id, task_date AS taskDate, title, note, status, created_at AS createdAt FROM assignment WHERE uid = \? ORDER BY task_date DESC, id DESC/.test(s)) {
    return [...state.assignments]
      .filter((a) => a.uid === params[0])
      .sort((x, y) => (x.task_date < y.task_date ? 1 : x.task_date > y.task_date ? -1 : y.id - x.id))
      .slice(0, params[1])
      .map((a) => ({
        id: a.id, taskDate: a.task_date, title: a.title, note: a.note, status: a.status, createdAt: null,
      }));
  }
  if (/^SELECT id, assignment_id AS assignmentId, subject, content, sort, done, done_at AS doneAt FROM assignment_item WHERE assignment_id IN \(/.test(s)) {
    const ids = params;
    return state.items
      .filter((it) => ids.includes(it.assignment_id))
      .sort((x, y) => x.sort - y.sort || x.id - y.id)
      .map((it) => ({ ...it, assignmentId: it.assignment_id, doneAt: it.done_at }));
  }
  if (/^SELECT i\.id, i\.assignment_id FROM assignment_item i JOIN assignment a ON a\.id = i\.assignment_id WHERE i\.id = \? AND a\.uid = \?$/.test(s)) {
    const it = state.items.find((x) => x.id === params[0]);
    if (!it) return [];
    const a = state.assignments.find((x) => x.id === it.assignment_id);
    return a && a.uid === params[1] ? [{ id: it.id, assignment_id: it.assignment_id }] : [];
  }
  if (/^UPDATE assignment_item SET done = \?, done_at = \? WHERE id = \?$/.test(s)) {
    const it = state.items.find((x) => x.id === params[2]);
    if (it) {
      it.done = params[0];
      it.done_at = params[1];
    }
    return { affectedRows: it ? 1 : 0 };
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
    throw new Error('任务单服务不应直接取连接');
  },
  async ping() {
    return true;
  },
};

/** ── 假 AI ──────────────────────────────────────────────── */
const aiState = { calls: 0, result: null, fail: null, lastPayload: null };
const fakeAi = {
  // 模拟真实现：识别不出任何任务条目时报错（真 ai.recognizeAssignment 的清洗逻辑）
  async recognizeAssignment(payload) {
    aiState.calls += 1;
    aiState.lastPayload = payload;
    if (aiState.fail) throw new Error(aiState.fail);
    const groups = (aiState.result && aiState.result.groups) || [];
    const hasItems = groups.some((g) => (g.items || []).length);
    if (!hasItems) throw new Error('没有识别出作业任务，请确认提交的是作业内容');
    return aiState.result;
  },
  SUBJECT_NAME: { 0: '通用', 1: '语文' },
};

/** ── 假 Redis ───────────────────────────────────────────── */
const redisState = { store: new Map(), pushed: [] };
const fakeRedis = {
  async lpush(key, value) {
    redisState.pushed.push({ key, value });
    return 1;
  },
  async set(key, value, ...rest) {
    if (rest.includes('NX') && redisState.store.has(key)) return null;
    redisState.store.set(key, value);
    return 'OK';
  },
  async del(key) {
    redisState.store.delete(key);
    return 1;
  },
  async get(key) {
    return redisState.store.get(key) || null;
  },
};

/** ── 假额度 ─────────────────────────────────────────────── */
const quotaState = { consumed: [], refunded: [], insufficient: false };
const fakeQuota = {
  ERR: { INSUFFICIENT: 4010 },
  SOURCE: { CONSUME: 1, REFUND: 2 },
  async consume(uid, refId, remark) {
    if (quotaState.insufficient) {
      const e = new Error('额度不足');
      e.code = 4010;
      throw e;
    }
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

const assignment = require(path.join(SRC, 'services/assignment.js'));

/** ── 测试骨架 ───────────────────────────────────────────── */
function reset() {
  state.assignments = [];
  state.items = [];
  state.nextId = 1;
  aiState.calls = 0;
  aiState.result = null;
  aiState.fail = null;
  aiState.lastPayload = null;
  redisState.store = new Map();
  redisState.pushed = [];
  quotaState.consumed = [];
  quotaState.refunded = [];
  quotaState.insufficient = false;
}

const IMGS = ['/static/uploads/hw1.jpg', '/static/uploads/hw2.jpg'];

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

/** ── 用例 ───────────────────────────────────────────────── */

test('能力清单暴露 assignment.text（小程序靠它判断服务端是否已更新）', async () => {
  const { version, features } = require(path.join(SRC, 'version.js'));
  assert.ok(version, '必须能取到版本号');
  assert.ok(
    features.includes('assignment.text'),
    '缺少 assignment.text 会让小程序把新服务端误判成旧版本，页面上会报"服务端版本较旧"'
  );
  assert.ok(features.includes('assignment.photo'));
});

test('参数校验：无图无文字 / 超 6 张 / 文字超长直接报错，不扣额度', async () => {
  reset();
  await assert.rejects(() => assignment.createAssignment(1, { imageUrls: [] }), /粘贴作业文字或上传作业截图/);
  await assert.rejects(() => assignment.createAssignment(1, { text: '   ' }), /粘贴作业文字或上传作业截图/);
  await assert.rejects(
    () => assignment.createAssignment(1, { imageUrls: new Array(7).fill('/a.jpg') }),
    /最多上传/
  );
  await assert.rejects(
    () => assignment.createAssignment(1, { text: '长'.repeat(4001) }),
    /太长/
  );
  assert.strictEqual(quotaState.consumed.length, 0);
  assert.strictEqual(state.assignments.length, 0);
});

test('创建任务：扣 1 次额度、入队、返回 pending', async () => {
  reset();
  const r = await assignment.createAssignment(1, { imageUrls: IMGS });

  assert.strictEqual(r.status, 'pending');
  assert.strictEqual(r.cached, false);
  assert.strictEqual(quotaState.consumed.length, 1, '应扣 1 次额度');
  assert.ok(quotaState.consumed[0].refId.startsWith('pending-'), '扣费流水号应为 pending- 前缀');
  assert.strictEqual(redisState.pushed.length, 1);
  assert.strictEqual(redisState.pushed[0].key, assignment.ASSIGNMENT_QUEUE);

  const msg = JSON.parse(redisState.pushed[0].value);
  assert.strictEqual(msg.assignmentId, r.assignmentId);
  assert.strictEqual(msg.refId, `as-${r.assignmentId}`, '退款流水号应与任务单对应');

  const row = state.assignments.find((a) => a.id === r.assignmentId);
  assert.strictEqual(row.status, assignment.STATUS.PARSING);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(row.task_date), 'task_date 默认今天');
});

test('幂等：同一组截图重复提交直接返回，不重复扣费', async () => {
  reset();
  const first = await assignment.createAssignment(1, { imageUrls: IMGS });
  const again = await assignment.createAssignment(1, { imageUrls: [...IMGS] });

  assert.strictEqual(again.cached, true);
  assert.strictEqual(again.assignmentId, first.assignmentId);
  assert.strictEqual(quotaState.consumed.length, 1, '只应扣一次');
  assert.strictEqual(redisState.pushed.length, 1, '只应入队一次');
});

test('粘贴文字：主要方式，source_text 落库、image_urls 为空，同样扣费入队', async () => {
  reset();
  const r = await assignment.createAssignment(1, { text: '  数学书P23 1-4题，朗读第5课  ' });

  assert.strictEqual(r.status, 'pending');
  assert.strictEqual(quotaState.consumed.length, 1);

  const row = state.assignments.find((a) => a.id === r.assignmentId);
  assert.strictEqual(row.source_text, '数学书P23 1-4题，朗读第5课', '文字应去首尾空白后落库');
  assert.strictEqual(row.image_urls, null, '纯文字不应有截图');

  // worker 执行时应把文字传给 AI
  aiState.result = { title: 'T', note: null, groups: [{ subject: 2, items: ['口算'] }] };
  await assignment.runParseAssignment(r.assignmentId, 1, `as-${r.assignmentId}`);
  assert.strictEqual(aiState.lastPayload.text, '数学书P23 1-4题，朗读第5课');
  assert.strictEqual(aiState.lastPayload.imageUrls.length, 0);
});

test('幂等：同一段文字重复提交直接返回，不重复扣费', async () => {
  reset();
  const first = await assignment.createAssignment(1, { text: '口算一页，朗读课文' });
  const again = await assignment.createAssignment(1, { text: '口算一页，朗读课文' });

  assert.strictEqual(again.cached, true);
  assert.strictEqual(again.assignmentId, first.assignmentId);
  assert.strictEqual(quotaState.consumed.length, 1);
});

test('文字与截图指纹隔离：同一用户分别提交各扣一次', async () => {
  reset();
  await assignment.createAssignment(1, { text: '口算一页' });
  await assignment.createAssignment(1, { imageUrls: IMGS });
  assert.strictEqual(quotaState.consumed.length, 2, '不同来源是两份作业');
});

test('额度不足：报 4010 且不留记录', async () => {
  reset();
  quotaState.insufficient = true;
  await assert.rejects(
    () => assignment.createAssignment(1, { imageUrls: IMGS }),
    (e) => e.code === 4010
  );
  assert.strictEqual(state.assignments.length, 0);
  assert.strictEqual(quotaState.refunded.length, 0, '没扣成不需要退款');
  assert.strictEqual(redisState.pushed.length, 0);
});

test('worker 识别成功：写明细、置 READY、清标记', async () => {
  reset();
  const r = await assignment.createAssignment(1, { imageUrls: IMGS });
  aiState.result = {
    title: '10/28 作业',
    note: '明天带彩笔',
    groups: [
      { subject: 1, items: ['读课文第5课3遍', '抄写生字'] },
      { subject: 2, items: ['读背2-5的乘法口诀'] },
      { subject: 0, items: ['跳绳打卡'] },
    ],
  };

  await assignment.runParseAssignment(r.assignmentId, 1, `as-${r.assignmentId}`);

  const row = state.assignments.find((a) => a.id === r.assignmentId);
  assert.strictEqual(row.status, assignment.STATUS.READY);
  assert.strictEqual(row.title, '10/28 作业');
  assert.strictEqual(row.note, '明天带彩笔');
  assert.strictEqual(state.items.length, 4, '3 组共 4 条任务');
  assert.strictEqual(quotaState.refunded.length, 0, '成功不应退款');
  assert.strictEqual(redisState.store.get(`assignment:parse:${r.assignmentId}`), undefined, '应清生成中标记');

  const st = await assignment.getParseStatus(1, r.assignmentId);
  assert.strictEqual(st.status, 'ready');
  assert.strictEqual(st.count, 4);
});

test('worker 幂等：已 READY 的任务单不再重复识别', async () => {
  reset();
  const r = await assignment.createAssignment(1, { imageUrls: IMGS });
  aiState.result = { title: 'T', note: null, groups: [{ subject: 1, items: ['任务'] }] };
  await assignment.runParseAssignment(r.assignmentId, 1, `as-${r.assignmentId}`);
  assert.strictEqual(aiState.calls, 1);

  await assignment.runParseAssignment(r.assignmentId, 1, `as-${r.assignmentId}`);
  assert.strictEqual(aiState.calls, 1, '第二次应直接跳过');
});

test('worker 识别失败：置 FAILED、写错误、退款', async () => {
  reset();
  const r = await assignment.createAssignment(1, { imageUrls: IMGS });
  aiState.fail = '视觉服务超时';

  await assignment.runParseAssignment(r.assignmentId, 1, `as-${r.assignmentId}`);

  const row = state.assignments.find((a) => a.id === r.assignmentId);
  assert.strictEqual(row.status, assignment.STATUS.FAILED);
  assert.ok(row.error.includes('超时'));
  assert.strictEqual(quotaState.refunded.length, 1);
  assert.strictEqual(quotaState.refunded[0].refId, `as-${r.assignmentId}`);
  assert.strictEqual(state.items.length, 0, '失败不留半截数据');
});

test('识别出空任务：失败并退款，不让用户白扣', async () => {
  reset();
  const r = await assignment.createAssignment(1, { imageUrls: IMGS });
  aiState.result = { title: '', note: '', groups: [{ subject: 1, items: [] }] };

  await assignment.runParseAssignment(r.assignmentId, 1, `as-${r.assignmentId}`);

  const row = state.assignments.find((a) => a.id === r.assignmentId);
  assert.strictEqual(row.status, assignment.STATUS.FAILED);
  assert.strictEqual(quotaState.refunded.length, 1);
});

test('打卡：勾选 / 取消，别人的任务打不了勾', async () => {
  reset();
  const r = await assignment.createAssignment(1, { imageUrls: IMGS });
  aiState.result = { title: 'T', note: null, groups: [{ subject: 2, items: ['口算一页'] }] };
  await assignment.runParseAssignment(r.assignmentId, 1, `as-${r.assignmentId}`);

  const itemId = state.items[0].id;
  const on = await assignment.toggleItem(1, itemId, true);
  assert.strictEqual(on.done, true);
  assert.strictEqual(state.items[0].done, 1);

  const off = await assignment.toggleItem(1, itemId, false);
  assert.strictEqual(off.done, false);

  await assert.rejects(() => assignment.toggleItem(999, itemId, true), /任务不存在/);
});

test('列表：按日期倒序并附带明细', async () => {
  reset();
  const r1 = await assignment.createAssignment(1, { imageUrls: IMGS, taskDate: '2026-11-01' });
  const r2 = await assignment.createAssignment(1, {
    imageUrls: ['/static/uploads/other.jpg'],
    taskDate: '2026-11-02',
  });
  aiState.result = { title: 'T', note: null, groups: [{ subject: 1, items: ['任务A'] }] };
  await assignment.runParseAssignment(r2.assignmentId, 1, `as-${r2.assignmentId}`);

  const list = await assignment.listAssignments(1, {});
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].id, r2.assignmentId, '日期新的在前');
  assert.strictEqual(list[0].items.length, 1);
  assert.strictEqual(list[0].items[0].subjectName, '语文');
  assert.strictEqual(list[1].statusText, 'pending', '未识别的标注 pending');

  const byDate = await assignment.listAssignments(1, { date: '2026-11-01' });
  assert.strictEqual(byDate.length, 1);
  assert.strictEqual(byDate[0].id, r1.assignmentId);
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
    console.error(`\n作业任务单自测失败：${failed}/${tests.length}`);
    process.exit(1);
  }
  console.log(`\n作业任务单自测通过（${tests.length} 项）`);
})();
