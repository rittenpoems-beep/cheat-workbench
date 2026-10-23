import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Progress } from './types.js';
import { abortError } from './types.js';

export function executable(name: string): string | undefined {
  const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  const paths = probe.stdout?.trim().split(/\r?\n/).filter(Boolean) || [];
  return paths.find(candidate => process.platform !== 'win32' || /\.exe$/i.test(candidate)) || (process.platform !== 'win32' ? paths[0] : undefined);
}

export function installed(pathname: string | undefined): pathname is string {
  return !!pathname && existsSync(pathname);
}

/** Kill the whole process tree before resolving so callers can remove the working directory. */
export function terminate(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise<void>(done => {
    if (!child.pid) { done(); return; }
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
      killer.once('error', () => { child.kill(); done(); });
      killer.once('close', code => { if (code !== 0) child.kill(); done(); });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch { child.kill('SIGKILL'); }
      done();
    }
  });
}

export interface CaptureOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  input: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  onStderr?: (text: string) => void;
}

/** Runs one child process and returns its stdout only after the process tree is gone. */
export async function captureProcess(command: string, args: string[], options: CaptureOptions): Promise<string> {
  if (options.signal?.aborted) throw abortError();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.environment, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', terminalError = '', terminating: Promise<void> | undefined;
    const stop = (reason: string) => {
      if (terminating) return;
      terminalError = reason;
      terminating = terminate(child);
    };
    const timeout = setTimeout(() => stop(`Agent 执行超过 ${Math.round((options.timeoutMs ?? 180_000) / 1000)} 秒。当前步骤可重试，已有文件已保留。`), options.timeoutMs ?? 180_000);
    const abort = () => stop('任务已取消。');
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > (options.maxBytes ?? 2_000_000)) stop('Agent 输出超出上限，已停止当前任务。');
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8_000); options.onStderr?.(String(chunk)); });
    child.once('error', error => { terminalError ||= error.message; });
    child.stdin.on('error', error => { terminalError ||= error.message; });
    child.once('close', async code => {
      clearTimeout(timeout); options.signal?.removeEventListener('abort', abort);
      await terminating;
      if (options.signal?.aborted) reject(abortError());
      else if (code !== 0 || terminalError) reject(Object.assign(new Error(terminalError || stderr || `进程退出码 ${code}`), { code: 'PROCESS_FAILED' }));
      else resolve(stdout);
    });
    child.stdin.end(options.input);
  });
}

export interface AgentProcessOptions {
  provider: 'codex' | 'claude'; cwd: string; environment: NodeJS.ProcessEnv; input: string;
  signal?: AbortSignal; progress: Progress; timeoutMs?: number; redact?: (value: string) => string;
}

/** Codex/Claude experimental runners. They reject only after the process tree has exited. */
export async function runAgentProcess(command: string, args: string[], options: AgentProcessOptions): Promise<string> {
  if (options.signal?.aborted) throw abortError();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.environment, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', partial = '', resultText = '', terminalError = '';
    let termination: Promise<void> | undefined;
    const stop = (reason: string) => {
      if (termination) return;
      terminalError = reason;
      termination = terminate(child);
    };
    const timeout = setTimeout(() => stop('Agent 执行超过 180 秒。当前步骤可重试，已有文件已保留。'), options.timeoutMs ?? 180_000);
    const abort = () => stop('任务已取消。');
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const eventLine = (line: string) => {
      try {
        const event = JSON.parse(line);
        if (event.type === 'thread.started') options.progress('Agent 已建立独立会话');
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') resultText = event.item.text || '';
        if (event.type === 'turn.failed' || event.type === 'error') terminalError = event.error?.message || event.message || 'Agent 执行失败';
      } catch { /* Non-JSON diagnostics do not count as a result. */ }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 2_000_000) { stop('Agent 输出超出上限，已停止当前任务。'); return; }
      if (options.provider !== 'codex') return;
      partial += chunk; const lines = partial.split(/\r?\n/); partial = lines.pop() || '';
      for (const line of lines) eventLine(line);
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-6000); });
    child.once('error', error => { terminalError ||= error.message; });
    child.stdin.on('error', error => { terminalError ||= error.message; });
    child.once('close', async code => {
      clearTimeout(timeout); options.signal?.removeEventListener('abort', abort);
      await termination;
      if (options.provider === 'codex' && partial.trim()) eventLine(partial);
      if (options.provider === 'claude' && !termination) {
        try { const object = JSON.parse(stdout.trim()); if (object.is_error || object.api_error_status) terminalError = object.result || 'Claude API 执行失败'; else resultText = object.result || ''; }
        catch { terminalError = 'Claude 未返回合法的结果对象。'; }
      }
      if (options.signal?.aborted) reject(abortError());
      else if (code !== 0 || terminalError) reject(Object.assign(new Error((options.redact || (value => value))(terminalError || stderr || `${options.provider} 退出码 ${code}`).slice(0, 500)), { code: options.provider === 'claude' ? 'CLAUDE_FAILED' : 'CODEX_FAILED' }));
      else if (!resultText.trim()) reject(new Error('Agent 结束但没有可验证的结果。'));
      else resolve(resultText);
    });
    child.stdin.end(options.input);
  });
}
