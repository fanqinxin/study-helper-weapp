/**
 * 额度服务自测（不依赖 MySQL / Redis）
 *
 * 为什么要这个脚本：
 * quota.ensureAccount 是「双入口」函数 —— 既能被事务连接调用（返回 [rows, fields]），
 * 也能被 getBalance 用连接池调用（返回 rows）。历史上出过两次线上事故：
 *
 *   1. 跨周期重置分支里直接写了 conn.query(...)，conn 为 null →
 *      "Cannot read properties of null (reading 'query')"，余额接口 500
 *   2. 用 acc.cycle_start !== '2026-10-26' 比较，而 mysql2 把 DATE 解析成 Date 对象，
 *      两者永不相等 → 每个请求都判定跨周期，免费额度被反复重置成 0 已用
 *
 * 两个都是「语法检查查不出、只有真跑才炸」的问题，所以这里用假 DB 把两条路径都跑一遍。
 *
 * 用法：node scripts/selftest-quota.js
 */
const assert = require('assert');
const Module = require('module');

/**
 * 让这个脚本在没装依赖的机器上也能跑（例如 CI 的 lint 阶段、本地干净环境）。
 * 只对「装了就用真的、没装才兜底」的纯噪音依赖生效：dotenv 读 .env、pino 打日志，
 * 与额度逻辑无关，缺了不影响断言。
 */
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

const dbPath = require.resolve('../src/models/db');

/** ── 假数据库 ───────────────────────────────────────────── */
const state = {
  row: null, // 模拟 quota_account 表里的那一行
  calls: [], // 记录执行过的 SQL，用于断言"有没有写"
  connUsed: false,
};

/**
 * SQL 路由：连接池与事务连接共用。
 * 同时承担列约束校验 —— 真库会因超长/类型不符报错，假库必须同样报错，
 * 否则测试会放过线上必炸的写法（ref_id 超长就是教训）。
 */
async function route(sql, params) {
  const s = sql.replace(/\s+/g, ' ').trim();
  state.calls.push(s);

  // 列约束：ref_id VARCHAR(64)。超长会炸掉整个扣费事务，这里必须同样炸。
  if (/^(INSERT INTO quota_log|UPDATE quota_log SET ref_id)/.test(s)) {
    const v = /^INSERT/.test(s) ? params[3] : params[0];
    if (v != null && String(v).length > 64) {
      throw new Error(`Data too long for column 'ref_id' at row 1`);
    }
  }

  if (/^SELECT \* FROM quota_account WHERE uid/.test(s)) {
    return state.row ? [state.row] : [];
  }
  if (/^INSERT INTO quota_account/.test(s)) {
    state.row = {
      uid: params[0],
      free_used: 0,
      free_total: params[1],
      cycle_start: params[2],
      paid_balance: 0,
      monthly_until: null,
    };
    return { insertId: 1, affectedRows: 1 };
  }
  if (/^UPDATE quota_account SET free_used = 0/.test(s)) {
    state.row.free_used = 0;
    state.row.cycle_start = params[0];
    state.row.free_total = params[1];
    return { affectedRows: 1 };
  }
  if (/^UPDATE quota_account SET free_used = free_used \+ 1/.test(s)) {
    state.row.free_used += 1;
    return { affectedRows: 1 };
  }
  if (/^UPDATE quota_account SET paid_balance = paid_balance - 1/.test(s)) {
    state.row.paid_balance -= 1;
    return { affectedRows: 1 };
  }
  if (/^UPDATE quota_account SET paid_balance = paid_balance \+ 1/.test(s)) {
    state.row.paid_balance += 1;
    return { affectedRows: 1 };
  }
  if (/^INSERT INTO quota_log/.test(s)) {
    return { insertId: 1, affectedRows: 1 };
  }
  throw new Error('假数据库未适配的 SQL：' + s);
}

/** 事务连接：mysql2 原生形态，query 返回 [rows, fields] */
function makeConn() {
  return {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql, params) {
      const rows = await route(sql, params);
      return [rows, []];
    },
  };
}

const fakeDb = {
  pool: {},
  async query(sql, params) {
    return route(sql, params);
  },
  async getConnection() {
    state.connUsed = true;
    return makeConn();
  },
  async transaction() {
    throw new Error('未使用');
  },
  async ping() {
    return true;
  },
};

// 必须在 require quota 之前把 db 模块替换掉
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: fakeDb,
  children: [],
  paths: [],
};

const quota = require('../src/services/quota');

/** ── 断言小工具 ─────────────────────────────────────────── */
const dayMs = 86400000;
const toDay = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
/**
 * 造一个「本地零点」的 Date，模拟 mysql2 解析 DATE 列的结果。
 *
 * 不能用 new Date('2026-10-26T00:00:00+08:00')：那个是绝对时间点，
 * 在 UTC 的 CI runner 上换算成本地就变成前一天，用例会假失败。
 * 这里必须和被测代码用同一个时区视角，用例才与运行环境无关。
 */
const localMidnight = (dayStr) => {
  const [y, m, d] = dayStr.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const wrote = (re) => state.calls.some((s) => re.test(s));

function reset() {
  state.row = null;
  state.calls = [];
  state.connUsed = false;
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

/** 1. 本周期内不重置（Date 形态的 cycle_start 也要能正确比较） */
test('本周期内：不触发跨周期重置', async () => {
  reset();
  const cycleDay = toDay(quota.currentCycleStart());
  state.row = {
    uid: 1,
    free_used: 3,
    free_total: 500,
    cycle_start: localMidnight(cycleDay), // 若 dateStrings 未生效，mysql2 就是这么返回的
    paid_balance: 2,
    monthly_until: null,
  };

  const bal = await quota.getBalance(1);

  assert.strictEqual(bal.freeLeft, 497, 'freeLeft 应为 free_total - free_used');
  assert.strictEqual(bal.freeUsed, 3);
  assert.strictEqual(bal.totalLeft, 499);
  assert.ok(!wrote(/UPDATE quota_account SET free_used = 0/), '本周期内不应重置免费额度');
  assert.ok(!wrote(/INSERT INTO quota_log/), '本周期内不应写额度流水');
  assert.ok(!state.connUsed);
});

/** 2. 跨周期重置：走连接池也不能炸在 conn.query 上 */
test('跨周期：重置成功且不抛错', async () => {
  reset();
  const old = new Date(quota.currentCycleStart().getTime() - 7 * dayMs);
  state.row = {
    uid: 1,
    free_used: 480,
    free_total: 500,
    cycle_start: old,
    paid_balance: 1,
    monthly_until: null,
  };

  const bal = await quota.getBalance(1);

  assert.ok(wrote(/UPDATE quota_account SET free_used = 0/), '跨周期应重置 free_used');
  assert.ok(wrote(/INSERT INTO quota_log/), '跨周期应补一笔流水');
  assert.strictEqual(state.row.cycle_start, toDay(quota.currentCycleStart()));
  assert.strictEqual(state.row.free_used, 0, '重置后已用次数应清零');
  assert.strictEqual(bal.freeLeft, bal.freeTotal, '重置后应满额');
  assert.ok(!state.connUsed);
});

/** 3. 首次访问：自动建账户 */
test('账户不存在：自动建号并返回满额', async () => {
  reset();

  const bal = await quota.getBalance(7);

  assert.ok(wrote(/^INSERT INTO quota_account/), '应插入 quota_account');
  assert.strictEqual(state.row.uid, 7);
  assert.strictEqual(bal.freeLeft, bal.freeTotal);
  assert.ok(!wrote(/INSERT INTO quota_log/), '首次建号不算发放，不写流水');
});

/** 4. 字符串形态的 cycle_start（dateStrings 模式）同样能比较 */
test('cycle_start 为字符串时也能正确判断', async () => {
  reset();
  state.row = {
    uid: 1,
    free_used: 1,
    free_total: 500,
    cycle_start: toDay(quota.currentCycleStart()), // 字符串
    paid_balance: 0,
    monthly_until: null,
  };

  await quota.getBalance(1);
  assert.ok(!wrote(/UPDATE quota_account SET free_used = 0/), '字符串形态同样不应误判跨周期');
});

/** 5. 兜底护栏：连接池必须让 DATE 走字符串，否则比较结果会随部署时区漂移 */
test('连接池配置：DATE 列返回字符串', async () => {
  const src = require('fs').readFileSync(require.resolve('../src/models/db'), 'utf8');
  assert.ok(
    /dateStrings\s*:\s*\[[^\]]*['"]DATE['"]/.test(src),
    "src/models/db.js 必须保留 dateStrings: ['DATE']：否则 mysql2 会把 DATE 解析成 Date，" +
      '与本地时区不一致时日期会偏移一天，免费额度会被反复重置'
  );
});

/** 6. 扣费主路径：走事务、从免费额度扣 1 */
test('扣费：免费额度 -1 并写流水', async () => {
  reset();
  state.row = {
    uid: 1,
    free_used: 0,
    free_total: 20,
    cycle_start: toDay(quota.currentCycleStart()),
    paid_balance: 0,
    monthly_until: null,
  };

  const r = await quota.consume(1, 'hw-1', 'AI 批改消耗');

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.from, 'free');
  assert.strictEqual(state.row.free_used, 1, '免费额度应 +1');
  assert.ok(wrote(/INSERT INTO quota_log/), '扣费必须落流水');
  assert.ok(state.connUsed, '扣费必须走事务连接');
});

/**
 * 7. 线上事故回归：ref_id 超长（'pending-' + 64 位哈希 = 72 字符）
 * 曾经插入超长 → 扣费事务回滚 → 退款用同一个超长号再次失败
 */
test('扣费：ref_id 超长被截断而不是炸掉事务', async () => {
  reset();
  state.row = {
    uid: 1,
    free_used: 0,
    free_total: 20,
    cycle_start: toDay(quota.currentCycleStart()),
    paid_balance: 0,
    monthly_until: null,
  };

  const longRefId = `pending-${'a'.repeat(64)}`; // 72 字符，超过 VARCHAR(64)
  assert.ok(longRefId.length > 64);

  const r = await quota.consume(1, longRefId, 'AI 批改消耗');

  assert.strictEqual(r.ok, true, '超长 ref_id 不应让扣费失败');
  assert.strictEqual(state.row.free_used, 1, '扣费应正常生效');
});

/** 8. 额度不足：抛 QuotaError 4010，前端据此唤起拦截弹层 */
test('额度不足：抛 4010 且不扣费', async () => {
  reset();
  state.row = {
    uid: 1,
    free_used: 20,
    free_total: 20,
    cycle_start: toDay(quota.currentCycleStart()),
    paid_balance: 0,
    monthly_until: null,
  };

  await assert.rejects(
    () => quota.consume(1, 'hw-x', 'AI 批改消耗'),
    (e) => e.code === quota.ERR.INSUFFICIENT,
    '应抛 QuotaError(code=4010)'
  );
  assert.strictEqual(state.row.free_used, 20, '失败路径不应扣费');
  assert.ok(!wrote(/INSERT INTO quota_log/), '不足时不应写扣费流水');
});

/** ── 执行 ──────────────────────────────────────────────── */
(async () => {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      console.log(`  ✓ ${c.name}`);
    } catch (e) {
      failed += 1;
      console.error(`  ✗ ${c.name}\n    ${e.message}`);
    }
  }
  if (failed) {
    console.error(`\n额度服务自测失败：${failed}/${cases.length}`);
    process.exit(1);
  }
  console.log(`额度服务自测通过（${cases.length} 项）`);
})();
