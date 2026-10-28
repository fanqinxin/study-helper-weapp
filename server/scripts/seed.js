#!/usr/bin/env node
/**
 * 教材种子数据灌库
 *
 * 为什么单独做脚本而不是写死在 schema.sql：
 *   教材内容是运营数据，会随教材修订反复变；表结构才需要进迁移。
 *   内容放 JSON，改内容不用碰代码，也不用改表。
 *
 * 用法：
 *   node scripts/seed.js                      灌 data/textbook 下全部数据
 *   node scripts/seed.js bnu-chinese-g1-v1    只灌指定文件（不含 .json 后缀）
 *   node scripts/seed.js --dry-run            只校验数据，不连库、不写库
 *   node scripts/seed.js --reset              先清掉该教材的课文与题库再重建
 *
 * 幂等性：
 *   教材按 (name, subject, grade, volume) 匹配；课文按 (textbook_id, seq)；
 *   题目按 (lesson_id, stem)。重复执行只会更新，不会产生重复数据。
 *
 * 注意：--reset 会删除该教材下所有 lesson / question。
 *       用户表只记录 textbook_id 与 lesson_progress（整数），不受影响。
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data', 'textbook');
const SUBJECT_NAME = { 1: '语文', 2: '数学', 3: '英语' };
const TYPE_NAME = { 1: '单选', 2: '填空', 3: '阅读理解', 4: '计算' };
const MAX_QUESTIONS_PER_LESSON = 10;

// ------------------------------------------------------------
// 参数
// ------------------------------------------------------------
function parseArgs(argv) {
  const opts = { reset: false, dryRun: false, files: [] };
  for (const a of argv) {
    if (a === '--reset') opts.reset = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '-h' || a === '--help') {
      console.log('用法: node scripts/seed.js [文件名...] [--reset] [--dry-run]');
      process.exit(0);
    } else if (a.startsWith('-')) {
      console.error(`未知参数: ${a}`);
      process.exit(1);
    } else {
      opts.files.push(a.replace(/\.json$/, ''));
    }
  }
  return opts;
}

// ------------------------------------------------------------
// 数据校验
// 这里宁可报错也不静默跳过：种子数据错了，线上孩子会看到错题。
// ------------------------------------------------------------
function validateBook(book, file) {
  const errors = [];
  const at = (msg) => errors.push(`[${file}] ${msg}`);

  if (!book || typeof book !== 'object') return ['文件不是合法的 JSON 对象'];
  if (!book.name || typeof book.name !== 'string') at('缺少 name（教材名，如「北师大版」）');
  if (![1, 2, 3].includes(book.subject)) at('subject 必须是 1(语文) / 2(数学) / 3(英语)');
  if (!Number.isInteger(book.grade) || book.grade < 1 || book.grade > 6) at('grade 必须是 1-6 的整数');
  if (![1, 2].includes(book.volume)) at('volume 必须是 1(上册) / 2(下册)');
  if (!Array.isArray(book.lessons) || !book.lessons.length) return errors.concat(`[${file}] lessons 不能为空`);

  const seenSeq = new Set();
  book.lessons.forEach((l, i) => {
    const tag = `lessons[${i}]${l && l.title ? `(${l.title})` : ''}`;
    if (!l || typeof l !== 'object') return at(`${tag} 不是对象`);
    if (!Number.isInteger(l.seq) || l.seq < 1) at(`${tag} seq 必须是正整数`);
    else if (seenSeq.has(l.seq)) at(`${tag} seq ${l.seq} 重复`);
    else seenSeq.add(l.seq);
    if (!l.title || typeof l.title !== 'string') at(`${tag} 缺少 title`);
    if (l.unit != null && typeof l.unit !== 'string') at(`${tag} unit 必须是字符串`);
    if (l.knowledgePoints != null && !Array.isArray(l.knowledgePoints)) at(`${tag} knowledgePoints 必须是数组`);

    if (!Array.isArray(l.questions) || !l.questions.length) return at(`${tag} 至少要有 1 道题`);
    if (l.questions.length > MAX_QUESTIONS_PER_LESSON) at(`${tag} 题目超过 ${MAX_QUESTIONS_PER_LESSON} 道`);

    const seenStem = new Set();
    l.questions.forEach((q, j) => {
      const qtag = `${tag} questions[${j}]`;
      if (!q || typeof q !== 'object') return at(`${qtag} 不是对象`);
      if (![1, 2, 3, 4].includes(q.type)) at(`${qtag} type 必须是 1-4`);
      if (!q.stem || typeof q.stem !== 'string') at(`${qtag} 缺少 stem（题干）`);
      else if (seenStem.has(q.stem)) at(`${qtag} 题干重复（会导致幂等更新命中错题）`);
      else seenStem.add(q.stem);
      if (q.answer == null || String(q.answer).trim() === '') at(`${qtag} 缺少 answer`);
      if (q.difficulty != null && ![1, 2, 3].includes(q.difficulty)) at(`${qtag} difficulty 必须是 1-3`);

      if (q.type === 1) {
        if (!Array.isArray(q.options) || q.options.length < 2) {
          at(`${qtag} 单选题必须有 2 个以上选项`);
        } else {
          const opts = q.options.map((o) => String(o).trim());
          if (opts.some((o) => !o)) at(`${qtag} 存在空选项`);
          if (new Set(opts).size !== opts.length) at(`${qtag} 选项重复`);
          // 判分是拿"选项原文"做精确比对，答案必须是选项之一
          if (!opts.includes(String(q.answer).trim())) {
            at(`${qtag} answer「${q.answer}」不在选项中，判分将永远失败`);
          }
        }
      } else if (q.options != null) {
        at(`${qtag} 非单选题目不应带 options（前端会渲染成选项）`);
      }
    });
  });

  return errors;
}

// ------------------------------------------------------------
// 写库
// ------------------------------------------------------------
async function seedBook(conn, book, opts) {
  const stat = { action: '', textbookId: null, lessons: 0, questions: 0, removedLessons: 0 };

  const [exist] = await conn.query(
    `SELECT id FROM textbook
      WHERE name = ? AND subject = ? AND grade = ? AND volume = ? AND is_custom = 0
      LIMIT 1`,
    [book.name, book.subject, book.grade, book.volume]
  );

  if (exist.length) {
    stat.textbookId = Number(exist[0].id);
    stat.action = 'update';
    await conn.query('UPDATE textbook SET status = 1 WHERE id = ?', [stat.textbookId]);
  } else {
    const [res] = await conn.query(
      `INSERT INTO textbook (name, subject, grade, volume, is_custom, owner_uid, status)
       VALUES (?, ?, ?, ?, 0, NULL, 1)`,
      [book.name, book.subject, book.grade, book.volume]
    );
    stat.textbookId = Number(res.insertId);
    stat.action = 'insert';
  }

  if (opts.reset) {
    const [old] = await conn.query('SELECT id FROM lesson WHERE textbook_id = ?', [stat.textbookId]);
    if (old.length) {
      const ids = old.map((r) => r.id);
      await conn.query('DELETE FROM question WHERE lesson_id IN (?)', [ids]);
      await conn.query('DELETE FROM lesson WHERE id IN (?)', [ids]);
      stat.removedLessons = ids.length;
    }
  }

  for (const l of book.lessons) {
    const kp = JSON.stringify(l.knowledgePoints || []);
    const [row] = await conn.query(
      'SELECT id FROM lesson WHERE textbook_id = ? AND seq = ? LIMIT 1',
      [stat.textbookId, l.seq]
    );

    let lessonId;
    if (row.length) {
      lessonId = Number(row[0].id);
      await conn.query(
        'UPDATE lesson SET title = ?, unit = ?, knowledge_points = ? WHERE id = ?',
        [l.title, l.unit || null, kp, lessonId]
      );
    } else {
      const [res] = await conn.query(
        `INSERT INTO lesson (textbook_id, seq, title, unit, knowledge_points)
         VALUES (?, ?, ?, ?, ?)`,
        [stat.textbookId, l.seq, l.title, l.unit || null, kp]
      );
      lessonId = Number(res.insertId);
    }
    stat.lessons += 1;

    for (const q of l.questions) {
      const options = q.type === 1 ? JSON.stringify(q.options.map((o) => String(o))) : null;
      const [existQ] = await conn.query(
        'SELECT id FROM question WHERE lesson_id = ? AND stem = ? LIMIT 1',
        [lessonId, q.stem]
      );
      if (existQ.length) {
        await conn.query(
          `UPDATE question SET type = ?, options = ?, answer = ?, analysis = ?, difficulty = ?
            WHERE id = ?`,
          [q.type, options, String(q.answer), q.analysis || null, q.difficulty || 2, existQ[0].id]
        );
      } else {
        await conn.query(
          `INSERT INTO question (lesson_id, type, stem, options, answer, analysis, difficulty)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [lessonId, q.type, q.stem, options, String(q.answer), q.analysis || null, q.difficulty || 2]
        );
      }
      stat.questions += 1;
    }
  }

  return stat;
}

// ------------------------------------------------------------
// 主流程
// ------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(DATA_DIR)) {
    console.error(`数据目录不存在: ${DATA_DIR}`);
    process.exit(1);
  }

  let files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).sort();
  if (opts.files.length) {
    files = files.filter((f) => opts.files.includes(f.replace(/\.json$/, '')));
    const missing = opts.files.filter((n) => !files.includes(n + '.json'));
    if (missing.length) {
      console.error(`找不到数据文件: ${missing.join(', ')}（应位于 ${DATA_DIR}）`);
      process.exit(1);
    }
  }
  if (!files.length) {
    console.error('没有可灌的数据文件');
    process.exit(1);
  }

  // ---- 先全部校验，全部通过才写库 ----
  const books = [];
  let errorCount = 0;
  for (const f of files) {
    const full = path.join(DATA_DIR, f);
    let book;
    try {
      book = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (e) {
      console.error(`[${f}] JSON 解析失败: ${e.message}`);
      errorCount += 1;
      continue;
    }
    const errors = validateBook(book, f);
    if (errors.length) {
      errors.forEach((m) => console.error('  ' + m));
      errorCount += errors.length;
      continue;
    }
    const qTotal = book.lessons.reduce((n, l) => n + l.questions.length, 0);
    console.log(
      `校验通过  ${f}  ${book.name}·${SUBJECT_NAME[book.subject]}${book.grade}年级${
        book.volume === 1 ? '上册' : '下册'
      }  ${book.lessons.length} 课 / ${qTotal} 题`
    );
    books.push({ file: f, book });
  }

  if (errorCount) {
    console.error(`\n共 ${errorCount} 处数据问题，已中止，未写入任何数据。`);
    process.exit(1);
  }

  if (opts.dryRun) {
    console.log('\n--dry-run：校验全部通过，未连接数据库。');
    return;
  }

  const db = require('../src/models/db');
  const summary = [];

  try {
    for (const { file, book } of books) {
      const stat = await db.transaction((conn) => seedBook(conn, book, opts));
      summary.push({ file, ...stat, name: book.name });
      console.log(
        `已写入  ${file}  教材#${stat.textbookId} (${stat.action})  ` +
          `课文 ${stat.lessons}  题目 ${stat.questions}` +
          (stat.removedLessons ? `  清理旧课文 ${stat.removedLessons}` : '')
      );
    }
  } catch (e) {
    console.error('\n写入失败，事务已回滚:', e.message);
    if (e.code) console.error('错误码:', e.code);
    await db.pool.end().catch(() => {});
    process.exit(1);
  }

  console.log(`\n完成：${summary.length} 套教材，` +
    `${summary.reduce((n, s) => n + s.lessons, 0)} 篇课文，` +
    `${summary.reduce((n, s) => n + s.questions, 0)} 道题。`);
  await db.pool.end().catch(() => {});
}

main().catch((e) => {
  console.error('未捕获异常:', e);
  process.exit(1);
});
