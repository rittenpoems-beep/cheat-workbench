import { promises as fs } from 'node:fs';
import path from 'node:path';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MARKER = '.workbench-collector-session.json';
const ARTIFACTS = ['login.png', 'login.pending.png', 'confirm.json'] as const;

export interface ConnectionRecovery {
  cleaned: boolean;
  reason: string;
  workerPid?: number;
}

interface SessionMarker {
  token: string;
  pid: number;
  createdAt: string;
}

function failure(message: string): Error & { code: string } {
  return Object.assign(new Error(`CLEANUP_FAILED：${message}`), { code: 'CLEANUP_FAILED' });
}

async function statIfPresent(file: string) {
  try { return await fs.lstat(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw failure('无法检查临时会话文件状态，未确认清理完成。');
  }
}

// The caller must derive this path from a registered task ID, never from an HTTP
// filename. UUID and containment checks provide an additional guard against a
// mistaken cleanup target. Existing ancestors, junctions and known child paths
// are checked with lstat so a link is never traversed for recursive deletion.
async function checkedDirectory(input: string): Promise<string> {
  if (!path.isAbsolute(input)) throw failure('任务目录必须为绝对路径。');
  const directory = path.resolve(input);
  if (!UUID.test(path.basename(directory)) || path.basename(path.dirname(directory)) !== 'connections') {
    throw failure('只能清理由任务登记生成的 connections/UUID 目录。');
  }
  let current = directory;
  while (true) {
    const stat = await statIfPresent(current);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw failure('任务目录或祖先是链接或非目录，拒绝清理。');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directory;
}

function contained(directory: string, ...parts: string[]): string {
  const target = path.resolve(directory, ...parts);
  const relative = path.relative(directory, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw failure('清理目标超出任务目录。');
  return target;
}

async function checkedFile(file: string): Promise<boolean> {
  const stat = await statIfPresent(file);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isFile()) throw failure('已知临时文件被替换为链接或非普通文件，拒绝清理。');
  return true;
}

async function checkedChildDirectory(directory: string): Promise<boolean> {
  const stat = await statIfPresent(directory);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure('旧版会话目录是链接或非目录，拒绝递归清理。');
  return true;
}

function validClaim(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const claim = value as Record<string, unknown>;
  return claim.profileRemoved === true && claim.loginViewRemoved === true && claim.browserClosed === true;
}

/** Validate completion claims against the actual known credential artifacts. */
export async function validateConnectionCleanup(taskDirectory: string, claimed?: unknown): Promise<void> {
  const hasClaim = arguments.length > 1;
  const directory = await checkedDirectory(taskDirectory);
  if (hasClaim && !validClaim(claimed)) throw failure('采集器未确认旧版登录资料、截图与浏览器均已清理。');
  const session = contained(directory, 'profile');
  await checkedChildDirectory(session);
  const targets = [contained(directory, 'profile', 'profile'), ...ARTIFACTS.map(name => contained(directory, name))];
  for (const target of targets) if (await statIfPresent(target)) throw failure('旧版登录资料、截图或确认文件仍存在。');
}

async function markerAt(file: string): Promise<SessionMarker | undefined> {
  if (!await checkedFile(file)) return undefined;
  try {
    const stat = await fs.stat(file);
    if (stat.size > 16_384) throw new Error('oversized marker');
    const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid marker');
    const marker = value as Record<string, unknown>;
    if (typeof marker.token !== 'string' || !UUID.test(marker.token)
      || !Number.isSafeInteger(marker.pid) || (marker.pid as number) <= 0 || (marker.pid as number) > 2_147_483_647
      || typeof marker.createdAt !== 'string' || Number.isNaN(Date.parse(marker.createdAt))) throw new Error('invalid marker');
    // Retain only the fields our worker writes, never unknown marker contents.
    return { token: marker.token, pid: marker.pid as number, createdAt: marker.createdAt };
  } catch {
    throw failure('会话归属标记损坏，无法安全确认旧 Worker。');
  }
}

/** Read only the known PNG; static-file defaults reject our hidden data folders. */
export async function readConnectionView(taskDirectory: string): Promise<Buffer | undefined> {
  const directory = await checkedDirectory(taskDirectory);
  const file = contained(directory, 'login.png');
  if (!await checkedFile(file)) return undefined;
  const stat = await fs.stat(file);
  if (stat.size > 8_000_000) throw new Error('登录画面超出读取大小限制。');
  try { return await fs.readFile(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

function workerAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // Access denied is evidence of a live process, not permission to delete its
    // profile. A reused PID is conservatively treated as still alive as well.
    if (code === 'EPERM' || code === 'EACCES') return true;
    throw failure('无法验证旧 Worker 是否停止，未删除登录资料。');
  }
}

async function requestCancellation(file: string): Promise<void> {
  if (await checkedFile(file)) return;
  let handle;
  try {
    handle = await fs.open(file, 'wx');
    await handle.writeFile('{}', 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw failure('无法写入旧任务取消请求，未开始清理。');
    await checkedFile(file);
  } finally { await handle?.close(); }
}

/**
 * Recover one registered task after restart. Never kills or waits for a live
 * process. Cancellation can finish on its own; the caller can recheck later.
 */
export async function recoverConnection(taskDirectory: string): Promise<ConnectionRecovery> {
  const directory = await checkedDirectory(taskDirectory);
  if (!await statIfPresent(directory)) return { cleaned: true, reason: '任务没有创建临时会话目录。' };
  const session = contained(directory, 'profile');
  const browserProfile = contained(directory, 'profile', 'profile');
  const sessionExists = await checkedChildDirectory(session);
  const profileExists = sessionExists && await checkedChildDirectory(browserProfile);
  for (const name of ARTIFACTS) await checkedFile(contained(directory, name));
  await requestCancellation(contained(directory, 'cancel.json'));

  let marker: SessionMarker | undefined;
  if (sessionExists) await checkedFile(contained(directory, 'profile', MARKER));
  try { marker = sessionExists ? await markerAt(contained(directory, 'profile', MARKER)) : undefined; }
  catch (error) {
    if (profileExists) throw error;
    // With no browser profile, unknown metadata cannot authorize recursion, but
    // does not stop removal of explicitly named screenshots in a registered task.
  }
  if (marker && workerAlive(marker.pid)) return { cleaned: false, workerPid: marker.pid, reason: '旧 Worker 仍在运行，已请求取消；暂不删除其会话目录。' };
  if (profileExists && !marker) throw failure('浏览器资料仍存在但缺少有效归属标记，拒绝递归删除。');

  try {
    // fs.rm removes nested symbolic links themselves; it does not follow them.
    // The deletion root and all its ancestors were checked above with lstat.
    if (profileExists) await fs.rm(browserProfile, { recursive: true, force: true });
    for (const name of ARTIFACTS) await fs.rm(contained(directory, name), { force: true });
    if (marker) await fs.writeFile(contained(directory, 'profile', MARKER), JSON.stringify({ ...marker, cleanedAt: new Date().toISOString(), profileRemoved: true }, null, 2), 'utf8');
  } catch { throw failure('旧任务文件仍被占用或无法删除，未确认清理完成。'); }
  await validateConnectionCleanup(directory);
  return { cleaned: true, ...(marker ? { workerPid: marker.pid } : {}), reason: '已验证旧任务的登录资料、截图与确认文件均不存在。' };
}
