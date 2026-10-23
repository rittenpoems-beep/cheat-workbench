import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BROWSER_EXTENSION_ORIGIN, BROWSER_PROTOCOL,
  type BrowserAccount, type BrowserCommand, type BrowserCommandInput,
  type BrowserEvent, type BrowserPairing, type BrowserPoll, type BrowserStatus,
} from '../shared/browser.js';

const PAIR_TTL_MS = 10 * 60 * 1000;
const CONNECTED_TTL_MS = 45 * 1000;
const COMMAND_TTL_MS = 60 * 1000;
const TOMBSTONE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_POLL_TIMEOUT_MS = 25 * 1000;
const PERSIST_INTERVAL_MS = 10 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TOKEN_PATTERN = /^wbc_[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export class BrowserBridgeError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = 'BrowserBridgeError';
  }
}

interface StoredBrowser {
  version: 1;
  tokenHash: string;
  extensionOrigin: string;
  browserName: string;
  extensionVersion: string;
  pairedAt: string;
  lastSeenAt: string | null;
  lastConfirmedAccount: BrowserAccount | null;
  lastSyncAt: string | null;
}

interface PairingCode { digest: string; expiresAt: number }
interface QueuedCommand { wire: BrowserCommand; expiresAtMs: number }
interface Waiter { finish: (command: BrowserCommand | null) => void; timer: NodeJS.Timeout }

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const hashToken = (token: string) => sha256(token);
const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashPairingCode = (code: string) => sha256(normalizeCode(code));

function safeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function text(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function accountFrom(value: unknown): BrowserAccount | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const name = text(record.name, 120);
  if (!name) return null;
  const id = text(record.id, 120);
  return id ? { name, id } : { name };
}

function validStored(value: unknown): value is StoredBrowser {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && typeof record.tokenHash === 'string' && HASH_PATTERN.test(record.tokenHash)
    && typeof record.extensionOrigin === 'string' && BROWSER_EXTENSION_ORIGIN.test(record.extensionOrigin)
    && typeof record.browserName === 'string'
    && typeof record.extensionVersion === 'string'
    && typeof record.pairedAt === 'string'
    && (record.lastSeenAt === null || typeof record.lastSeenAt === 'string')
    && (record.lastConfirmedAccount === null || accountFrom(record.lastConfirmedAccount) !== null)
    && (record.lastSyncAt === null || typeof record.lastSyncAt === 'string');
}

/**
 * Persistent, origin-bound pairing between the workbench and the Edge extension.
 * Only the token hash is stored; the token itself never touches disk.
 */
export class BrowserBridge {
  private record: StoredBrowser | null = null;
  private corrupt = false;
  private error: string | undefined;
  private pairing: PairingCode | null = null;
  private waiter: Waiter | null = null;
  private queue: QueuedCommand[] = [];
  private deliveredTaskIds = new Set<string>();
  private activeTasks = new Set<string>();
  private tombstones = new Map<string, number>();
  private hits = new Map<string, number[]>();
  private attached = false;
  private lastPersistedAt = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private eventHandler: ((event: BrowserEvent) => void) | null = null;
  private closed = false;

  constructor(private directory: string, private options: { extensionPath: string; now?: () => number; pollTimeoutMs?: number }) {}

  private get file() { return path.join(this.directory, 'browser.json'); }
  private now() { return this.options.now ? this.options.now() : Date.now(); }
  private iso() { return new Date(this.now()).toISOString(); }

  async init() {
    await mkdir(this.directory, { recursive: true });
    this.lastPersistedAt = this.now();
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (!validStored(saved)) throw new Error('配对记录格式无效。');
      this.record = saved;
    } catch (error: any) {
      if (error.code === 'ENOENT') return;
      this.corrupt = true;
      this.record = null;
      this.error = '本机配对记录无法读取，请重新配对。原文件已保留，不会被自动删除。';
      console.error('连接配对记录读取失败：', error.message);
    }
  }

  status(): BrowserStatus {
    const connected = Boolean(this.record) && this.attached && this.record?.lastSeenAt != null
      && this.now() - Date.parse(this.record.lastSeenAt) <= CONNECTED_TTL_MS;
    return {
      connected,
      browserName: this.record?.browserName || null,
      version: this.record?.extensionVersion || null,
      lastSeenAt: this.record?.lastSeenAt || null,
      pairingRequired: this.record === null,
      account: this.record?.lastConfirmedAccount || null,
      lastSyncAt: this.record?.lastSyncAt || null,
      extensionPath: this.options.extensionPath,
      protocol: BROWSER_PROTOCOL,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  requirePaired(): StoredBrowser {
    if (!this.record) throw new BrowserBridgeError('BROWSER_UNPAIRED', this.corrupt ? '配对记录损坏，请重新配对。' : '尚未连接 Edge 扩展。', 409);
    return this.record;
  }

  async createPairing(): Promise<BrowserPairing> {
    this.rate('pair-create', 5, PAIR_TTL_MS);
    let raw = '';
    for (let index = 0; index < 8; index += 1) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    const expiresAt = this.now() + PAIR_TTL_MS;
    this.pairing = { digest: hashPairingCode(code), expiresAt };
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  async pair(input: { code: string; browserName: string; version: string; origin: string; protocol: number }): Promise<{ token: string; protocol: number }> {
    this.rate('pair-attempt', 5, PAIR_TTL_MS);
    if (input.protocol !== BROWSER_PROTOCOL) throw new BrowserBridgeError('EXTENSION_OUTDATED', '扩展协议版本不匹配，请重新加载扩展。', 409);
    if (!BROWSER_EXTENSION_ORIGIN.test(input.origin)) throw new BrowserBridgeError('ORIGIN_REQUIRED', '扩展来源无效，无法配对。', 403);
    const pairing = this.pairing;
    if (!pairing) throw new BrowserBridgeError('PAIRING_INVALID', '配对码不存在或已被使用，请重新生成。', 410);
    if (pairing.expiresAt <= this.now()) {
      this.pairing = null;
      throw new BrowserBridgeError('PAIRING_EXPIRED', '配对码已过期，请重新生成。', 410);
    }
    if (!safeEqual(hashPairingCode(input.code), pairing.digest)) throw new BrowserBridgeError('PAIRING_INVALID', '配对码不正确。', 401);

    const token = `wbc_${randomBytes(32).toString('base64url')}`;
    this.record = {
      version: 1,
      tokenHash: hashToken(token),
      extensionOrigin: input.origin,
      browserName: text(input.browserName, 60) || 'Microsoft Edge',
      extensionVersion: text(input.version, 40) || '0.0.0',
      pairedAt: this.iso(),
      lastSeenAt: this.iso(),
      lastConfirmedAccount: this.record?.lastConfirmedAccount ?? null,
      lastSyncAt: this.record?.lastSyncAt ?? null,
    };
    this.pairing = null;
    this.corrupt = false;
    this.error = undefined;
    this.attached = true;
    this.lastPersistedAt = this.now();
    await this.persist();
    return { token, protocol: BROWSER_PROTOCOL };
  }

  authenticate(token: string | undefined, origin: string | undefined): StoredBrowser {
    const record = this.record;
    if (!record) throw new BrowserBridgeError('BROWSER_UNPAIRED', '尚未连接 Edge 扩展。', 401);
    if (!token || !TOKEN_PATTERN.test(token)) throw new BrowserBridgeError('TOKEN_INVALID', '扩展令牌无效，请重新配对。', 401);
    if (!origin || !BROWSER_EXTENSION_ORIGIN.test(origin)) throw new BrowserBridgeError('ORIGIN_REQUIRED', '扩展请求缺少有效来源。', 403);
    if (origin !== record.extensionOrigin) throw new BrowserBridgeError('ORIGIN_MISMATCH', '扩展来源与配对记录不一致。', 403);
    if (!safeEqual(hashToken(token), record.tokenHash)) throw new BrowserBridgeError('TOKEN_INVALID', '扩展令牌无效，请重新配对。', 401);
    return record;
  }

  async poll(token: string | undefined, origin: string | undefined, activeTaskId?: string): Promise<BrowserPoll> {
    this.authenticate(token, origin);
    this.rate('poll', 4, 1000);
    this.touch();
    if (this.closed) return this.wirePoll(null);
    const goneTaskId = this.goneTask(activeTaskId);
    const command = this.takeCommand();
    if (command) return this.wirePoll(command);
    if (goneTaskId) return this.wirePoll(null, goneTaskId);
    return new Promise<BrowserPoll>(resolve => {
      let settled = false;
      const finish = (next: BrowserCommand | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.waiter?.finish === finish) this.waiter = null;
        resolve(this.wirePoll(next, this.goneTask(activeTaskId)));
      };
      const timer = setTimeout(() => finish(null), this.options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS);
      const previous = this.waiter;
      this.waiter = { finish, timer };
      previous?.finish(null);
    });
  }

  async handleEvent(token: string | undefined, origin: string | undefined, event: BrowserEvent): Promise<{ ok: true; gone?: boolean }> {
    this.authenticate(token, origin);
    this.rate('event', 120, 60 * 1000);
    this.touch();
    if (this.isGone(event.taskId)) return { ok: true, gone: true };
    try { this.eventHandler?.(event); } catch (error) {
      console.error('处理扩展事件失败：', error instanceof Error ? error.message : error);
    }
    return { ok: true };
  }

  onEvent(handler: ((event: BrowserEvent) => void) | null) { this.eventHandler = handler; }

  enqueue(input: BrowserCommandInput): BrowserCommand {
    const command: BrowserCommand = {
      id: randomUUID(),
      kind: input.kind,
      taskId: input.taskId,
      ...(input.kind === 'sync' ? { limit: input.limit ?? 10 } : {}),
      expiresAt: new Date(this.now() + COMMAND_TTL_MS).toISOString(),
      protocol: BROWSER_PROTOCOL,
    };
    this.queue = this.queue.filter(item => !(item.wire.taskId === command.taskId && item.wire.kind === command.kind));
    this.queue.push({ wire: command, expiresAtMs: this.now() + COMMAND_TTL_MS });
    this.wake();
    return command;
  }

  registerTask(taskId: string) { this.activeTasks.add(taskId); }

  async finishTask(taskId: string) {
    this.activeTasks.delete(taskId);
    this.deliveredTaskIds.delete(taskId);
    this.queue = this.queue.filter(item => item.wire.taskId !== taskId);
    this.tombstones.set(taskId, this.now() + TOMBSTONE_TTL_MS);
  }

  currentAccount() { return this.record?.lastConfirmedAccount ?? null; }

  async rememberAccount(account: BrowserAccount) {
    if (!this.record) return;
    this.record.lastConfirmedAccount = accountFrom(account);
    await this.persist();
  }

  async rememberSync() {
    if (!this.record) return;
    this.record.lastSyncAt = this.iso();
    await this.persist();
  }

  async disconnect() {
    this.record = null;
    this.corrupt = false;
    this.error = undefined;
    this.pairing = null;
    this.attached = false;
    this.queue = [];
    this.deliveredTaskIds.clear();
    this.activeTasks.clear();
    this.waiter?.finish(null);
    await rm(this.file, { force: true });
  }

  async close() {
    this.closed = true;
    this.waiter?.finish(null);
    await this.flush();
  }

  flush() { return this.writeChain; }

  private goneTask(activeTaskId?: string) {
    if (!activeTaskId) return undefined;
    const known = this.activeTasks.has(activeTaskId)
      || this.deliveredTaskIds.has(activeTaskId)
      || this.queue.some(item => item.wire.taskId === activeTaskId);
    return known ? undefined : activeTaskId;
  }

  private isGone(taskId: string) {
    const expiry = this.tombstones.get(taskId);
    if (expiry === undefined) return false;
    if (expiry <= this.now()) { this.tombstones.delete(taskId); return false; }
    return true;
  }

  private takeCommand() {
    while (this.queue.length) {
      const item = this.queue.shift()!;
      if (item.expiresAtMs <= this.now() || this.isGone(item.wire.taskId)) continue;
      this.deliveredTaskIds.add(item.wire.taskId);
      return item.wire;
    }
    return null;
  }

  private wake() {
    if (!this.waiter) return;
    const command = this.takeCommand();
    if (command) this.waiter.finish(command);
  }

  private wirePoll(command: BrowserCommand | null, goneTaskId?: string): BrowserPoll {
    return {
      command,
      account: this.record?.lastConfirmedAccount ?? null,
      lastSyncAt: this.record?.lastSyncAt ?? null,
      protocol: BROWSER_PROTOCOL,
      ...(goneTaskId ? { goneTaskId } : {}),
    };
  }

  private touch() {
    if (!this.record) return;
    this.attached = true;
    this.record.lastSeenAt = this.iso();
    if (this.now() - this.lastPersistedAt >= PERSIST_INTERVAL_MS) {
      this.lastPersistedAt = this.now();
      void this.persist().catch(error => console.error('连接状态保存失败：', error instanceof Error ? error.message : error));
    }
  }

  private rate(key: string, max: number, windowMs: number) {
    const now = this.now();
    const hits = (this.hits.get(key) || []).filter(at => now - at < windowMs);
    if (hits.length >= max) {
      this.hits.set(key, hits);
      throw new BrowserBridgeError('RATE_LIMITED', '操作过于频繁，请稍后再试。', 429);
    }
    hits.push(now);
    this.hits.set(key, hits);
  }

  private persist(): Promise<void> {
    const record = this.record;
    if (!record) return Promise.resolve();
    const snapshot = JSON.stringify(record, null, 2);
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.file);
    });
    return this.writeChain;
  }
}
