import type { BrowserAccount, BrowserEvent, BrowserSyncPhase } from '../shared/browser.js';
import { DouyinImportError, validateImportedWorks } from '../shared/douyin.js';
import type { Task } from '../shared/types.js';
import type { BrowserBridge } from './browser-bridge.js';
import type { Jobs } from './jobs.js';
import type { Workspace } from './workspace.js';

const MAX_LIMIT = 30;
const DEFAULTS = {
  acceptMs: 10_000,
  confirmMs: 120_000,
  inactivityMs: 90_000,
  totalMs: 15 * 60_000,
  cancelAckMs: 5_000,
};
const ACTIVE = ['queued', 'running', 'waiting', 'cancelling'];

export class BrowserSyncError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409, public readonly cancelled = false) {
    super(message);
    this.name = 'BrowserSyncError';
  }
}

interface SyncResult {
  transport: 'browser';
  phase: 'done';
  account: BrowserAccount | null;
  count: number;
  limit: number;
}

interface Timings { acceptMs: number; confirmMs: number; inactivityMs: number; totalMs: number; cancelAckMs: number }

interface Session {
  task: Task;
  signal: AbortSignal;
  limit: number;
  phase: BrowserSyncPhase;
  account: BrowserAccount | null;
  confirmed: boolean;
  awaitingConfirmation: boolean;
  accepted: boolean;
  cancelRequested: boolean;
  settled: boolean;
  chain: Promise<void>;
  acceptTimer: NodeJS.Timeout | null;
  confirmTimer: NodeJS.Timeout | null;
  inactivityTimer: NodeJS.Timeout | null;
  totalTimer: NodeJS.Timeout | null;
  cancelTimer: NodeJS.Timeout | null;
  onAbort: () => void;
  resolve: (result: SyncResult) => void;
  reject: (error: Error) => void;
}

const iso = () => new Date().toISOString();
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const active = (task: Task) => ACTIVE.includes(task.status);

export function normalizeName(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/g, '');
}

/** Account identity: compare ids when both sides have one, otherwise normalized names. */
export function sameAccount(left: BrowserAccount | null | undefined, right: BrowserAccount | null | undefined): boolean {
  if (!left || !right) return false;
  if (left.id && right.id) return left.id === right.id;
  const name = normalizeName(left.name);
  return Boolean(name) && name === normalizeName(right.name);
}

function accountFrom(value: unknown): BrowserAccount | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim().slice(0, 120) : '';
  if (!name) return null;
  const id = typeof record.id === 'string' ? record.id.trim().slice(0, 120) : '';
  return id ? { name, id } : { name };
}

/**
 * Orchestrates one browser-backed sync at a time. The extension drives the
 * tab; this class owns the task truth, the account-confirmation gate and the
 * single point where validated works reach the workspace.
 */
export class BrowserSync {
  private session: Session | null = null;

  constructor(private bridge: BrowserBridge, private jobs: Jobs, private workspace: Workspace, private timings: Partial<Timings> = {}) {
    bridge.onEvent(event => this.handleEvent(event));
  }

  get activeTaskId(): string | null { return this.session?.task.id ?? null; }

  async start(task: Task, signal: AbortSignal, requestedLimit: unknown): Promise<SyncResult> {
    if (this.session) throw new BrowserSyncError('SYNC_IN_PROGRESS', '已有同步任务正在进行。');
    const status = this.bridge.status();
    if (status.pairingRequired) throw new BrowserSyncError('BROWSER_UNPAIRED', '尚未连接 Edge 扩展，请先完成一次配对。');
    if (!status.connected) throw new BrowserSyncError('BROWSER_OFFLINE', 'Edge 扩展当前没有响应，请确认 Edge 已打开并保持扩展启用。');
    if (signal.aborted) throw new BrowserSyncError('CANCELLED', '同步已取消。', 409, true);

    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(requestedLimit)) || 10));
    let settle!: { resolve: (result: SyncResult) => void; reject: (error: Error) => void };
    const waited = new Promise<SyncResult>((resolve, reject) => { settle = { resolve, reject }; });
    const session: Session = {
      task, signal, limit, phase: 'queued', account: null, confirmed: false,
      awaitingConfirmation: false, accepted: false, cancelRequested: false, settled: false,
      chain: Promise.resolve(), acceptTimer: null, confirmTimer: null, inactivityTimer: null,
      totalTimer: null, cancelTimer: null, onAbort: () => undefined,
      resolve: settle.resolve, reject: settle.reject,
    };
    this.session = session;
    const timings = { ...DEFAULTS, ...this.timings };
    const onAbort = () => this.requestCancel(session, timings.cancelAckMs);
    session.onAbort = onAbort;
    signal.addEventListener('abort', onAbort, { once: true });

    this.setPhase(session, 'queued');
    this.jobs.event(task, '已请求 Edge 扩展接手；复用当前浏览器的抖音登录，不需要重新登录');
    this.bridge.registerTask(task.id);
    this.bridge.enqueue({ kind: 'sync', taskId: task.id, limit });
    session.acceptTimer = setTimeout(() => this.fail(session, new BrowserSyncError('EXTENSION_TIMEOUT', 'Edge 扩展没有响应本次同步，请确认扩展已启用并重新同步。')), timings.acceptMs);
    session.totalTimer = setTimeout(() => this.fail(session, new BrowserSyncError('SYNC_TIMEOUT', '本次同步超过 15 分钟仍未完成，请重试。')), timings.totalMs);

    try {
      return await waited;
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.clearTimers(session);
      if (this.session === session) this.session = null;
      await this.bridge.finishTask(task.id);
    }
  }

  confirm(taskId: string): Task {
    const session = this.session;
    if (!session || session.task.id !== taskId || session.settled) throw new BrowserSyncError('NO_ACTIVE_SYNC', '当前没有等待确认的同步任务。');
    if (!session.awaitingConfirmation) throw new BrowserSyncError('NOT_WAITING_CONFIRMATION', '当前没有等待确认的账号。');
    if (!session.account) throw new BrowserSyncError('ACCOUNT_UNKNOWN', '尚未识别到抖音账号，暂时不能确认。');
    this.approve(session, false);
    return session.task;
  }

  async cancelAll(): Promise<void> {
    for (const task of [...this.jobs.tasks]) {
      if (task.kind === 'sync' && active(task)) {
        try { await this.jobs.cancel(task.id); } catch { /* A save in flight may finish first. */ }
      }
    }
  }

  private handleEvent(event: BrowserEvent) {
    const session = this.session;
    if (!session || session.task.id !== event.taskId) return;
    session.chain = session.chain
      .then(() => this.process(session, event))
      .catch(error => this.fail(session, error));
  }

  private async process(session: Session, event: BrowserEvent) {
    if (session.settled) return;
    if (session.cancelRequested) {
      if (event.type === 'cancelled' || event.type === 'error') {
        this.fail(session, new BrowserSyncError('CANCELLED', '同步已取消，未导入任何作品。', 409, true));
      }
      return;
    }
    if (session.acceptTimer) { clearTimeout(session.acceptTimer); session.acceptTimer = null; }
    const task = session.task;

    switch (event.type) {
      case 'accepted': {
        session.accepted = true;
        this.setPhase(session, event.phase || 'opening');
        this.jobs.event(task, event.message || 'Edge 扩展已接手，正在复用或打开创作者中心');
        this.restartInactivity(session);
        return;
      }
      case 'login_required': {
        session.phase = 'login';
        task.status = 'waiting';
        this.setPhase(session, 'login');
        this.clearTimer(session, 'inactivityTimer');
        this.jobs.event(task, event.message || '请在同一 Edge 标签完成抖音登录，并保持创作者中心页面打开');
        return;
      }
      case 'account': {
        const account = accountFrom(event.account);
        if (!account) {
          this.fail(session, new BrowserSyncError('ACCOUNT_UNKNOWN', '创作者中心没有返回可识别的账号名称，请重新登录后再同步。'));
          return;
        }
        session.account = account;
        if (session.confirmed) return;
        if (sameAccount(this.bridge.currentAccount(), account)) {
          this.jobs.event(task, `账号「${account.name}」与上次同步一致，自动继续`);
          this.approve(session, true);
        } else {
          session.awaitingConfirmation = true;
          task.status = 'waiting';
          this.setPhase(session, 'account', { account, requiresConfirmation: true });
          this.clearTimer(session, 'inactivityTimer');
          this.jobs.event(task, `识别到账号「${account.name}」；请确认后再读取作品`);
          this.clearTimer(session, 'confirmTimer');
          const timings = { ...DEFAULTS, ...this.timings };
          session.confirmTimer = setTimeout(() => this.fail(session, new BrowserSyncError('ACCOUNT_CONFIRM_TIMEOUT', '等待账号确认超过 120 秒，请重新同步。')), timings.confirmMs);
        }
        return;
      }
      case 'progress': {
        const phase = event.phase || session.phase;
        if (event.account) session.account = accountFrom(event.account) || session.account;
        if (phase === 'login') {
          task.status = 'waiting';
          this.clearTimer(session, 'inactivityTimer');
        } else if (!session.awaitingConfirmation) {
          task.status = 'running';
          this.restartInactivity(session);
        }
        this.setPhase(session, phase, Number.isInteger(event.count) ? { count: event.count } : {});
        if (event.message) this.jobs.event(task, event.message);
        return;
      }
      case 'complete': {
        await this.importComplete(session, event);
        return;
      }
      case 'cancelled': {
        this.fail(session, new BrowserSyncError('EXTENSION_CANCELLED', '扩展已停止本次同步，未导入任何作品。', 409, true));
        return;
      }
      case 'error': {
        const code = typeof event.code === 'string' && event.code ? event.code.slice(0, 60) : 'EXTENSION_ERROR';
        this.fail(session, new BrowserSyncError(code, event.message || 'Edge 扩展未能完成同步。'));
        return;
      }
      default:
        return;
    }
  }

  private async importComplete(session: Session, event: BrowserEvent) {
    const task = session.task;
    if (session.awaitingConfirmation) {
      this.fail(session, new BrowserSyncError('ACCOUNT_CONFIRM_REQUIRED', '账号尚未确认，不能导入作品。'));
      return;
    }
    this.clearTimer(session, 'acceptTimer');
    this.clearTimer(session, 'confirmTimer');
    this.clearTimer(session, 'inactivityTimer');
    this.clearTimer(session, 'totalTimer');
    this.setPhase(session, 'importing');
    this.jobs.event(task, '正在校验作品字段与指标，并写入作品库');
    try {
      const validation = validateImportedWorks(event.works, { limit: session.limit, capturedAt: iso() });
      if (validation.rejected > 0) this.jobs.event(task, `已忽略 ${validation.rejected} 条缺少有效作品 ID 的条目`, 'warning');
      for (const warning of (event.warnings || []).slice(0, 5)) this.jobs.event(task, warning.slice(0, 300), 'warning');
      await this.jobs.commit(task, session.signal, () => this.workspace.importWorks(validation.works));
      if (session.account) await this.bridge.rememberAccount(session.account).catch(() => undefined);
      await this.bridge.rememberSync().catch(() => undefined);
      this.setPhase(session, 'done', { count: validation.works.length });
      this.jobs.event(task, `已导入 ${validation.works.length} 条作品；缺失指标保持未获取，不填 0`);
      const result: SyncResult = { transport: 'browser', phase: 'done', account: session.account, count: validation.works.length, limit: session.limit };
      if (!session.settled) {
        session.settled = true;
        this.clearTimers(session);
        session.resolve(result);
      }
    } catch (error) {
      if (error instanceof BrowserSyncError) { this.fail(session, error); return; }
      if (error instanceof DouyinImportError) { this.fail(session, new BrowserSyncError(error.code, error.message)); return; }
      this.fail(session, new BrowserSyncError('IMPORT_FAILED', `作品数据未能写入：${errorText(error)}`));
    }
  }

  private approve(session: Session, automatic: boolean) {
    if (session.settled || session.confirmed) return;
    session.confirmed = true;
    session.awaitingConfirmation = false;
    this.clearTimer(session, 'confirmTimer');
    session.task.status = 'running';
    this.setPhase(session, 'capturing', { requiresConfirmation: false });
    if (session.account) void this.bridge.rememberAccount(session.account).catch(() => undefined);
    this.bridge.enqueue({ kind: 'confirm', taskId: session.task.id });
    this.jobs.event(session.task, automatic ? '同一账号已自动确认，开始读取作品' : '账号已确认，开始读取作品');
    this.restartInactivity(session);
  }

  private requestCancel(session: Session, ackMs: number) {
    if (session.settled || session.cancelRequested) return;
    session.cancelRequested = true;
    session.awaitingConfirmation = false;
    this.clearTimer(session, 'acceptTimer');
    this.clearTimer(session, 'confirmTimer');
    this.clearTimer(session, 'inactivityTimer');
    this.clearTimer(session, 'totalTimer');
    this.bridge.enqueue({ kind: 'cancel', taskId: session.task.id });
    this.jobs.event(session.task, '正在通知 Edge 停止本次采集；不会导入部分结果', 'warning');
    session.cancelTimer = setTimeout(() => this.fail(session, new BrowserSyncError('CANCELLED', '同步已取消，未导入任何作品。', 409, true)), ackMs);
  }

  private restartInactivity(session: Session) {
    this.clearTimer(session, 'inactivityTimer');
    const timings = { ...DEFAULTS, ...this.timings };
    session.inactivityTimer = setTimeout(() => this.fail(session, new BrowserSyncError('SYNC_INACTIVE', 'Edge 扩展超过 90 秒没有新的进度，请确认创作者中心页面仍打开后重试。')), timings.inactivityMs);
  }

  private setPhase(session: Session, phase: BrowserSyncPhase, extra: Record<string, unknown> = {}) {
    session.phase = phase;
    const previous = session.task.result && typeof session.task.result === 'object' && !Array.isArray(session.task.result)
      ? session.task.result as Record<string, unknown>
      : {};
    session.task.result = {
      transport: 'browser', phase, limit: session.limit,
      ...(typeof previous.count === 'number' ? { count: previous.count } : {}),
      ...(session.account ? { account: session.account } : {}),
      ...(session.awaitingConfirmation ? { requiresConfirmation: true } : {}),
      ...extra,
    };
    session.task.updatedAt = iso();
    this.jobs.persist();
  }

  private clearTimer(session: Session, key: 'acceptTimer' | 'confirmTimer' | 'inactivityTimer' | 'totalTimer' | 'cancelTimer') {
    const timer = session[key];
    if (timer) { clearTimeout(timer); session[key] = null; }
  }

  private clearTimers(session: Session) {
    this.clearTimer(session, 'acceptTimer');
    this.clearTimer(session, 'confirmTimer');
    this.clearTimer(session, 'inactivityTimer');
    this.clearTimer(session, 'totalTimer');
    this.clearTimer(session, 'cancelTimer');
  }

  private fail(session: Session, error: Error) {
    if (session.settled) return;
    session.settled = true;
    this.clearTimers(session);
    session.reject(error);
  }
}
