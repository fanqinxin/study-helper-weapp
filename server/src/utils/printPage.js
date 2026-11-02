/**
 * 打印页 HTML 渲染
 *
 * 目标是"家长在电脑浏览器打开 → Ctrl+P 直接能打"：
 *   - A4 版心、黑白友好（不依赖彩色/背景色，避免打印时被浏览器去掉）
 *   - 题目留作答空间；答案放在最后一页，页脚提示裁剪
 *   - 所有 AI 生成的文本必须 escapeHtml —— 它们不是可信内容
 */

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

const BASE_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "PingFang SC", "Microsoft YaHei", "SimSun", sans-serif; color: #1a1a1a; }
  .page { max-width: 186mm; margin: 0 auto; padding: 12mm 6mm; }
  h1 { font-size: 20pt; text-align: center; letter-spacing: 2px; }
  .meta { text-align: center; color: #666; font-size: 10pt; margin: 6px 0 18px; }
  .note { background: #f5f5f5; border: 1px dashed #999; border-radius: 6px; padding: 8px 12px; font-size: 10.5pt; margin-bottom: 14px; }
  .group { margin-bottom: 14px; page-break-inside: avoid; }
  .group-title { font-weight: 700; font-size: 12pt; margin-bottom: 6px; }
  .row { display: flex; align-items: flex-start; padding: 5px 0; border-bottom: 1px solid #eee; font-size: 11pt; line-height: 1.55; }
  .box { flex: 0 0 auto; width: 14px; height: 14px; border: 1.5px solid #333; border-radius: 3px; margin: 3px 8px 0 0; }
  .row .content { flex: 1; }
  .q { margin-bottom: 14px; page-break-inside: avoid; }
  .q .stem { font-size: 11.5pt; line-height: 1.6; font-weight: 600; }
  .q .stem .blank { font-family: monospace; letter-spacing: 4px; }
  .q .opts { margin: 6px 0 0 22px; font-size: 11pt; line-height: 1.8; }
  .q .answer-line { margin-top: 8px; color: #444; font-size: 10.5pt; }
  .answer-page { page-break-before: always; }
  .answer-page h2 { font-size: 14pt; margin-bottom: 4px; }
  .cut-hint { text-align: center; color: #999; font-size: 9pt; margin-bottom: 10px; }
  .ans-row { font-size: 10.5pt; line-height: 1.7; border-bottom: 1px solid #eee; padding: 4px 0; }
  .foot { margin-top: 22px; text-align: center; color: #aaa; font-size: 8.5pt; }
  @media print {
    .page { padding: 0; }
    a { text-decoration: none; color: inherit; }
  }
  @page { size: A4; margin: 14mm 12mm; }
`;

function wrapPage(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${BASE_CSS}</style>
</head>
<body><div class="page">${bodyHtml}
<div class="foot">由 同步学习小程序 生成 · 打印后可直接使用</div>
</div></body></html>`;
}

/**
 * 练习题打印页：题目 + 作答括号，答案放最后一页（家长裁剪）
 */
function renderPracticePrint(lesson, questions) {
  const title = `${lesson.textbookName || ''} · 第${lesson.seq}课 ${lesson.title}`.trim();
  const rows = questions
    .map((q, i) => {
      const opts = (q.options || [])
        .map((o, j) => `<div>${LETTERS[j] || j + 1}. ${escapeHtml(o)}</div>`)
        .join('');
      return `<div class="q">
  <div class="stem">${i + 1}. ${escapeHtml(q.stem)} <span class="blank">（&nbsp;&nbsp;&nbsp;&nbsp;）</span></div>
  ${opts ? `<div class="opts">${opts}</div>` : ''}
</div>`;
    })
    .join('\n');

  const answers = questions
    .map(
      (q, i) => `<div class="ans-row"><b>${i + 1}.</b> ${escapeHtml(q.answer)}${
        q.analysis ? ` — ${escapeHtml(q.analysis)}` : ''
      }</div>`
    )
    .join('\n');

  const body = `
<h1>${escapeHtml(lesson.title)}</h1>
<div class="meta">${escapeHtml(lesson.textbookName || '')} · 第 ${Number(lesson.seq)} 课 · 共 ${questions.length} 题 · 姓名：＿＿＿＿＿＿</div>
${rows}
<div class="answer-page">
  <h2>参考答案</h2>
  <div class="cut-hint">↑ 沿此页上方裁开，把答案页留给家长批改</div>
  ${answers}
</div>`;
  return wrapPage(`${title} 练习题`, body);
}

/**
 * 作业任务单打印页：闯关清单样式（□ 逐项打勾）
 */
function renderAssignmentPrint(assignment, items) {
  const subjectOrder = [0, 1, 2, 3, 4];
  const subjectTitle = { 0: '每日必做', 1: '语文闯关', 2: '数学闯关', 3: '英语闯关', 4: '其他任务' };
  const groups = subjectOrder
    .map((s) => ({ subject: s, items: items.filter((it) => Number(it.subject) === s) }))
    .filter((g) => g.items.length)
    .map(
      (g) => `<div class="group">
  <div class="group-title">【${subjectTitle[g.subject]}】</div>
  ${g.items
    .map(
      (it) => `<div class="row"><span class="box"></span><span class="content">${escapeHtml(it.content)}</span></div>`
    )
    .join('\n')}
</div>`
    )
    .join('\n');

  const done = items.filter((it) => Number(it.done) === 1).length;
  const title = assignment.title || `${assignment.taskDate} 闯关任务`;
  const body = `
<h1>${escapeHtml(title)}</h1>
<div class="meta">${escapeHtml(assignment.taskDate)} · 每完成一项打个勾，全部完成 = 闯关成功！</div>
${assignment.note ? `<div class="note">老师提醒：${escapeHtml(assignment.note)}</div>` : ''}
${groups}
<div class="note">完成情况：${done} / ${items.length} 项（打印时为当前进度）</div>`;
  return wrapPage(title, body);
}

module.exports = { renderPracticePrint, renderAssignmentPrint };
