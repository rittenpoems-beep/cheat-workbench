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
  if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  env.NO_COLOR = '1';
  return env;
}

export class CodexChannel implements Channel {
  readonly id = 'codex' as const;
  readonly caps = { blind: false, json: true, usage: false };
  private readonly command = executable('codex');
  async status(): Promise<ChannelStatus> {
    if (!this.command) return { id: this.id, label: 'Codex CLI', kind: 'agent', code: 'not-installed', detail: '未检测到 Codex CLI；该通道仍在持续开发，暂不保证兼容。' };
    return { id: this.id, label: 'Codex CLI', kind: 'agent', code: 'experimental', detail: '实验性接入：以只读沙箱运行，暂不保证兼容。' };
  }
  async run(input: ChannelRun): Promise<ChannelResult> {
    throwIfAborted(input.signal);
    if (!this.command) throw new ChannelError('CODEX_NOT_INSTALLED', '未检测到 Codex CLI。');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cheat-codex-'));
    try {
      input.progress('使用 Codex CLI（实验性通道）');
      const text = await runAgentProcess(this.command, ['exec', '--ignore-user-config', '--disable', 'shell_tool', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', directory, '-'], {
        provider: 'codex', cwd: directory, environment: environment(), input: `${input.system}\n\n当前阶段任务：\n${input.prompt}`, signal: input.signal, progress: input.progress,
      });
      return { text, evidence: { channel: this.id, mode: 'direct', toolsDisabled: true, freshConfig: false } };
    } finally { await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined); }
  }
}
