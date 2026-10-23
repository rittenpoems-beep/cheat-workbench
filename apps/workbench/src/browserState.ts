import type { BrowserStatus, BrowserSyncPhase } from '../shared/browser';
import type { Task } from '../shared/types';

export interface BrowserTaskResult {
  transport?: string;
  phase?: BrowserSyncPhase;
  limit?: number;
  count?: number;
  account?: { name?: string; id?: string };
  requiresConfirmation?: boolean;
}

export type ChipTone = 'idle' | 'ok' | 'warn' | 'attention' | 'busy';
export type ChipAction = 'setup' | 'session';

export interface EdgeChipState {
  label: string;
  hint: string;
  tone: ChipTone;
  busy: boolean;
  action: ChipAction;
}

const ACTIVE_STATUSES = ['queued', 'running', 'waiting', 'cancelling'];

export function isActiveTask(task?: Task): boolean {
  return Boolean(task && ACTIVE_STATUSES.includes(task.status));
}

export function browserTaskResult(task?: Task): BrowserTaskResult | null {
  if (!task || task.kind !== 'sync') return null;
  const result = task.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const value = result as BrowserTaskResult;
  return value.transport === 'browser' ? value : null;
}

/** Only account confirmation and login wait need the user's attention. */
export function shouldOpenSession(task?: Task): boolean {
  if (!isActiveTask(task)) return false;
  const result = browserTaskResult(task);
  if (!result) return false;
  return result.requiresConfirmation === true || (task!.status === 'waiting' && result.phase === 'login');
}

export function phaseLabel(phase?: BrowserSyncPhase, count?: number, limit?: number): string {
  const progress = count != null && limit ? ` ${count}/${limit}` : '';
  switch (phase) {
    case 'queued': return '等待 Edge 接手';
    case 'opening': return '正在打开创作者中心';
    case 'login': return '等待在 Edge 登录抖音';
    case 'account': return '等待确认抖音账号';
    case 'capturing': return `正在读取作品${progress || '…'}`;
    case 'paging': return `正在翻页读取作品${progress || '…'}`;
    case 'importing': return '正在写入作品库';
    case 'done': return count != null ? `已导入 ${count} 条作品` : '同步完成';
    default: return '准备同步';
  }
}

export function edgeChipState(browser: BrowserStatus | undefined, task?: Task): EdgeChipState {
  const result = browserTaskResult(task);
  if (isActiveTask(task) && result) {
    if (result.requiresConfirmation) {
      return { label: '确认抖音账号', hint: '已识别到抖音账号，请确认后再读取作品', tone: 'attention', busy: false, action: 'session' };
    }
    if (task!.status === 'waiting' && result.phase === 'login') {
      return { label: '在 Edge 登录抖音', hint: '请在 Edge 创作者中心标签完成登录，工作台会自动继续', tone: 'attention', busy: false, action: 'session' };
    }
    if (task!.status === 'cancelling') {
      return { label: '正在停止同步', hint: '正在通知 Edge 停止采集，不会导入部分结果', tone: 'warn', busy: true, action: 'session' };
    }
    return { label: phaseLabel(result.phase, result.count, result.limit), hint: '点击查看本次同步的阶段与进度', tone: 'busy', busy: true, action: 'session' };
  }
  if (!browser || browser.pairingRequired) {
    return { label: '连接 Edge', hint: '一次配对后，同步会复用 Edge 中已有的抖音登录状态', tone: 'idle', busy: false, action: 'setup' };
  }
  if (!browser.connected) {
    return { label: 'Edge 未响应', hint: '请确认 Edge 已打开并保持扩展启用，或重新连接扩展', tone: 'warn', busy: false, action: 'setup' };
  }
  if (browser.account?.name) {
    return { label: `Edge · ${browser.account.name}`, hint: '点击查看连接状态；同步作品不会重新登录', tone: 'ok', busy: false, action: 'setup' };
  }
  return { label: 'Edge 已连接', hint: '已配对，点击查看连接状态或开始同步', tone: 'ok', busy: false, action: 'setup' };
}

const SYNC_ERRORS: Record<string, string> = {
  BROWSER_UNPAIRED: '尚未连接 Edge 扩展，请先完成一次配对。',
  BROWSER_OFFLINE: 'Edge 扩展当前没有响应，请确认 Edge 已打开并保持扩展启用。',
  EXTENSION_TIMEOUT: '扩展没有响应本次同步，请确认扩展已启用后重试。',
  SYNC_TIMEOUT: '本次同步超时，请重试。',
  SYNC_INACTIVE: '扩展长时间没有新的进度，请确认创作者中心页面仍然打开。',
  ACCOUNT_CONFIRM_TIMEOUT: '等待账号确认超时，请重新同步。',
  ACCOUNT_CONFIRM_REQUIRED: '账号尚未确认，不能导入作品。',
  ACCOUNT_UNKNOWN: '未能识别抖音账号，请确认创作者中心已登录后重试。',
  EXTENSION_CANCELLED: '扩展已停止本次同步，没有导入任何作品。',
  CANCELLED: '同步已取消，没有导入任何作品。',
  TAB_CLOSED: '创作者中心标签已关闭，本次同步已停止。',
  PAGE_LOST: '创作者中心页面已离开或没有响应，请保持页面打开后重试。',
  NO_WORKS: '创作者中心没有返回作品列表，请确认「内容管理」能正常打开。',
  NO_METRICS: '作品列表没有返回任何真实指标，请稍后重试。',
  INVALID_ITEMS: '作品数据中没有可识别的作品 ID，请确认页面内容正常。',
  EXTENSION_OUTDATED: '扩展与工作台的协议版本不一致，请重新加载扩展。',
  EXTENSION_INCOMPATIBLE: '扩展脚本没有正常加载，请重新加载扩展后再试。',
  SYNC_IN_PROGRESS: '已有同步任务正在进行，请等待完成或取消后再试。',
  IMPORT_FAILED: '作品数据未能写入作品库，请重试。',
};

export function syncErrorHint(code?: string, fallback?: string): string {
  if (code && SYNC_ERRORS[code]) return SYNC_ERRORS[code];
  return fallback || '同步没有完成，请重试。';
}
