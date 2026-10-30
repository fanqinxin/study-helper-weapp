/**
 * 统一配置层
 * 所有环境变量集中在此读取，业务代码不直接碰 process.env
 */
require('dotenv').config();

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

const config = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 3000),
  isProd: process.env.NODE_ENV === 'production',

  wx: {
    appid: process.env.WX_APPID || '',
    secret: process.env.WX_SECRET || '',
    // 小程序登录凭证校验
    code2sessionUrl: 'https://api.weixin.qq.com/sns/jscode2session',
  },

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: num(process.env.DB_PORT, 3306),
    database: process.env.DB_NAME || 'study_helper',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    connectionLimit: 10,
  },

  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: num(process.env.REDIS_PORT, 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db: num(process.env.REDIS_DB, 0),
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'dev_only_secret_change_me',
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
  },

  ai: {
    provider: process.env.AI_PROVIDER || 'qwen',
    // 模型名必须与百炼当前「推荐模型」列表一致。
    // 旧址：qwen-vl-max 已不在中国内地（北京）可用列表，调用会报 model not found
    visionModel: process.env.AI_VISION_MODEL || 'qwen3.7-plus',
    textModel: process.env.AI_TEXT_MODEL || 'qwen-plus',
    apiKey: process.env.AI_API_KEY || '',
    baseUrl: process.env.AI_BASE_URL || '',
    maxRetry: num(process.env.AI_MAX_RETRY, 2),
    timeoutMs: num(process.env.AI_TIMEOUT_MS, 60000),
  },

  quota: {
    freeTotal: num(process.env.QUOTA_FREE_TOTAL, 20),
    cycleDays: num(process.env.QUOTA_CYCLE_DAYS, 7),
    warnThreshold: num(process.env.QUOTA_WARN_THRESHOLD, 3),
  },

  /**
   * 加油包档位。
   * packId 与前端、订单表保持一致，改动需同步。
   */
  packs: [
    { packId: 'pack_100', title: '100 次', amountFen: 1200, quota: 100, desc: '适合日常使用' },
    { packId: 'pack_300', title: '300 次', amountFen: 2400, quota: 300, desc: '考前冲刺推荐 · 省 33%', recommended: true },
    { packId: 'pack_month', title: '不限量', amountFen: 3900, quota: 0, desc: '多孩家庭 · 按月不限次', monthly: true },
  ],

  oss: {
    bucket: process.env.OSS_BUCKET || '',
    region: process.env.OSS_REGION || '',
    accessKeyId: process.env.OSS_ACCESS_KEY_ID || '',
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET || '',
    cdnDomain: process.env.OSS_CDN_DOMAIN || '',
  },

  upload: {
    /** 单张图片上限（MB） */
    maxSizeMb: num(process.env.UPLOAD_MAX_SIZE_MB, 3),
    /**
     * 站点对外根地址（不带尾部 /），如 https://sh-api.rstu.top
     * 用途：库里存的是相对路径 /static/uploads/...，交给 AI 之前
     * 必须补全成公网绝对 URL —— 百炼的服务器要从公网回源拉图。
     */
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  },

  log: {
    level: process.env.LOG_LEVEL || 'info',
  },
};

// 生产环境强制校验关键配置，避免带病上线
if (config.isProd) {
  const required = [
    ['WX_APPID', config.wx.appid],
    ['WX_SECRET', config.wx.secret],
    ['AI_API_KEY', config.ai.apiKey],
    ['AI_BASE_URL', config.ai.baseUrl],
    ['DB_PASSWORD', config.db.password],
  ];
  const missing = required.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(`[config] 生产环境缺少必要配置: ${missing.join(', ')}`);
  }
  if (config.jwt.secret === 'dev_only_secret_change_me') {
    throw new Error('[config] 生产环境必须设置安全的 JWT_SECRET');
  }
  if (!process.env.JWT_SECRET) {
    throw new Error('[config] 生产环境必须显式设置 JWT_SECRET');
  }
}

module.exports = config;
