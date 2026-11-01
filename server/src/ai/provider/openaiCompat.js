/**
 * OpenAI 兼容协议 Provider
 *
 * 通义千问（DashScope 兼容模式）、混元（OpenAI 兼容端点）、
 * 以及任何 OpenAI 协议兼容的服务都可以用这个实现，
 * 只需在 .env 里改 AI_BASE_URL 与模型名即可。
 */
const axios = require('axios');
const BaseProvider = require('./base');
const logger = require('../../utils/logger');

class OpenAICompatProvider extends BaseProvider {
  constructor(cfg) {
    super(cfg);
    this.name = 'openai-compat';
    this.client = axios.create({
      baseURL: cfg.baseUrl,
      timeout: cfg.timeoutMs,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * 统一的请求执行 + 重试
   *
   * @param {object} payload 请求体
   * @param {number} [attempt] 第几次尝试
   * @param {object} [opts]
   * @param {number} [opts.timeout] 本次请求超时（视觉识别比文本慢得多）
   * @param {string} [opts.tag] 日志标记
   */
  async _post(payload, attempt = 1, opts = {}) {
    const { timeout = this.cfg.timeoutMs, tag = 'AI' } = opts;
    try {
      const { data } = await this.client.post('/chat/completions', payload, { timeout });
      const content = data?.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('模型返回内容为空');
      }
      return content;
    } catch (e) {
      const isTimeout = e.code === 'ECONNABORTED' || /timeout of \d+ms exceeded/.test(e.message || '');
      const msg = e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
      logger.warn({ attempt, tag, timeout, msg }, 'AI 请求失败');

      // 超时不重试：模型不会因为再等一次就变快，重试只会把等待时间乘以倍数
      const canRetry = !isTimeout && attempt < this.cfg.maxRetry + 1;
      if (canRetry) {
        // 指数退避，避免瞬间重试打爆下游
        await new Promise((r) => setTimeout(r, 800 * attempt));
        return this._post(payload, attempt + 1, opts);
      }
      if (isTimeout) {
        throw new Error(`${tag}超时（已等待 ${Math.round(timeout / 1000)} 秒），请稍后重试`);
      }
      throw new Error(`AI 请求最终失败: ${msg}`);
    }
  }

  async chatVision(imageUrls, prompt) {
    const images = Array.isArray(imageUrls) ? imageUrls : [imageUrls];
    const content = [
      { type: 'text', text: prompt },
      ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
    ];
    return this._post(
      {
        model: this.cfg.visionModel,
        messages: [{ role: 'user', content }],
        temperature: 0.2,
        // 目录识别可能输出上百条课文，必须给足输出预算，否则会被截断
        max_tokens: this.cfg.visionMaxTokens,
      },
      1,
      { timeout: this.cfg.visionTimeoutMs, tag: 'AI 视觉识别' }
    );
  }

  async chatText(prompt, opts = {}) {
    const messages = [];
    if (opts.system) messages.push({ role: 'system', content: opts.system });
    messages.push({ role: 'user', content: prompt });

    return this._post({
      model: this.cfg.textModel,
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 4000,
    });
  }
}

module.exports = OpenAICompatProvider;
