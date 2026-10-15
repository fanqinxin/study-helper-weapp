/**
 * AI Provider 抽象基类
 *
 * 所有 provider 必须实现以下契约，业务层只依赖这个接口，
 * 换模型时不需要改动任何业务代码。
 */
class BaseProvider {
  /**
   * @param {object} cfg - config.ai 配置对象
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.name = 'base';
  }

  /**
   * 视觉识别：图片 + 提示词 → 文本
   * @param {string[]} imageUrls 图片地址（需可公网访问，或 base64 data uri）
   * @param {string} prompt 提示词
   * @returns {Promise<string>} 模型原始文本输出
   */
  async chatVision(imageUrls, prompt) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.name}.chatVision 未实现`);
  }

  /**
   * 文本对话：提示词 → 文本
   * @param {string} prompt 提示词
   * @param {object} [opts] { system, temperature, maxTokens }
   * @returns {Promise<string>} 模型原始文本输出
   */
  async chatText(prompt, opts) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.name}.chatText 未实现`);
  }

  /**
   * 从模型输出中提取 JSON（容错处理）
   * 模型经常把 JSON 包在 ```json 里，或前后带解释文字，这里统一清洗。
   */
  static extractJson(text) {
    if (!text) return null;
    let s = String(text).trim();

    // 去掉 markdown 代码块包裹
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();

    // 直接尝试解析
    try {
      return JSON.parse(s);
    } catch (_) { /* 继续尝试截取 */ }

    // 截取第一个 [ 或 { 到最后一个 ] 或 }
    const firstBracket = s.search(/[[{]/);
    if (firstBracket >= 0) {
      const lastBracket = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
      if (lastBracket > firstBracket) {
        try {
          return JSON.parse(s.slice(firstBracket, lastBracket + 1));
        } catch (_) { /* 放弃 */ }
      }
    }
    return null;
  }
}

module.exports = BaseProvider;
