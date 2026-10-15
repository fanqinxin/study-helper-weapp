/**
 * 图片上传中间件
 *
 * 设计取舍：
 * - 生产环境建议走对象存储（OSS/COS）直传，服务端只签发凭证；
 *   这里提供的是"服务端中转"的完整可用实现，便于本地与早期上线。
 * - 只接受图片类型，限制单文件体积，文件名随机化防目录穿越。
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');
const { uploadDir, publicPrefix } = require('./storage');

// 确保目录存在
fs.mkdirSync(uploadDir, { recursive: true });

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

const storage = multer.diskStorage({
  destination(req, file, cb) {
    // 按天分目录，避免单目录文件过多
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(uploadDir, day);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    // 随机文件名，保留扩展名；绝不使用用户提供的原始名
    const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
    const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.heic'].includes(ext) ? ext : '.jpg';
    cb(null, `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${safeExt}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: config.upload.maxSizeMb * 1024 * 1024,
    files: 1,
  },
  fileFilter(req, file, cb) {
    if (!ALLOWED.includes(file.mimetype)) {
      const e = new Error('只支持 JPG / PNG / WEBP 格式的图片');
      e.code = 4000;
      return cb(e);
    }
    cb(null, true);
  },
});

/** 把 multer 的错误转成统一业务错误 */
function singleUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    const e = new Error(
      err.code === 'LIMIT_FILE_SIZE'
        ? `图片不能超过 ${config.upload.maxSizeMb}MB，请压缩后再试`
        : err.message || '上传失败'
    );
    e.code = 4000;
    next(e);
  });
}

/** 由磁盘路径生成对外可访问 URL */
function toPublicUrl(file) {
  const rel = path.relative(uploadDir, file.path).split(path.sep).join('/');
  return `${publicPrefix}/${rel}`;
}

module.exports = { singleUpload, toPublicUrl, uploadDir };
