/**
 * MySQL 连接池
 */
const mysql = require('mysql2/promise');
const config = require('../config');
const logger = require('../utils/logger');

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: config.db.connectionLimit,
  queueLimit: 0,
  charset: 'utf8mb4_unicode_ci',
  timezone: '+08:00',
  /**
   * DATE 列（cycle_start / plan_date）按字符串返回 'YYYY-MM-DD'
   *
   * 为什么必须这样：mysql2 默认把 DATE 解析成 JS Date，用的是连接 timezone(+08:00)，
   * 而业务代码比较时用的是进程本地时区。两者只要不一致（比如容器没设 TZ、
   * 或部署在 UTC 机器上），日期就会偏移一天 —— 结果就是每个请求都被判定为
   * “跨周期”，免费额度反复重置（历史事故）。DATE 本身没有时间语义，
   * 直接当字符串处理最稳，DATETIME 仍然按 timezone 解析成 Date。
   */
  dateStrings: ['DATE'],
  // DECIMAL/BIGINT 保持字符串，避免精度丢失
  decimalNumbers: false,
  supportBigNumbers: true,
  bigNumberStrings: true,
});

/** 简单查询（走连接池自动借还） */
async function query(sql, params) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

/** 取连接（需手动 release，事务必须用这个） */
function getConnection() {
  return pool.getConnection();
}

/** 事务包装器 */
async function transaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

/** 健康检查 */
async function ping() {
  const conn = await pool.getConnection();
  try {
    await conn.ping();
    return true;
  } finally {
    conn.release();
  }
}

process.on('SIGTERM', async () => {
  logger.info('收到 SIGTERM，关闭数据库连接池');
  await pool.end();
});

module.exports = { pool, query, getConnection, transaction, ping };
