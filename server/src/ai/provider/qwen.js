/**
 * 通义千问 Provider
 * 基于 DashScope OpenAI 兼容模式，识别用视觉模型，判题用文本模型
 *
 * 模型名以百炼控制台「推荐模型」为准，配置项为 AI_VISION_MODEL / AI_TEXT_MODEL。
 * 注意：旧名 qwen-vl-max 在中国内地（北京）已下线，硬编码会直接报 model not found。
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
