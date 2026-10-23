import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChannelStatus } from '../../shared/types.js';
import type { Channel, ChannelResult, ChannelRun } from './types.js';
import { ChannelError, throwIfAborted } from './types.js';
import { executable, runAgentProcess } from './process.js';

function environment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'COMSPEC', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'LANG', 'LC_ALL', 'USERNAME', 'USERDOMAIN', 'SHELL']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']) if (process.env[name]) env[name] = process.env[name];
  if (env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = env.ANTHROPIC_AUTH_TOKEN;
  env.NO_COLOR = '1';
  return env;
}

export class ClaudeChannel implements Channel {
  readonly id = 'claude' as const;
  readonly caps = { blind: false, json: true, usage: false };
  private readonly command = executable('claude');
  async status(): Promise<ChannelStatus> {
    if (!this.command) return { id: this.id, label: 'Claude CLI', kind: 'agent', code: 'not-installed', detail: '未检测到 Claude CLI；该通道仍在持续开发，暂不保证兼容。' };
    return { id: this.id, label: 'Claude CLI', kind: 'agent', code: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? 'experimental' : 'needs-login', detail: '实验性接入：参数随 Claude Code 版本变化，暂不保证兼容。' };
  }
  async run(input: ChannelRun): Promise<ChannelResult> {
    throwIfAborted(input.signal);
    if (!this.command) throw new ChannelError('CLAUDE_NOT_INSTALLED', '未检测到 Claude CLI。');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cheat-claude-'));
    try {
      input.progress('使用 Claude CLI（实验性通道）');
      const text = await runAgentProcess(this.command, ['--bare', '-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--system-prompt', input.system], {
        provider: 'claude', cwd: directory, environment: environment(), input: input.prompt, signal: input.signal, progress: input.progress,
        redact: value => value.split(process.env.ANTHROPIC_AUTH_TOKEN || '\u0000').join('[REDACTED]'),
      });
      return { text, evidence: { channel: this.id, mode: 'direct', toolsDisabled: true, freshConfig: false } };
    } finally { await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined); }
  }
}
