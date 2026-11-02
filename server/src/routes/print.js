/**
 * 打印页路由（浏览器直接访问，无小程序登录态）
 *
 * 访问凭证是 HMAC 短期签名 token（utils/printToken.js），
 * 由小程序内"导出打印"接口换取。链接 7 天有效。
 */
const express = require('express');
const db = require('../models/db');
const { verifyPrintToken } = require('../utils/printToken');
const { renderPracticePrint, renderAssignmentPrint } = require('../utils/printPage');

const router = express.Router();

function sendHtml(res, html) {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'private, max-age=300');
  res.send(html);
}

function denied(res) {
  res.status(403).set('Content-Type', 'text/html; charset=utf-8').send(
    '<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;padding-top:80px;color:#666"><h3>打印链接无效或已过期</h3><p>请回到小程序重新点击「导出打印」获取新链接。</p></body></html>'
  );
}

/** 练习题打印页 */
router.get('/print/practice/:lessonId', async (req, res) => {
  const lessonId = Number(req.params.lessonId);
  if (!Number.isInteger(lessonId) || lessonId <= 0) return denied(res);
  if (!verifyPrintToken(req.query.token, 'practice', lessonId)) return denied(res);

  const lessons = await db.query(
    `SELECT l.id, l.seq, l.title, t.name AS textbookName
       FROM lesson l JOIN textbook t ON t.id = l.textbook_id
      WHERE l.id = ?`,
    [lessonId]
  );
  if (!lessons.length) return denied(res);

  const questions = await db.query(
    'SELECT stem, options, answer, analysis FROM question WHERE lesson_id = ? ORDER BY id ASC',
    [lessonId]
  );
  if (!questions.length) return denied(res);

  const lesson = lessons[0];
  sendHtml(
    res,
    renderPracticePrint(
      { ...lesson, seq: Number(lesson.seq) },
      questions.map((q) => ({
        stem: q.stem,
        options: q.options ? (typeof q.options === 'string' ? JSON.parse(q.options) : q.options) : [],
        answer: q.answer,
        analysis: q.analysis,
      }))
    )
  );
});

/** 作业任务单打印页（闯关清单） */
router.get('/print/assignment/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return denied(res);
  if (!verifyPrintToken(req.query.token, 'assignment', id)) return denied(res);

  const rows = await db.query(
    'SELECT id, task_date, title, note, status FROM assignment WHERE id = ?',
    [id]
  );
  if (!rows.length) return denied(res);
  const row = rows[0];

  const items = await db.query(
    'SELECT subject, content, done FROM assignment_item WHERE assignment_id = ? ORDER BY sort ASC, id ASC',
    [id]
  );
  if (!items.length) return denied(res);

  sendHtml(
    res,
    renderAssignmentPrint(
      {
        taskDate: typeof row.task_date === 'string' ? row.task_date : String(row.task_date).slice(0, 10),
        title: row.title,
        note: row.note,
      },
      items
    )
  );
});

module.exports = router;
