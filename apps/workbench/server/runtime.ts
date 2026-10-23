import { readFile, mkdir, appendFile, writeFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ChannelId, ChannelStatus, PrimaryChannel, Settings } from '../shared/types.js';
import { loadProtocol } from './protocols.js';
import { buildChannels, BLIND_SUBAGENT, CHANNEL_LABELS, ChannelError, type Channel, type ChannelEvidence, type ChannelResult, type ChannelTest } from './channels/index.js';
import { normalizeBaseUrl } from './channels/model-api.js';
import { abortError, throwIfAborted } from './channels/types.js';

export type Progress = (message: string, level?: 'info' | 'warning' | 'error') => void;
export interface Invocation { skill: string; prompt: string; blind?: boolean; signal?: AbortSignal; progress: Progress; json?: boolean; }
export interface InvocationResult { text: string; data: any; provider: string; model?: string; evidence?: ChannelEvidence }
export { runAgentProcess } from './channels/process.js';

const costEstimate = (usage: any) => {
  const input = Number(usage?.prompt_tokens ?? usage?.input_tokens) || 0;
  const output = Number(usage?.completion_tokens ?? usage?.output_tokens) || 0;
  return (input * 2 + output * 8) / 1_000_000;
};
function notCancelled(signal?: AbortSignal) { if (signal?.aborted) throw abortError(); }

/** One in-process registry plus one durable ledger per shared billing directory. */
class BillingLedger {
  budget: number;
  spent = 0;
  configured = false;
  private recordIds = new Set<string>();
  private ready?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string, defaultBudget: number) { this.budget = defaultBudget; }
  init(): Promise<void> {
    if (!this.ready) this.ready = this.load();
    return this.ready;
  }
  private async load() {
    await mkdir(this.directory, { recursive: true });
    try {
      const configuration = JSON.parse(await readFile(path.join(this.directory, 'billing.json'), 'utf8'));
      if (!Number.isFinite(configuration.budget) || configuration.budget <= 0) throw new Error('共享预算配置无效');
      this.budget = configuration.budget; this.configured = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try {
      const records = (await readFile(path.join(this.directory, 'usage.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean);
      for (const record of records) {
        // Bad or truncated accounting data must not silently reset a paid budget.
        const parsed = JSON.parse(record);
        const cost = typeof parsed.estimatedCny === 'number' ? parsed.estimatedCny : costEstimate(parsed.usage);
        if (!Number.isFinite(cost) || cost < 0) throw new Error('共享用量记录无效');
        this.spent += cost;
        if (typeof parsed.id === 'string') this.recordIds.add(parsed.id);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('模型用量记录无法恢复，请保留并检查 usage.jsonl。'); }
  }
  serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation); this.queue = next.catch(() => undefined); return next;
  }
  async setBudget(budget: number) {
    if (!Number.isFinite(budget) || budget <= 0 || budget > 500) throw new Error('模型预算必须为 0 到 500 元之间的正数。');
    return this.serial(async () => {
      await this.init();
      const target = path.join(this.directory, 'billing.json'); const temporary = `${target}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify({ budget }, null, 2), 'utf8'); await rename(temporary, target); }
      finally { await rm(temporary, { force: true }).catch(() => undefined); }
      this.budget = budget; this.configured = true;
    });
  }
  async record(provider: string, model: string | undefined, usage: unknown, space: string) {
    const estimatedCny = costEstimate(usage);
    if (!Number.isFinite(estimatedCny) || estimatedCny < 0) throw new Error('模型返回了无效的计费用量，已停止当前请求。');
    this.spent += estimatedCny;
    await appendFile(path.join(this.directory, 'usage.jsonl'), JSON.stringify({ id: randomUUID(), at: new Date().toISOString(), provider, model, usage: usage ?? null, space, estimatedCny, estimatedCnyTotal: this.spent }) + '\n');
  }
  async importLegacyUsage(source: string, space: string) {
    if (path.resolve(source) === path.join(this.directory, 'usage.jsonl')) return;
    return this.serial(async () => {
      await this.init();
      let contents: string;
      try { contents = await readFile(source, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const [index, line] of contents.split(/\r?\n/).filter(Boolean).entries()) {
        const id = `legacy-${createHash('sha256').update(`${path.resolve(source)}:${index}:${line}`).digest('hex')}`;
        if (this.recordIds.has(id)) continue;
        let record: any;
        try { record = JSON.parse(line); }
        catch { throw new Error('旧模型用量记录无法恢复，请保留并检查 usage.jsonl。'); }
        const estimatedCny = typeof record.estimatedCny === 'number' ? record.estimatedCny : costEstimate(record.usage);
        if (!Number.isFinite(estimatedCny) || estimatedCny < 0) throw new Error('旧模型用量记录无效。');
        this.spent += estimatedCny;
        await appendFile(path.join(this.directory, 'usage.jsonl'), JSON.stringify({ id, at: record.at, provider: record.provider || 'deepseek', model: record.model, usage: record.usage, space, estimatedCny, estimatedCnyTotal: this.spent, migrated: true }) + '\n');
        this.recordIds.add(id);
      }
    });
  }
}
const billingLedgers = new Map<string, BillingLedger>();
function sharedBilling(directory: string, budget: number): BillingLedger {
  const resolved = path.resolve(directory);
  if (!billingLedgers.has(resolved)) billingLedgers.set(resolved, new BillingLedger(resolved, budget));
  return billingLedgers.get(resolved)!;
}

const PROVIDERS: PrimaryChannel[] = ['auto', 'codebuddy', 'model-api', 'claude', 'codex', 'qoder'];
const AUTH_MODES = ['auto', 'account', 'model-api'] as const;
const MODEL_APIS = ['deepseek', 'openai-compatible'] as const;

function normalizeProvider(value: unknown, fallback: PrimaryChannel): PrimaryChannel {
  if (value === 'deepseek') return 'model-api';
  if (value === 'auto') return 'codebuddy';
  return PROVIDERS.includes(value as PrimaryChannel) ? value as PrimaryChannel : fallback;
}
const safeModel = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(value) ? value : undefined;

interface Configuration { provider: PrimaryChannel; codebuddyAuth: 'auto' | 'account' | 'model-api'; modelApi: 'deepseek' | 'openai-compatible'; baseUrl: string; model: string }

export function extractJson(text: string): any {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch { /* SDKs sometimes wrap the object with prose. */ }
  const first = cleaned.indexOf('{'); const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) return JSON.parse(cleaned.slice(first, last + 1));
  throw new Error('模型未返回有效的结构化结果，请重试当前步骤。');
}

export class Runtime {
  private configuration: Configuration;
  private key: string;
  private billing: BillingLedger;
  private channels: Record<ChannelId, Channel>;
  private statuses: ChannelStatus[] = [];
  private activeProvider = 'none';
  private activeModel = '';
  private providerIssue?: string;
  private blindReady = false;
  private blindDetail = '尚未检测盲评通道。';
  constructor(private upstreamRoot: string, private runtimeRoot: string, private demo = false, sharedBillingRoot = runtimeRoot) {
    const provider = normalizeProvider(process.env.WORKBENCH_PROVIDER, 'codebuddy');
    this.configuration = {
      provider,
      codebuddyAuth: 'auto',
      modelApi: 'deepseek',
      baseUrl: process.env.WORKBENCH_MODEL_BASE_URL || 'https://api.deepseek.com',
      model: safeModel(process.env.WORKBENCH_MODEL) || 'deepseek-flash',
    };
    this.key = process.env.WORKBENCH_MODEL_API_KEY || process.env.DEEPSEEK_API_KEY || '';
    this.billing = sharedBilling(sharedBillingRoot, Number(process.env.WORKBENCH_BUDGET || 50));
    this.channels = this.rebuildChannels();
  }

  private resolvedAuth(): 'account' | 'model-api' {
    if (this.configuration.codebuddyAuth === 'account') return 'account';
    if (this.configuration.codebuddyAuth === 'model-api') return 'model-api';
    return this.key ? 'model-api' : 'account';
  }
  private blindModel(): string {
    if (process.env.WORKBENCH_BLIND_MODEL) return process.env.WORKBENCH_BLIND_MODEL;
    return /deepseek/i.test(this.configuration.baseUrl) ? 'deepseek-flash' : this.configuration.model;
  }
  private rebuildChannels(): Record<ChannelId, Channel> {
    return buildChannels({
      codebuddy: { auth: this.resolvedAuth(), apiKey: this.key, baseUrl: this.configuration.baseUrl, model: this.configuration.model, blindModel: this.blindModel(), demo: this.demo },
      modelApi: { apiKey: this.key, baseUrl: this.configuration.baseUrl, model: this.configuration.model, kind: this.configuration.modelApi },
    });
  }
  private status(id: ChannelId): ChannelStatus | undefined { return this.statuses.find(item => item.id === id); }
  private select(preferred: PrimaryChannel): { channel?: Channel; issue?: string } {
    const wanted: ChannelId = preferred === 'auto' ? 'codebuddy' : preferred;
    const order = [...new Set<ChannelId>([wanted, 'codebuddy', 'model-api', 'codex', 'claude', 'qoder'])];
    let issue: string | undefined;
    for (const id of order) {
      const status = this.status(id);
      if (!status) continue;
      const usable = id === wanted
        ? ['ready', 'experimental', 'needs-login'].includes(status.code)
        : status.code === 'ready' || (status.id === 'codebuddy' && status.code === 'needs-login') || ((status.id === 'codex' || status.id === 'claude') && status.code === 'experimental');
      if (usable) return { channel: this.channels[id], issue };
      if (id === wanted) issue = `${CHANNEL_LABELS[id]} 不可用：${status.detail}`;
    }
    return { issue: issue || '没有可用的执行通道。请在设置中配置 CodeBuddy 或独立模型 API。' };
  }
  private blindAvailability(): { ready: boolean; detail: string } {
    const status = this.status('codebuddy');
    if (!status || status.code === 'not-installed') return { ready: false, detail: '未检测到本机 CodeBuddy CLI，无法进行独立盲评。' };
    if (this.resolvedAuth() !== 'model-api') return { ready: false, detail: '盲评要求 CodeBuddy 使用模型 API 后端和临时隔离配置；请在设置中切换认证方式。' };
    if (!this.key) return { ready: false, detail: '盲评需要模型 API Key 作为 CodeBuddy 后端。' };
    return { ready: true, detail: `CodeBuddy 主 agent → ${BLIND_SUBAGENT} 子 agent（临时隔离配置）` };
  }
  private async refreshStatuses(): Promise<void> {
    this.statuses = await Promise.all(Object.values(this.channels).map(async channel => {
      try { return await channel.status(); }
      catch (error) {
        return { id: channel.id, label: CHANNEL_LABELS[channel.id], kind: channel.id === 'model-api' ? 'api' : 'agent', code: 'not-installed', detail: error instanceof Error ? error.message : String(error) } as ChannelStatus;
      }
    }));
    const selection = this.select(this.configuration.provider);
    this.providerIssue = selection.issue;
    this.activeProvider = selection.channel?.id || 'none';
    const selectedStatus = selection.channel ? this.status(selection.channel.id) : undefined;
    this.activeModel = selectedStatus?.models?.[0] || this.configuration.model;
    const blind = this.blindAvailability();
    this.blindReady = blind.ready; this.blindDetail = blind.detail;
  }

  getSettings(): Settings {
    return {
      provider: this.configuration.provider,
      codebuddyAuth: this.configuration.codebuddyAuth,
      modelApi: this.configuration.modelApi,
      baseUrl: this.configuration.baseUrl,
      model: this.configuration.model,
      budget: this.billing.budget,
      deepseekConfigured: !!this.key,
      codebuddyAvailable: !!this.status('codebuddy') && this.status('codebuddy')!.code !== 'not-installed',
      codexAvailable: !!this.status('codex') && this.status('codex')!.code !== 'not-installed',
      claudeAvailable: !!this.status('claude') && this.status('claude')!.code !== 'not-installed',
      channels: this.statuses.map(status => ({ ...status, active: status.id === this.activeProvider })),
      activeProvider: this.activeProvider,
      activeModel: this.activeModel,
      blind: { mode: 'codebuddy-subagent', subagent: BLIND_SUBAGENT, ready: this.blindReady, detail: this.blindDetail },
      ...(this.providerIssue ? { providerIssue: this.providerIssue } : {}),
    };
  }

  async configure(input: { provider?: PrimaryChannel | 'deepseek'; codebuddyAuth?: 'auto' | 'account' | 'model-api'; modelApi?: 'deepseek' | 'openai-compatible'; baseUrl?: string; model?: string; budget?: number; deepseekKey?: string }) {
    if (this.demo && input.budget !== undefined) throw new Error('演示空间不能修改共享预算，请在本机真实空间配置。');
    if (input.provider && input.provider !== 'deepseek' && !PROVIDERS.includes(input.provider as PrimaryChannel)) throw new Error('无效的执行通道。');
    if (input.codebuddyAuth && !AUTH_MODES.includes(input.codebuddyAuth)) throw new Error('无效的 CodeBuddy 认证方式。');
    if (input.modelApi && !MODEL_APIS.includes(input.modelApi)) throw new Error('无效的模型 API 类型。');
    const baseUrl = input.baseUrl !== undefined ? normalizeBaseUrl(input.baseUrl) : undefined;
    const model = input.model !== undefined ? safeModel(input.model) : undefined;
    if (input.model !== undefined && !model) throw new Error('模型名称格式无效。');
    await this.billing.init();
    if (input.budget !== undefined) await this.billing.setBudget(input.budget);
    if (input.provider) this.configuration.provider = normalizeProvider(input.provider, this.configuration.provider);
    if (input.codebuddyAuth) this.configuration.codebuddyAuth = input.codebuddyAuth;
    if (input.modelApi) this.configuration.modelApi = input.modelApi;
    if (baseUrl) this.configuration.baseUrl = baseUrl;
    if (model) this.configuration.model = model;
    if (input.deepseekKey?.trim()) this.key = input.deepseekKey.trim();
    this.channels = this.rebuildChannels();
    await this.refreshStatuses();
    await mkdir(this.runtimeRoot, { recursive: true });
    // Keys, tokens and login state never reach this file.
    await writeFile(path.join(this.runtimeRoot, 'settings.json'), JSON.stringify({
      provider: this.configuration.provider,
      codebuddyAuth: this.configuration.codebuddyAuth,
      modelApi: this.configuration.modelApi,
      baseUrl: this.configuration.baseUrl,
      model: this.configuration.model,
      ...(!this.demo ? { budget: this.billing.budget } : {}),
    }, null, 2), 'utf8');
    return this.getSettings();
  }

  async init() {
    let savedBudget: number | undefined;
    try {
      const saved = JSON.parse(await readFile(path.join(this.runtimeRoot, 'settings.json'), 'utf8'));
      this.configuration.provider = normalizeProvider(saved.provider, 'codebuddy');
      if (AUTH_MODES.includes(saved.codebuddyAuth)) this.configuration.codebuddyAuth = saved.codebuddyAuth;
      if (MODEL_APIS.includes(saved.modelApi)) this.configuration.modelApi = saved.modelApi;
      if (typeof saved.baseUrl === 'string') { try { this.configuration.baseUrl = normalizeBaseUrl(saved.baseUrl); } catch { /* Keep the safe default. */ } }
      if (safeModel(saved.model)) this.configuration.model = saved.model;
      if (Number.isFinite(saved.budget) && saved.budget > 0) savedBudget = saved.budget;
    } catch { /* First run or unreadable legacy file. */ }
    await this.billing.init();
    await this.billing.importLegacyUsage(path.join(this.runtimeRoot, 'usage.jsonl'), this.demo ? 'demo' : 'owner');
    if (!this.demo && !this.billing.configured) await this.billing.setBudget(savedBudget ?? this.billing.budget);
    this.channels = this.rebuildChannels();
    await this.refreshStatuses();
  }

  async testConnection(signal?: AbortSignal): Promise<ChannelTest> {
    throwIfAborted(signal);
    const selection = this.select(this.configuration.provider);
    const channel = selection.channel;
    if (!channel?.test) throw new ChannelError('CHANNEL_TEST_UNSUPPORTED', '当前通道暂不支持连接测试。');
    return channel.test(signal);
  }

  async invoke(request: Invocation): Promise<InvocationResult> {
    if (request.signal?.aborted) throw abortError();
    if (!/^cheat-[a-z-]+$/.test(request.skill)) throw new Error('无效的上游 Skill。');
    const protocol = await loadProtocol(this.upstreamRoot, request.skill, request.blind);
    request.progress(`读取上游 ${request.skill} 协议`);
    // Explicit stage inputs are the only creator context. CLI runs in a fresh empty directory.
    const system = `你是 Cheat on Content 的可视工作台执行器。使用下列真实上游 Skill 的方法处理当前阶段。界面负责文件写入、用户确认、权限和任务编排；你只输出结果，不调用工具、不读取其他文件、不执行命令。不要执行协议里不属于当前阶段的副作用。缺少经历或事实时明确标待补充，不编造，不声称发布或数据抓取已完成。输出中文。${request.json === false ? '' : '最终只输出一个合法JSON对象，不要Markdown代码围栏。'}\n\n${request.blind ? '这是独立盲评。除了当前稿件、纯规则及通用评分协议，不允许参考任何作者历史、实绩、创作对话或用户身份。' : ''}\n\n上游协议：\n${protocol}`;
    let channel: Channel;
    if (request.blind) {
      const availability = this.blindAvailability();
      if (!availability.ready) throw new ChannelError('BLIND_CHANNEL_UNAVAILABLE', availability.detail);
      channel = this.channels.codebuddy;
      request.progress(`${availability.detail} · ${this.blindModel()}`);
    } else {
      const selection = this.select(this.configuration.provider);
      if (!selection.channel) throw new ChannelError('CHANNEL_UNAVAILABLE', selection.issue || '没有可用的执行通道。');
      channel = selection.channel;
      const label = CHANNEL_LABELS[channel.id];
      const model = this.status(channel.id)?.models?.[0] || this.configuration.model;
      request.progress(`执行通道：${label} · ${model}${selection.issue ? `（${selection.issue}）` : ''}`);
    }
    let result: ChannelResult;
    try {
      result = await this.runChannel(channel, request, system);
    } catch (error: any) {
      if (!request.blind && channel.id === 'codebuddy' && error?.code === 'CODEBUDDY_AUTH_REQUIRED' && this.status('model-api')?.code === 'ready') {
        this.providerIssue = '本机 CodeBuddy 登录未通过，本次已回退到独立模型 API。';
        request.progress(this.providerIssue, 'warning');
        channel = this.channels['model-api'];
        result = await this.runChannel(channel, request, system);
      } else throw error;
    }
    notCancelled(request.signal);
    if (!result.text.trim()) throw new Error('执行器没有返回内容。当前步骤未完成。');
    const data = request.json === false ? null : extractJson(result.text);
    return { text: result.text, data, provider: channel.id, model: result.model, evidence: result.evidence };
  }

  private async runChannel(channel: Channel, request: Invocation, system: string): Promise<ChannelResult> {
    const paid = channel.id === 'model-api' || (channel.id === 'codebuddy' && this.resolvedAuth() === 'model-api');
    const execute = () => channel.run({
      skill: request.skill, prompt: request.prompt, system, blind: request.blind === true,
      json: request.json !== false, signal: request.signal, progress: request.progress,
    });
    if (!paid) {
      request.progress('使用本机 CodeBuddy 登录态，不占用本应用预算');
      return execute();
    }
    return this.billing.serial(async () => {
      await this.billing.init(); notCancelled(request.signal);
      if (this.billing.spent >= this.billing.budget) throw new ChannelError('BUDGET_EXCEEDED', '本应用的共享模型费用估算已达到预算上限。');
      try {
        const result = await execute();
        if (result.usage == null) request.progress('通道未返回用量；本次只记录可见费用（0）。', 'warning');
        await this.billing.record(channel.id, result.model, result.usage, this.demo ? 'demo' : 'owner');
        request.progress(`模型调用完成 · 两个空间累计费用估算 ¥${this.billing.spent.toFixed(3)} / ¥${this.billing.budget}`);
        return result;
      } catch (error: any) {
        // A response that arrived before cancellation must still be charged.
        if (error?.usage) await this.billing.record(channel.id, error.model, error.usage, this.demo ? 'demo' : 'owner');
        throw error;
      }
    });
  }
}
