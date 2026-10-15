/**
 * 图片处理工具
 *
 * 成本控制关键：小学生作业照片普遍 3-5MB，
 * 直传又慢又贵。上传前统一压到 1MB / 长边 1600px 以内，
 * 单次批改成本能降 60% 以上。
 */

const config = require('../config/index');

/** 获取图片信息 */
function getImageInfo(src) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({ src, success: resolve, fail: reject });
  });
}

/** 压缩单张图片 */
function compressOne(src) {
  return new Promise(async (resolve) => {
    try {
      const info = await getImageInfo(src);
      const { width, height } = info;

      // 长边超过上限则等比缩放
      const maxSide = Math.max(width, height);
      const scale = maxSide > config.imageMaxWidth ? config.imageMaxWidth / maxSide : 1;

      const args = { src, quality: 80 };
      if (scale < 1) {
        args.compressedWidth = Math.round(width * scale);
        args.compressedHeight = Math.round(height * scale);
      }

      wx.compressImage({
        ...args,
        success: (res) => resolve(res.tempFilePath),
        // 压缩失败不阻断流程，退回原图
        fail: () => resolve(src),
      });
    } catch (e) {
      resolve(src);
    }
  });
}

/**
 * 批量压缩
 * @param {string[]} paths 原图临时路径
 * @returns {Promise<string[]>} 压缩后路径
 */
async function compressImages(paths) {
  const results = [];
  for (const p of paths) {
    results.push(await compressOne(p));
  }
  return results;
}

/** 读取文件大小（字节） */
function getFileSize(filePath) {
  return new Promise((resolve) => {
    wx.getFileSystemManager().getFileInfo({
      filePath,
      success: (res) => resolve(res.size),
      fail: () => resolve(0),
    });
  });
}

/** 人类可读大小 */
function formatSize(bytes) {
  if (!bytes) return '0KB';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 从相册/相机选图并压缩
 * @param {number} count 最多可选张数
 */
function chooseImages(count = 1) {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      sizeType: ['compressed'], // 先用微信自带压缩
      camera: 'back',
      success: async (res) => {
        const paths = res.tempFiles.map((f) => f.tempFilePath);
        const compressed = await compressImages(paths);
        resolve(compressed);
      },
      fail: (err) => {
        // 用户主动取消不算错误
        if (err && /cancel/i.test(err.errMsg || '')) return resolve([]);
        reject(err);
      },
    });
  });
}

/**
 * 上传图片到服务端换取可访问 URL
 *
 * 说明：这里假设后端提供 /upload 接口。
 * 若改用对象存储直传，需替换为 getUploadToken + wx.uploadFile 到 OSS。
 */
function uploadImage(filePath) {
  const { getToken } = require('./auth');
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${config.baseUrl}/upload/image`,
      filePath,
      name: 'file',
      header: { Authorization: `Bearer ${getToken()}` },
      success(res) {
        try {
          const body = JSON.parse(res.data);
          if (body.code === 0 && body.data && body.data.url) {
            resolve(body.data.url);
          } else {
            reject(new Error(body.msg || '上传失败'));
          }
        } catch (e) {
          reject(new Error('上传响应解析失败'));
        }
      },
      fail: reject,
    });
  });
}

/** 批量上传 */
async function uploadImages(paths) {
  const urls = [];
  for (const p of paths) {
    urls.push(await uploadImage(p));
  }
  return urls;
}

module.exports = {
  compressImages,
  compressOne,
  getFileSize,
  formatSize,
  chooseImages,
  uploadImage,
  uploadImages,
};
