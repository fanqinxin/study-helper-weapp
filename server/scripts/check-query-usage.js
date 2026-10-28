/**
 * 数据库返回值用法检查
 *
 * 项目里有两套查询入口，返回结构不同，混用会在运行时炸（node --check 查不出来）：
 *
 *   db.query(sql, params)     → 直接返回「行数组」
 *                               SELECT: [{...}, {...}]
 *                               INSERT: OkPacket（有 insertId / affectedRows）
 *                               ✗ 不能写成 const [rows] = await db.query(...)
 *                                 那样拿到的是第一行，rows.length 是 undefined
 *
 *   conn.query(sql, params)   → 原生 mysql2 连接，返回 [rows, fields]
 *                               （db.transaction 回调里的 conn 就是这个）
 *                               ✗ 不能写成 const rows = await conn.query(...)
 *                                 那样拿到的是 [rows, fields]，rows.map 会抛错
 *
 * 曾经的现象：登录接口报 "Cannot read properties of undefined (reading 'length')"，
 * 因为 26 处都多解构了一层，而语法检查一路绿灯。
 *
 * 用法：node scripts/check-query-usage.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [path.join(ROOT, 'src'), path.join(ROOT, 'scripts')];

/** 去掉注释与字符串，避免示例代码被当成真实调用（保留换行，保证行号准确） */
function blank(s) {
  return s.replace(/[^\n]/g, ' ');
}
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => "'" + blank(m.slice(1, -1)) + "'")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => '"' + blank(m.slice(1, -1)) + '"')
    .replace(/`(?:[^`\\]|\\.)*`/g, (m) => '`' + blank(m.slice(1, -1)) + '`');
}

const problems = [];
let files = 0;

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      walk(p);
    } else if (e.name.endsWith('.js')) {
      check(p);
    }
  }
}

function check(file) {
  files += 1;
  const raw = fs.readFileSync(file, 'utf8');
  const src = strip(raw);
  const lines = src.split('\n');
  const rel = path.relative(ROOT, file);

  lines.forEach((line, i) => {
    // db.query 前面出现数组解构 → 多解构一层
    if (/const\s*\[[^\]]*\]\s*=\s*await\s+db\.query\s*\(/.test(line) ||
        /let\s*\[[^\]]*\]\s*=\s*await\s+db\.query\s*\(/.test(line)) {
      problems.push(`${rel}:${i + 1}  db.query 返回行数组，不要解构（应写 const rows = await db.query(...)）`);
    }
    // conn.query 前面没有解构 → 少解构一层
    if (/(?:const|let)\s+[A-Za-z_$][\w$]*\s*=\s*await\s+conn\.query\s*\(/.test(line)) {
      problems.push(`${rel}:${i + 1}  conn.query 返回 [rows, fields]，必须解构（应写 const [rows] = await conn.query(...)）`);
    }
    // 同一函数既收 conn 又收 db（默认参数 = db）→ 两套返回结构会打架
    if (/function\s+[A-Za-z_$][\w$]*\s*\([^)]*\bconn\s*=\s*db\b/.test(line)) {
      problems.push(`${rel}:${i + 1}  函数默认参数写成 conn = db：db.query 与 conn.query 返回结构不同，需在函数内部抹平`);
    }
    // DATE 列直接别名输出 → mysql2 会解析成 Date，JSON 化后变成 UTC 时间串（差 8 小时）
    if (/\b(plan_date|cycle_start)\s+AS\s+/i.test(line) && !/DATE_FORMAT/.test(line)) {
      problems.push(`${rel}:${i + 1}  DATE 列不要直接别名输出，mysql2 会转成 Date（JSON 化后偏移 8 小时），应写 DATE_FORMAT(col, '%Y-%m-%d')`);
    }
  });
}

TARGETS.forEach(walk);

if (problems.length) {
  console.error('数据库返回值用法有误：');
  problems.forEach((p) => console.error('  ✗ ' + p));
  console.error(`\n共 ${problems.length} 处，检查 ${files} 个文件`);
  process.exit(1);
}

console.log(`数据库返回值用法检查通过（${files} 个文件）`);
