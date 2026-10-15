/**
 * 腾讯混元 Provider
 * 混元提供 OpenAI 兼容端点，沿用同一套实现，仅默认端点与模型名不同
 */
const OpenAICompatProvider = require('./openaiCompat');

class HunyuanProvider extends OpenAICompatProvider {
  constructor(cfg) {
    super(cfg);
    this.name = 'hunyuan';
    if (!cfg.baseUrl) {
      // 混元 OpenAI 兼容端点，具体以官方文档为准，可在 .env 覆盖
      this.client.defaults.baseURL = 'https://api.hunyuan.cloud.tencent.com/v1';
    }
  }
}

module.exports = HunyuanProvider;
