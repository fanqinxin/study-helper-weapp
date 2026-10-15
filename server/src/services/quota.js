/**
 * 额度服务 —— 项目的成本闸门
 *
 * 设计要点（务必理解后再改）：
 * 1. 扣减必须原子，用 MySQL 行锁 + 条件更新保证并发安全
 * 2. 扣减必须在任务投递【之前】，绝不能等批改成功再扣
 * 3. 每笔变动都写流水，balance_after 用于对账
 * 4. 批改失败必须退款，且退款只能退一次（靠 ref_id + source 幂等）
 * 5. 免费额度按周期重置，未用完不累积
 */
const db = require('../models/db');
const config = require('../config');
const logger = require('../utils/logger');

/** 额度来源枚举 —— 与 quota_log.source 一致 */
const SOURCE = {
  FREE_CYCLE: 1,
  PURCHASE: 2,
  CONSUME: 3,
  REFUND: 4,
  ADMIN: 5,
};

/** 业务错误码 */
const ERR = {
  INSUFFICIENT: 4010, // 额度不足，前端据此唤起拦截弹层
};

class QuotaError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}

/**
 * 计算本周期起始日（本地日期字符串 YYYY-MM-DD）
 * 默认 7 天一个周期，对齐到周一 00:00
 */
function currentCycleStart(cycleDays = config.quota.cycleDays) {
  const now = new Date();
  const day = now.getDay(); // 0=周日
  // 相对本周一偏移的天数
  const sinceMonday = day === 0 ? 6 : day - 1;
  const start = new Date(now);
  start.setDate(now.getDate() - sinceMonday);
  start.setHours(0, 0, 0, 0);

  // 若周期不是 7 天，按 epoch 天数向前对齐，保证周期边界稳定
  if (cycleDays !== 7) {
    const epochDays = Math.floor(start.getTime() / 86400000);
    const aligned = epochDays - (epochDays % cycleDays);
    return new Date(aligned * 86400000);
  }
  return start;
}

/** Date → YYYY-MM-DD */
function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 获取（或初始化）额度账户
 * 首次访问自动建账户；跨周期自动重置免费次数
 */
async function ensureAccount(uid, conn = db) {
  let [rows] = await conn.query('SELECT * FROM quota_account WHERE uid = ?', [uid]);

  if (!rows.length) {
    const cycleStart = toDateStr(currentCycleStart());
    await conn.query(
      `INSERT INTO quota_account (uid, free_used, free_total, cycle_start, paid_balance)
       VALUES (?, 0, ?, ?, 0)
       ON DUPLICATE KEY UPDATE uid = uid`,
      [uid, config.quota.freeTotal, cycleStart]
    );
    [rows] = await conn.query('SELECT * FROM quota_account WHERE uid = ?', [uid]);
  }

  const acc = rows[0];
  const expectCycle = toDateStr(currentCycleStart());

  // 跨周期：重置免费已用次数，并补一笔流水便于追溯
  if (acc.cycle_start !== expectCycle) {
    await conn.query(
      `UPDATE quota_account
         SET free_used = 0, cycle_start = ?, free_total = ?
       WHERE uid = ?`,
      [expectCycle, config.quota.freeTotal, uid]
    );
    await writeLog(conn, {
      uid,
      change: config.quota.freeTotal,
      source: SOURCE.FREE_CYCLE,
      refId: expectCycle,
      balanceAfter: config.quota.freeTotal + acc.paid_balance,
      remark: '新周期免费额度发放',
    });
    logger.info({ uid, cycle: expectCycle }, '免费额度周期重置');
    acc.free_used = 0;
    acc.cycle_start = expectCycle;
    acc.free_total = config.quota.freeTotal;
  }

  return acc;
}

/** 写额度流水（内部使用，必须有 conn） */
async function writeLog(conn, { uid, change, source, refId, balanceAfter, remark }) {
  await conn.query(
    `INSERT INTO quota_log (uid, \`change\`, source, ref_id, balance_after, remark)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [uid, change, source, refId || null, balanceAfter, remark || null]
  );
}

/** 判断月卡是否有效 */
function isMonthlyValid(acc) {
  return !!(acc.monthly_until && new Date(acc.monthly_until) > new Date());
}

/** 查询余额（只读，不产生副作用之外的写操作） */
async function getBalance(uid) {
  const acc = await ensureAccount(uid);
  const monthly = isMonthlyValid(acc);
  const freeLeft = Math.max(0, acc.free_total - acc.free_used);
  const nextReset = new Date(currentCycleStart());
  nextReset.setDate(nextReset.getDate() + config.quota.cycleDays);

  return {
    freeLeft,
    freeTotal: acc.free_total,
    freeUsed: acc.free_used,
    paidBalance: acc.paid_balance,
    monthly,
    monthlyUntil: acc.monthly_until,
    // 月卡有效视为不限
    totalLeft: monthly ? -1 : freeLeft + acc.paid_balance,
    nextResetAt: nextReset.toISOString(),
    // 是否紧张（前端据此提前提示）
    low: !monthly && freeLeft + acc.paid_balance <= config.quota.warnThreshold,
  };
}

/**
 * 原子扣减一次额度。
 *
 * 顺序：优先扣免费额度，再扣付费余额；月卡有效则直接放行。
 * 使用事务 + 行锁，保证并发下不超发。
 *
 * @returns {Promise<{ok:boolean, from:string, balance:object}>}
 * @throws {QuotaError} code=4010 时表示额度不足
 */
async function consume(uid, refId, remark = 'AI 批改消耗') {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    await ensureAccount(uid, conn);

    // 行锁，防止并发扣减超发
    const [rows] = await conn.query(
      'SELECT * FROM quota_account WHERE uid = ? FOR UPDATE',
      [uid]
    );
    const acc = rows[0];

    let from = null;

    if (isMonthlyValid(acc)) {
      from = 'monthly';
    } else if (acc.free_used < acc.free_total) {
      from = 'free';
      await conn.query(
        'UPDATE quota_account SET free_used = free_used + 1 WHERE uid = ?',
        [uid]
      );
    } else if (acc.paid_balance > 0) {
      from = 'paid';
      await conn.query(
        'UPDATE quota_account SET paid_balance = paid_balance - 1 WHERE uid = ?',
        [uid]
      );
    } else {
      // 额度不足：回滚并抛出可识别的错误
      await conn.rollback();
      const bal = await getBalance(uid);
      throw new QuotaError(ERR.INSUFFICIENT, '本周免费额度已用完');
    }

    const balanceAfter = isMonthlyValid(acc)
      ? -1
      : Math.max(0, acc.free_total - (acc.free_used + (from === 'free' ? 1 : 0)))
        + (from === 'paid' ? acc.paid_balance - 1 : acc.paid_balance);

    await writeLog(conn, {
      uid,
      change: -1,
      source: SOURCE.CONSUME,
      refId,
      balanceAfter: from === 'monthly' ? -1 : balanceAfter,
      remark,
    });

    await conn.commit();
    logger.info({ uid, refId, from }, '额度扣减成功');
    return { ok: true, from, balance: await getBalance(uid) };
  } catch (e) {
    if (!(e instanceof QuotaError)) {
      await conn.rollback().catch(() => {});
    }
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * 退还额度（批改失败时调用）
 * 幂等：同一 refId 的退款只生效一次
 */
async function refund(uid, refId, remark = '批改失败退还') {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 幂等检查：该 refId 是否已退过
    const [existed] = await conn.query(
      'SELECT id FROM quota_log WHERE uid = ? AND ref_id = ? AND source = ? LIMIT 1',
      [uid, refId, SOURCE.REFUND]
    );
    if (existed.length) {
      await conn.rollback();
      logger.warn({ uid, refId }, '重复退款请求已忽略');
      return { ok: true, duplicated: true };
    }

    const [rows] = await conn.query(
      'SELECT * FROM quota_account WHERE uid = ? FOR UPDATE',
      [uid]
    );
    if (!rows.length) {
      await conn.rollback();
      return { ok: false, msg: '账户不存在' };
    }
    const acc = rows[0];

    // 原路退回：免费额度没超上限就退免费，否则退付费余额
    if (acc.free_used > 0 && acc.free_used <= acc.free_total) {
      await conn.query(
        'UPDATE quota_account SET free_used = GREATEST(0, free_used - 1) WHERE uid = ?',
        [uid]
      );
    } else {
      await conn.query(
        'UPDATE quota_account SET paid_balance = paid_balance + 1 WHERE uid = ?',
        [uid]
      );
    }

    await writeLog(conn, {
      uid,
      change: 1,
      source: SOURCE.REFUND,
      refId,
      balanceAfter: Math.max(0, acc.free_total - Math.max(0, acc.free_used - 1)) + acc.paid_balance,
      remark,
    });

    await conn.commit();
    logger.info({ uid, refId }, '额度已退还');
    return { ok: true };
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * 购买到账（仅由支付回调调用，绝不信任前端）
 */
async function grant(uid, { orderNo, quota, monthlyDays = 0, remark = '购买加油包' }) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await ensureAccount(uid, conn);

    const [rows] = await conn.query(
      'SELECT * FROM quota_account WHERE uid = ? FOR UPDATE',
      [uid]
    );
    const acc = rows[0];

    let balanceAfter;
    if (monthlyDays > 0) {
      // 月卡：叠加有效期（续费时从当前有效期往后加）
      const base = isMonthlyValid(acc) ? new Date(acc.monthly_until) : new Date();
      base.setDate(base.getDate() + monthlyDays);
      await conn.query(
        'UPDATE quota_account SET monthly_until = ? WHERE uid = ?',
        [base, uid]
      );
      balanceAfter = -1;
    } else {
      await conn.query(
        'UPDATE quota_account SET paid_balance = paid_balance + ? WHERE uid = ?',
        [quota, uid]
      );
      balanceAfter = acc.paid_balance + quota;
    }

    await writeLog(conn, {
      uid,
      change: monthlyDays > 0 ? 0 : quota,
      source: SOURCE.PURCHASE,
      refId: orderNo,
      balanceAfter,
      remark,
    });

    await conn.commit();
    logger.info({ uid, orderNo, quota, monthlyDays }, '额度到账');
    return { ok: true };
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

/** 额度流水查询 */
async function getLogs(uid, { page = 1, size = 20 } = {}) {
  const offset = (page - 1) * size;
  const [rows] = await db.query(
    `SELECT \`change\`, source, ref_id AS refId, balance_after AS balanceAfter,
            remark, created_at AS createdAt
       FROM quota_log WHERE uid = ?
      ORDER BY id DESC LIMIT ? OFFSET ?`,
    [uid, Number(size), Number(offset)]
  );
  return rows;
}

module.exports = {
  SOURCE,
  ERR,
  QuotaError,
  getBalance,
  consume,
  refund,
  grant,
  getLogs,
  currentCycleStart,
};
