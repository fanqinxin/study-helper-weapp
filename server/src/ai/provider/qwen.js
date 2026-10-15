/**
 * 通义千问 Provider
 * 基于 DashScope OpenAI 兼容模式，识别用 qwen-vl-max，判题用 qwen-plus
 */
const OpenAICompatProvider = require('./openaiCompat');

class QwenProvider extends OpenAICompatProvider {
  constructor(cfg) {
    super(cfg);
    this.name = 'qwen';
    // 允许未显式配置时使用千问默认端点
    if (!cfg.baseUrl) {
      this.client.defaults.baseURL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    }
  }
}

module.exports = QwenProvider;
