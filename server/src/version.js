/**
 * 部署版本与能力清单
 *
 * 为什么要这个文件：
 *   线上多次出现「小程序已经按新接口调用，服务端还是老镜像」的情况，
 *   表现是接口回老文案（比如粘贴了作业文字，却提示"请先上传作业截图"），
 *   从日志上看不出版本差异，只能靠猜。
 *
 * 处理方式：
 *   /api/v1/health 里带 version + features，一条 curl 就能确认容器跑的是哪一版代码。
 *   小程序端也用它做一次静默探测，服务端过旧时直接在页面上提示，而不是让用户
 *   以为是自己操作错了。
 *
 * 约定：新增能力往 FEATURES 里加一条，向前兼容，不要删旧的（老客户端还在探测）。
 */
const pkg = require('../package.json');

const FEATURES = [
  'assignment.text',   // 今日作业：支持粘贴文字提交（不只是拍照）
  'assignment.photo',  // 今日作业：截图识别
  'practice.count',    // 出题可选 5/10/15/20
  'practice.force',    // 同一课可重新出题（覆盖旧的）
  'practice.print',    // 练习题导出打印链接
  'lesson.current',    // 可设置当前学到哪一课
];

module.exports = {
  version: pkg.version,
  features: FEATURES,
};
