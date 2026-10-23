import type { ChannelStatus } from '../../shared/types.js';
import type { Channel, ChannelResult, ChannelRun, ChannelTest } from './types.js';
import { ChannelError, abortError, throwIfAborted } from './types.js';

export interface ModelApiOptions {
  apiKey?: string;
  baseUrl: string;
  model: string;
  kind: 'deepseek' | 'openai-compatible';
}

const PRIVATE = /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i;

export function normalizeBaseUrl(input: string): string {
  const value = input.trim().replace(/\/+$/, '');
  if (!value) throw new ChannelError('MODEL_API_BASE_URL', '模型 API 地址不能为空。');
  let url: URL;
  try { url = new URL(value); } catch { throw new ChannelError('MODEL_API_BASE_URL', '模型 API 地址不是合法 URL。'); }
  const allowPrivate = process.env.WORKBENCH_ALLOW_PRIVATE_MODEL_ENDPOINT === '1';
  const privateHost = PRIVATE.test(url.hostname);
  if (privateHost && !allowPrivate) throw new ChannelError('MODEL_API_BASE_URL', '出于安全考虑，默认拒绝访问本机或私有网络的模型端点。确实需要时可设置 WORKBENCH_ALLOW_PRIVATE_MODEL_ENDPOINT=1。');
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw new ChannelError('MODEL_API_BASE_URL', '模型 API 地址必须使用 HTTPS。');
  if (url.username || url.password) throw new ChannelError('MODEL_API_BASE_URL', '模型 API 地址不能内嵌账号密码。');
  return value;
}

function redact(value: string, key?: string): string {
  let safe = value;
  if (key) safe = safe.split(key).join('[REDACTED]');
  return safe.replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]');
}

export class ModelApiChannel implements Channel {
  readonly id = 'model-api' as const;
  readonly caps = { blind: false, json: true, usage: true };
  private modelList?: string[];
  constructor(private readonly options: ModelApiOptions) {}

  private endpoint(pathname: string): string {
    return `${normalizeBaseUrl(this.options.baseUrl)}${pathname}`;
  }
  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.apiKey}` };
  }
  async status(): Promise<ChannelStatus> {
    if (!this.options.apiKey) return { id: this.id, label: '独立模型 API', kind: 'api', code: 'needs-key', detail: `未配置 Key；默认端点 ${this.options.baseUrl}。` };
    return { id: this.id, label: '独立模型 API', kind: 'api', code: 'ready', models: this.modelList || [this.options.model], detail: `${this.options.kind === 'deepseek' ? 'DeepSeek' : 'OpenAI 兼容'} · ${this.options.baseUrl}` };
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    if (!this.options.apiKey) throw new ChannelError('MODEL_API_AUTH', '尚未配置模型 API Key。');
    const response = await fetch(this.endpoint('/models'), { headers: this.headers(), signal });
    const text = await response.text();
    if (!response.ok) throw new ChannelError(response.status === 401 || response.status === 403 ? 'MODEL_API_AUTH' : 'MODEL_API_ERROR', `模型列表请求失败（${response.status}）：${redact(text, this.options.apiKey).slice(0, 240)}`);
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { throw new ChannelError('MODEL_API_ERROR', '模型列表不是合法 JSON。'); }
    const models = Array.isArray(parsed?.data) ? parsed.data.map((item: any) => String(item?.id || '')).filter(Boolean) : [];
    if (!models.length) throw new ChannelError('MODEL_API_ERROR', '模型列表为空。');
    this.modelList = models;
    return models;
  }

  async run(input: ChannelRun): Promise<ChannelResult> {
    throwIfAborted(input.signal);
    if (!this.options.apiKey) throw new ChannelError('MODEL_API_AUTH', '尚未配置模型 API Key，无法调用独立模型 API。');
    const timeout = AbortSignal.timeout(240_000);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages: [{ role: 'system', content: input.system }, { role: 'user', content: input.prompt }],
      temperature: 0,
      max_tokens: 5000,
    };
    if (this.options.kind === 'deepseek') body.thinking = { type: 'disabled' };
    if (input.json) body.response_format = { type: 'json_object' };
    let response: Response;
    try {
      response = await fetch(this.endpoint('/chat/completions'), { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal });
    } catch (error: any) {
      if (input.signal?.aborted) throw abortError();
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new ChannelError('MODEL_API_TIMEOUT', '模型 API 请求超过 240 秒。');
      throw new ChannelError('MODEL_API_ERROR', `无法连接模型 API：${redact(String(error?.message || error), this.options.apiKey)}`);
    }
    const text = await response.text();
    if (!response.ok) throw new ChannelError(response.status === 401 || response.status === 403 ? 'MODEL_API_AUTH' : 'MODEL_API_ERROR', `模型 API 请求失败（${response.status}）：${redact(text, this.options.apiKey).slice(0, 300)}`);
    let result: any;
    try { result = JSON.parse(text); } catch { throw new ChannelError('MODEL_API_ERROR', '模型 API 返回的不是合法 JSON。'); }
    const usage = result?.usage || {};
    // A response that arrived before cancellation is still chargeable, but its content is discarded.
    if (input.signal?.aborted) throw Object.assign(abortError(), { usage, model: result?.model });
    const content = String(result?.choices?.[0]?.message?.content || '').trim();
    if (!content) throw new ChannelError('MODEL_API_ERROR', '模型 API 没有返回文本内容。');
    return { text: content, model: String(result?.model || this.options.model), usage, evidence: { channel: this.id, mode: 'api', toolsDisabled: true, freshConfig: true } };
  }

  async test(signal?: AbortSignal): Promise<ChannelTest> {
    const started = Date.now();
    if (!this.options.apiKey) return { ok: false, channel: this.id, latencyMs: 0, detail: '尚未配置模型 API Key。' };
    try {
      const models = await this.listModels(signal);
      if (!models.includes(this.options.model)) return { ok: false, channel: this.id, auth: 'api-key', model: this.options.model, models, latencyMs: Date.now() - started, detail: `端点可用，但模型列表中不存在 ${this.options.model}。可选：${models.slice(0, 6).join('、')}` };
      const timeout = AbortSignal.timeout(30_000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const body: Record<string, unknown> = { model: this.options.model, messages: [{ role: 'user', content: '只回复 OK。' }], temperature: 0, max_tokens: 8 };
      if (this.options.kind === 'deepseek') body.thinking = { type: 'disabled' };
      const response = await fetch(this.endpoint('/chat/completions'), { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: combined });
      const text = await response.text();
      if (!response.ok) return { ok: false, channel: this.id, auth: 'api-key', model: this.options.model, models, latencyMs: Date.now() - started, detail: `对话请求失败（${response.status}）：${redact(text, this.options.apiKey).slice(0, 200)}` };
      return { ok: true, channel: this.id, auth: 'api-key', model: this.options.model, models, latencyMs: Date.now() - started, detail: `连接成功 · ${models.length} 个模型可用` };
    } catch (error: any) {
      return { ok: false, channel: this.id, auth: 'api-key', model: this.options.model, latencyMs: Date.now() - started, detail: redact(error instanceof Error ? error.message : String(error), this.options.apiKey) };
    }
  }
}
