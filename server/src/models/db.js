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
