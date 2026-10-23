import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ChannelStatus } from '../../shared/types.js';
import type { Channel, ChannelResult, ChannelRun, ChannelTest } from './types.js';
import { ChannelError, throwIfAborted } from './types.js';
import { captureProcess, installed, executable } from './process.js';

export const BLIND_SUBAGENT = 'cheat-blind-reviewer';

export interface CodeBuddyOptions {
  cliPath?: string;
  auth: 'account' | 'model-api';
  apiKey?: string;
  baseUrl?: string;
  model: string;
  blindModel: string;
  demo?: boolean;
}

interface ToolCall { id: string; name: string; args: Record<string, any>; raw: string }
interface ToolResult { callId: string; name: string; status: string; text: string }
export interface CodeBuddyTranscript {
  result?: Record<string, any>;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  assistantText: string;
  model?: string;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const stripAnsi = (text: string) => text.replace(ANSI, '').replace(/\r\n/g, '\n');

const ENVIRONMENT_ALLOWLIST = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'COMSPEC', 'ComSpec',
  'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'OS', 'LANG', 'LC_ALL', 'USERNAME', 'USERDOMAIN', 'SHELL',
];

let discovered: { value: string | undefined } | undefined;
const versionCache = new Map<string, string>();

export function resetCodeBuddyDiscovery(): void { discovered = undefined; versionCache.clear(); }

export function findCodeBuddy(): string | undefined {
  if (discovered) return discovered.value;
  const candidates: string[] = [];
  if (process.env.WORKBENCH_CODEBUDDY_CLI) candidates.push(process.env.WORKBENCH_CODEBUDDY_CLI);
  const fromPath = [executable('codebuddy'), executable('cbc')].filter(Boolean) as string[];
  candidates.push(...fromPath);
  candidates.push('D:\\workbuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy');
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'));
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'));
  for (const candidate of candidates) {
    if (!installed(candidate)) continue;
    if (!/\.(?:cmd|bat|ps1)$/i.test(candidate)) { discovered = { value: path.resolve(candidate) }; return discovered.value; }
  }
  discovered = { value: undefined };
  return undefined;
}

/** The WorkBuddy CLI ships as a Node script; execute it with the current Node runtime. */
export function codeBuddyInvocation(cli: string): { command: string; prefix: string[] } {
  if (/\.exe$/i.test(cli)) return { command: cli, prefix: [] };
  return { command: process.execPath, prefix: [cli] };
}

export function codeBuddyEnvironment(options: { configDir?: string; apiKey?: string; baseUrl?: string; blind?: boolean; sandbox?: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ENVIRONMENT_ALLOWLIST) if (process.env[name] !== undefined) env[name] = process.env[name];
  env.NO_COLOR = '1';
  env.CODEBUDDY_CODE_DISABLE_AUTO_MEMORY = '1';
  env.CODEBUDDY_CODE_DISABLE_SESSION_SUMMARY = '1';
  if (options.blind) env.CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS = '1';
  if (options.configDir) env.CODEBUDDY_CONFIG_DIR = options.configDir;
  if (options.apiKey) env.CODEBUDDY_API_KEY = options.apiKey;
  if (options.baseUrl) env.CODEBUDDY_BASE_URL = options.baseUrl;
  if (options.sandbox) env.CODEBUDDY_IS_SANDBOX = options.sandbox;
  return env;
}

export function parseCodeBuddyTranscript(raw: string): CodeBuddyTranscript {
  const text = stripAnsi(raw).trim();
  if (!text) throw new ChannelError('CODEBUDDY_BAD_OUTPUT', 'CodeBuddy 没有返回任何结果。');
  const attempts = [text];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].startsWith('[')) { attempts.push(lines.slice(index).join('\n')); break; }
    if (lines[index].startsWith('{')) { attempts.push(lines.slice(index).join('\n')); break; }
  }
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index].startsWith('{') || lines[index].startsWith('[')) { attempts.push(lines.slice(index).join('\n')); break; }
  }
  let parsed: unknown;
  let failure = '';
  for (const attempt of attempts) {
    try { parsed = JSON.parse(attempt); break; }
    catch (error) { failure = error instanceof Error ? error.message : String(error); }
  }
  if (parsed === undefined) throw new ChannelError('CODEBUDDY_BAD_OUTPUT', `CodeBuddy 未返回可解析的 JSON 结果：${failure.slice(0, 160)}`);
  const entries: any[] = Array.isArray(parsed) ? parsed : [parsed];
  const transcript: CodeBuddyTranscript = { toolCalls: [], toolResults: [], assistantText: '' };
  const assistantParts: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'result') transcript.result = entry;
    if (entry.type === 'function_call' || entry.type === 'tool_call') {
      let args: Record<string, any> = {};
      if (entry.arguments && typeof entry.arguments === 'object') args = entry.arguments;
      else if (typeof entry.arguments === 'string') { try { args = JSON.parse(entry.arguments); } catch { args = { raw: entry.arguments }; } }
      transcript.toolCalls.push({ id: String(entry.callId || entry.id || ''), name: String(entry.name || ''), args, raw: typeof entry.arguments === 'string' ? entry.arguments : JSON.stringify(entry.arguments ?? {}) });
    }
    if (entry.type === 'function_call_result' || entry.type === 'tool_result') {
      const output = entry.output ?? entry.result ?? {};
      const textValue = typeof output === 'string' ? output : String(output.text ?? output.content ?? '');
      transcript.toolResults.push({ callId: String(entry.callId || entry.id || ''), name: String(entry.name || ''), status: String(entry.status || ''), text: textValue });
    }
    const model = entry.providerData?.model;
    if (typeof model === 'string' && !transcript.model) transcript.model = model;
    if (entry.type === 'message' && entry.role === 'assistant' && Array.isArray(entry.content)) {
      for (const block of entry.content) if (block?.type === 'output_text' && typeof block.text === 'string') assistantParts.push(block.text);
    }
  }
  transcript.assistantText = assistantParts.join('\n').trim();
  return transcript;
}

async function filesUnder(directory: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch { return []; }
  const results: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    results.push(full);
    if (entry.isDirectory() && !entry.isSymbolicLink()) results.push(...await filesUnder(full, depth + 1));
  }
  return results;
}

/** A blind run may only leave harmless counters behind; user memory or sessions are fatal. */
export async function blindIsolationViolations(configDir: string, cwd: string): Promise<string[]> {
  const violations: string[] = [];
  const all = await filesUnder(configDir);
  for (const filename of all) {
    const relative = path.relative(configDir, filename).replace(/\\/g, '/');
    if (relative === 'settings.json') violations.push('临时配置目录出现 settings.json');
    if (relative.split('/').includes('memory')) violations.push(`临时配置目录出现记忆文件：${relative}`);
    if (relative === 'projects' || relative.startsWith('projects/')) {
      const stat = await fs.stat(filename).catch(() => null);
      if (stat?.isFile()) violations.push(`临时配置目录出现项目文件：${relative}`);
    }
    if (relative === 'sessions' || relative.startsWith('sessions/')) {
      const stat = await fs.stat(filename).catch(() => null);
      if (stat?.isFile()) violations.push(`临时配置目录出现会话文件：${relative}`);
    }
  }
  const cwdEntries = await fs.readdir(cwd).catch(() => [] as string[]);
  if (cwdEntries.length) violations.push(`盲评工作目录被写入：${cwdEntries.slice(0, 4).join('、')}`);
  return [...new Set(violations)];
}

export function blindPayload(system: string, prompt: string): { payload: string; tokens: string[] } {
  const tokens = [randomUUID(), randomUUID(), randomUUID()];
  const payload = `<<<BLIND_PAYLOAD_START ${tokens[0]}>>>\n${system}\n<<<BLIND_PAYLOAD_MIDDLE ${tokens[1]}>>>\n当前阶段任务：\n${prompt}\n<<<BLIND_PAYLOAD_END ${tokens[2]}>>>`;
  return { payload, tokens };
}

function stripAgentSuffix(text: string): string {
  return text.replace(/\s*\[Agent ID:[^\]]*\]\s*$/i, '').trim();
}

const normalize = (text: string) => text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

/** The main agent only schedules; the score must come from a verified sub-agent tool result. */
export function verifyBlindDelegation(transcript: CodeBuddyTranscript, tokens: string[], payload: string): string {
  const agentCalls = transcript.toolCalls.filter(call => call.name === 'Agent');
  if (transcript.toolCalls.some(call => call.name !== 'Agent')) throw new ChannelError('BLIND_TOOL_CALL_DETECTED', '主 agent 在盲评中调用了 Agent 之外的工具，结果已丢弃。');
  if (agentCalls.length !== 1) throw new ChannelError('BLIND_SUBAGENT_UNVERIFIED', `主 agent 没有恰好派发一次 ${BLIND_SUBAGENT} 子 agent，结果已丢弃。`);
  const call = agentCalls[0];
  if (String(call.args.subagent_type || '') !== BLIND_SUBAGENT) throw new ChannelError('BLIND_SUBAGENT_UNVERIFIED', `Agent 工具没有使用 ${BLIND_SUBAGENT} 子 agent，结果已丢弃。`);
  if (call.args.run_in_background === true) throw new ChannelError('BLIND_SUBAGENT_UNVERIFIED', '盲评子 agent 不能以后台任务运行，结果已丢弃。');
  const delegated = String(call.args.prompt || '');
  if (!tokens.every(token => delegated.includes(token))) throw new ChannelError('BLIND_SUBAGENT_UNVERIFIED', '子 agent 没有收到完整的盲评载荷，结果已丢弃。');
  if (normalize(delegated).length < normalize(payload).length * 0.85) throw new ChannelError('BLIND_SUBAGENT_UNVERIFIED', '子 agent 收到的盲评载荷不完整，结果已丢弃。');
  const output = transcript.toolResults.find(item => item.callId === call.id && item.name === 'Agent') || transcript.toolResults.find(item => item.callId === call.id);
  if (!output || output.status !== 'completed') throw new ChannelError('BLIND_SUBAGENT_UNVERIFIED', '子 agent 没有返回已完成的结果，结果已丢弃。');
  const text = stripAgentSuffix(output.text);
  if (!text) throw new ChannelError('BLIND_SUBAGENT_UNVERIFIED', '子 agent 返回为空，结果已丢弃。');
  return text;
}

function redact(value: string, key?: string): string {
  let safe = value;
  if (key) safe = safe.split(key).join('[REDACTED]');
  return safe.replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]').replace(/(api[_-]?key"?\s*[:=]\s*")[^"]+/gi, '$1[REDACTED]');
}

export class CodeBuddyChannel implements Channel {
  readonly id = 'codebuddy' as const;
  readonly caps = { blind: true, json: true, usage: true };
  private readonly cliPath = findCodeBuddy();
  private version?: string;
  private accountVerified = false;
  constructor(private readonly options: CodeBuddyOptions) {}

  private effectiveModel(): string {
    if (this.options.auth === 'model-api') return this.options.model;
    return process.env.WORKBENCH_CODEBUDDY_MODEL || 'auto';
  }
  private probeVersion(): string | undefined {
    if (!this.cliPath) return undefined;
    if (this.version === undefined) {
      const cached = versionCache.get(this.cliPath);
      if (cached) this.version = cached;
      else {
        const invocation = codeBuddyInvocation(this.cliPath);
        const probe = spawnSync(invocation.command, [...invocation.prefix, '--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true, env: codeBuddyEnvironment({}) });
        this.version = (probe.stdout || '').trim().split(/\r?\n/)[0]?.replace(/^v/i, '') || 'unknown';
        versionCache.set(this.cliPath, this.version);
      }
    }
    return this.version;
  }
  async status(): Promise<ChannelStatus> {
    if (!this.cliPath) return { id: this.id, label: 'CodeBuddy（本机 CLI）', kind: 'agent', code: 'not-installed', detail: '未找到本机 CodeBuddy CLI；可通过 WORKBENCH_CODEBUDDY_CLI 指定路径。' };
    const version = this.probeVersion();
    if (this.options.auth === 'model-api') {
      if (!this.options.apiKey) return { id: this.id, label: 'CodeBuddy（本机 CLI）', kind: 'agent', code: 'needs-key', version, detail: 'CodeBuddy 已安装，但作为后端的模型 API Key 未配置。' };
      return { id: this.id, label: 'CodeBuddy（本机 CLI）', kind: 'agent', code: 'ready', version, models: [this.effectiveModel()], detail: `本机主 agent · 模型 API 后端（${this.options.baseUrl || 'https://api.deepseek.com'}）` };
    }
    if (!this.accountVerified) return { id: this.id, label: 'CodeBuddy（本机 CLI）', kind: 'agent', code: 'needs-login', version, models: [this.effectiveModel()], detail: 'CodeBuddy 已安装；本机登录态尚未验证，未登录时请改用模型 API 后端。' };
    return { id: this.id, label: 'CodeBuddy（本机 CLI）', kind: 'agent', code: 'ready', version, models: [this.effectiveModel()], detail: '本机主 agent · CodeBuddy 登录态（不计入本应用预算）' };
  }

  async test(signal?: AbortSignal): Promise<ChannelTest> {
    const started = Date.now();
    if (!this.cliPath) return { ok: false, channel: this.id, latencyMs: 0, detail: '未找到本机 CodeBuddy CLI。' };
    if (this.options.auth === 'model-api' && !this.options.apiKey) return { ok: false, channel: this.id, latencyMs: 0, detail: '需要模型 API Key 才能使用 CodeBuddy 的模型 API 后端。' };
    try {
      const result = await this.direct({ skill: 'test', system: '你是连通性测试执行器。只回复 OK，不调用任何工具。', prompt: '回复 OK。', blind: false, json: false, signal, progress: () => undefined });
      return { ok: true, channel: this.id, auth: this.options.auth, model: result.model, latencyMs: Date.now() - started, detail: `连接成功 · ${result.model || this.effectiveModel()}` };
    } catch (error: any) {
      return { ok: false, channel: this.id, auth: this.options.auth, latencyMs: Date.now() - started, detail: redact(error instanceof Error ? error.message : String(error), this.options.apiKey) };
    }
  }

  async run(input: ChannelRun): Promise<ChannelResult> {
    throwIfAborted(input.signal);
    return input.blind ? this.blind(input) : this.direct(input);
  }

  private async direct(input: ChannelRun): Promise<ChannelResult> {
    throwIfAborted(input.signal);
    if (!this.cliPath) throw new ChannelError('CODEBUDDY_NOT_INSTALLED', '未检测到本机 CodeBuddy CLI。');
    if (this.options.auth === 'model-api' && !this.options.apiKey) throw new ChannelError('CODEBUDDY_NEEDS_KEY', 'CodeBuddy 的模型 API 后端需要 Key。');
    const invocation = codeBuddyInvocation(this.cliPath);
    const model = this.effectiveModel();
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cheat-codebuddy-'));
    const configDir = this.options.auth === 'model-api' ? await fs.mkdtemp(path.join(os.tmpdir(), 'cheat-codebuddy-config-')) : undefined;
    try {
      input.progress(`启动本机 CodeBuddy 主 agent · ${this.options.auth === 'model-api' ? '模型 API 后端' : '登录态'} · ${model}`);
      const args = [...invocation.prefix, '-p', '--output-format', 'json', '--model', model, '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--setting-sources', 'local', '--max-turns', '2'];
      const stdout = await this.execute(invocation.command, args, {
        input, cwd, configDir, signal: input.signal,
        environment: codeBuddyEnvironment({ configDir, apiKey: this.options.apiKey, baseUrl: this.options.baseUrl }),
      });
      const transcript = parseCodeBuddyTranscript(stdout);
      const result = transcript.result;
      if (!result || result.is_error === true || (result.subtype && result.subtype !== 'success')) throw new ChannelError('CODEBUDDY_FAILED', redact(String(result?.result || 'CodeBuddy 执行失败'), this.options.apiKey).slice(0, 400));
      const text = String(result.result || transcript.assistantText || '').trim();
      if (!text) throw new ChannelError('CODEBUDDY_BAD_OUTPUT', 'CodeBuddy 结束但没有返回可验证的文本。');
      if (this.options.auth === 'account') this.accountVerified = true;
      return {
        text,
        model: transcript.model || model,
        usage: result.usage,
        evidence: { channel: this.id, mode: 'direct', toolsDisabled: true, freshConfig: this.options.auth === 'model-api' },
      };
    } finally {
      await fs.rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      if (configDir) await fs.rm(configDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async blind(input: ChannelRun): Promise<ChannelResult> {
    throwIfAborted(input.signal);
    if (!this.cliPath) throw new ChannelError('BLIND_CHANNEL_UNAVAILABLE', '盲评需要本机 CodeBuddy CLI，但未检测到该程序。');
    if (this.options.auth !== 'model-api' || !this.options.apiKey) throw new ChannelError('BLIND_CHANNEL_UNAVAILABLE', '盲评需要 CodeBuddy 的模型 API 后端与临时隔离配置；请先在设置中配置模型 API Key。');
    const invocation = codeBuddyInvocation(this.cliPath);
    const model = this.options.blindModel;
    const { payload, tokens } = blindPayload(input.system, input.prompt);
    const agents = {
      [BLIND_SUBAGENT]: {
        description: 'Independent blind reviewer for one draft only',
        prompt: '你是独立盲评员。只依据本次任务中的稿件与纯评分规则评分；禁止参考历史、实绩、账号、对话或作品列表；不请求也不使用任何工具；最终只输出一个合法 JSON 对象，不要 Markdown 代码围栏。',
        tools: [],
        disallowedTools: ['Agent', 'Bash', 'Edit', 'Read', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'TaskOutput', 'NotebookEdit', 'BashOutput', 'KillShell'],
        model,
      },
    };
    const dispatcher = `你是受限的调度主 agent。你唯一的动作是调用一次名为 Agent 的工具，把下方「盲评载荷」原样交给子 agent ${BLIND_SUBAGENT}，然后原样输出子 agent 返回的文本。\n规则：\n1. 只调用一次 Agent；subagent_type 必须为 "${BLIND_SUBAGENT}"；run_in_background 必须为 false。\n2. Agent 的 prompt 参数必须逐字复制下方载荷全文（包含全部标记行），不得摘要、改写、补充或删除。\n3. 不得自己评分，不得调用其他工具，不得读取或写入文件，不得执行命令，不得补充任何创作者历史、账号、作品或实绩信息。\n\n${payload}`;
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cheat-codebuddy-blind-'));
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cheat-codebuddy-config-'));
    try {
      input.progress(`启动本机 CodeBuddy 主 agent，派生子 agent ${BLIND_SUBAGENT} · ${model}`);
      const args = [...invocation.prefix, '-p', '--output-format', 'json', '--model', model, '--agents', JSON.stringify(agents), '--tools', 'Agent', '--strict-mcp-config', '--no-session-persistence', '--setting-sources', 'local', '--max-turns', '3'];
      const stdout = await this.execute(invocation.command, args, {
        input: { ...input, prompt: dispatcher }, cwd, configDir, signal: input.signal, blind: true, timeoutMs: 300_000,
        environment: codeBuddyEnvironment({ configDir, apiKey: this.options.apiKey, baseUrl: this.options.baseUrl, blind: true }),
      });
      const violations = await blindIsolationViolations(configDir, cwd);
      if (violations.length) throw new ChannelError('BLIND_ISOLATION_VIOLATION', `盲评隔离校验失败：${violations.slice(0, 3).join('；')}`);
      const transcript = parseCodeBuddyTranscript(stdout);
      const text = verifyBlindDelegation(transcript, tokens, payload);
      input.progress('已通过子 agent 调用与隔离校验，采用子 agent 原始返回');
      return {
        text,
        model: transcript.model || model,
        usage: transcript.result?.usage,
        evidence: { channel: this.id, mode: 'blind-delegate', toolsDisabled: true, freshConfig: true, subagent: BLIND_SUBAGENT, toolCallVerified: true },
      };
    } finally {
      await fs.rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(configDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async execute(command: string, args: string[], context: { input: ChannelRun; cwd: string; configDir?: string; signal?: AbortSignal; blind?: boolean; timeoutMs?: number; environment: NodeJS.ProcessEnv }): Promise<string> {
    try {
      return await captureProcess(command, args, {
        cwd: context.cwd,
        environment: context.environment,
        input: `${context.input.system}\n\n当前阶段任务：\n${context.input.prompt}\n`,
        signal: context.signal,
        timeoutMs: context.timeoutMs,
        maxBytes: 8_000_000,
        onStderr: chunk => { if (/Authentication required|authentication_error/i.test(chunk)) context.input.progress('CodeBuddy 报告未登录', 'warning'); },
      });
    } catch (error: any) {
      if (error?.code === 'CANCELLED') throw error;
      const message = redact(String(error?.message || error), this.options.apiKey);
      if (/Authentication required|authentication_error|invalid api key|invalid_api_key|401/i.test(message)) throw new ChannelError('CODEBUDDY_AUTH_REQUIRED', '本机 CodeBuddy 未完成登录，或模型 API Key 无效。请改用模型 API 后端或在本机完成登录。');
      if (/超过 \d+ 秒/.test(message)) throw new ChannelError('CODEBUDDY_TIMEOUT', message);
      throw new ChannelError('CODEBUDDY_FAILED', message.slice(0, 500));
    }
  }
}
