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

  /** 统一的请求执行 + 重试 */
  async _post(payload, attempt = 1) {
    try {
      const { data } = await this.client.post('/chat/completions', payload);
      const content = data?.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('模型返回内容为空');
      }
      return content;
    } catch (e) {
      const msg = e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
      logger.warn({ attempt, msg }, 'AI 请求失败');
      if (attempt < this.cfg.maxRetry + 1) {
        // 指数退避，避免瞬间重试打爆下游
        await new Promise((r) => setTimeout(r, 800 * attempt));
        return this._post(payload, attempt + 1);
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
    return this._post({
      model: this.cfg.visionModel,
      messages: [{ role: 'user', content }],
      temperature: 0.2,
    });
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
