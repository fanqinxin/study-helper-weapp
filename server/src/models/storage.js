/**
 * 存储路径配置
 *
 * 本地存储只用于开发与早期上线。
 * 需要更高可用时，把 upload.js 换成对象存储直传即可，
 * 业务侧只依赖 toPublicUrl() 返回的地址，无需改动。
 */
const path = require('path');

/** 磁盘根目录（server/uploads） */
const uploadDir = path.resolve(__dirname, '../../uploads');

/** 对外访问前缀，与 app.js 中 express.static 挂载点保持一致 */
const publicPrefix = '/static/uploads';

module.exports = { uploadDir, publicPrefix };
