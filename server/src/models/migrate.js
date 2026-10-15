/**
 * 数据库迁移
 *
 * 执行：npm run migrate
 * 作用：读取 sql/schema.sql 并逐条执行（幂等，可重复运行）。
 *
 * 为什么不用现成迁移工具：本项目表结构稳定、无多人并行改动，
 * 一个自包含脚本更透明，排查问题不需要额外知识。
 *
 * 关于 CREATE DATABASE：
 * container 部署时应用账号（DB_USER）通常没有建库权限，库由 MySQL 容器
 * 的 MYSQL_DATABASE 提前创建好。所以这里把建库失败降级为警告——
 * 真正重要的是 USE `库名` 之后能建表。
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('./../config');
const logger = require('../utils/logger');

const SCHEMA_FILE = path.resolve(__dirname, '../../sql/schema.sql');

/** 按分号切分，跳过注释与空行 */
function splitStatements(sql) {
  return sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line)) // 去掉纯注释行
    .join('\n')
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 库名做白名单校验，防注入（库名不能参数化，只能拼字符串） */
function safeDbName(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`DB_NAME 含非法字符，只允许字母、数字、下划线: ${name}`);
  }
  return name;
}

/** 建库失败（权限不足/已存在）可忽略，其他错误照抛 */
function isIgnorableCreateDbError(e) {
  return (
    e.code === 'ER_DBACCESS_DENIED_ERROR' || // 无建库权限，库已由运维/容器创建
    e.code === 'ER_DB_CREATE_EXISTS' || // 库已存在
    e.code === 'ER_ACCESS_DENIED_ERROR' || // 账号无全局权限
    e.code === 'ER_TABLEACCESS_DENIED_ERROR'
  );
}

async function migrate() {
  if (!fs.existsSync(SCHEMA_FILE)) {
    throw new Error(`找不到 schema 文件: ${SCHEMA_FILE}`);
  }

  const dbName = safeDbName(config.db.database);
  const raw = fs.readFileSync(SCHEMA_FILE, 'utf8');
  // 占位符替换为实际库名，避免 schema 里写死库名
  const sql = raw.replace(/__DB_NAME__/g, dbName);
  const statements = splitStatements(sql);

  // 连接时指定 database：这样即使没有建库权限也能正确切换到目标库
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: dbName,
    multipleStatements: false,
  });

  logger.info(
    { count: statements.length, file: SCHEMA_FILE, database: dbName },
    '开始执行数据库迁移'
  );

  let ok = 0;
  for (const stmt of statements) {
    const brief = stmt.replace(/\s+/g, ' ').slice(0, 70);
    try {
      await conn.query(stmt);
      ok += 1;
      logger.info(`  ✓ ${brief}`);
    } catch (e) {
      // 建库语句失败是预期内的（容器已建好库且应用账号无权限），降级为提示
      if (/^\s*CREATE\s+DATABASE/i.test(stmt) && isIgnorableCreateDbError(e)) {
        logger.info(`  · ${brief} —— 跳过（库已由容器/运维创建）`);
        continue;
      }
      // 表已存在等非致命错误允许跳过，但必须打印出来
      logger.warn({ err: e.message }, `  ! ${brief}`);
    }
  }

  await conn.end();
  logger.info({ ok, total: statements.length }, '数据库迁移完成');
}

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch((e) => {
      logger.error({ err: e.message }, '数据库迁移失败');
      process.exit(1);
    });
}

module.exports = { migrate, splitStatements, safeDbName };
