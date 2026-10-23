import { useState } from 'react';
import { Check, CircleHelp, ExternalLink, LoaderCircle, Monitor, ShieldCheck, X } from 'lucide-react';
import type { BrowserStatus, BrowserSyncPhase } from '../shared/browser';
import type { Task } from '../shared/types';
import { browserTaskResult, phaseLabel, syncErrorHint } from './browserState';

const STEPS: { phase: BrowserSyncPhase; label: string; detail: string }[] = [
  { phase: 'opening', label: '打开创作者中心', detail: '复用当前 Edge 标签' },
  { phase: 'login', label: '检查登录', detail: '不读取 Cookie' },
  { phase: 'account', label: '识别账号', detail: '换号时才需要确认' },
  { phase: 'capturing', label: '读取作品', detail: '只读取页面自身响应' },
  { phase: 'importing', label: '写入作品库', detail: '缺失指标保持未获取' },
];

function stepIndex(phase?: BrowserSyncPhase): number {
  switch (phase) {
    case 'queued':
    case 'opening': return 0;
    case 'login': return 1;
    case 'account': return 2;
    case 'capturing':
    case 'paging': return 3;
    case 'importing':
    case 'done': return 4;
    default: return 0;
  }
}

export default function ConnectionDialog({ task, browser, onClose, onConfirm, onCancel, onFocus, onSetup }: {
  task: Task;
  browser?: BrowserStatus;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  onCancel: () => Promise<void>;
  onFocus: () => Promise<void>;
  onSetup: () => void;
}) {
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const result = browserTaskResult(task);
  const stopping = task.status === 'cancelling';
  const done = task.status === 'completed' || result?.phase === 'done';
  const failed = task.status === 'failed' || task.status === 'cancelled' || task.status === 'interrupted';
  const connected = browser?.connected === true;
  const confirming = result?.requiresConfirmation === true;
  const waitingLogin = task.status === 'waiting' && result?.phase === 'login' && !confirming;
  const index = stepIndex(result?.phase);
  const account = result?.account || browser?.account || null;

  const action = async (name: string, operation: () => Promise<void>) => {
    setBusy(name);
    setActionError('');
    try { await operation(); } catch (error) { setActionError((error as Error).message); } finally { setBusy(''); }
  };

  const heading = stopping ? '正在停止本次采集'
    : done ? '本次同步已完成'
      : failed ? '本次同步没有完成'
        : confirming ? '请确认当前抖音账号'
          : waitingLogin ? '请在 Edge 完成抖音登录'
            : '正在使用你的 Edge 同步作品';
  const status = task.error ? syncErrorHint(task.errorCode, task.error)
    : stopping ? '正在通知 Edge 停止采集；不会导入部分结果，也不会关闭你的标签。'
      : done ? phaseLabel('done', result?.count)
        : failed ? '没有导入作品，请查看任务中心和下方阶段信息。'
          : !connected ? 'Edge 尚未连接或连接已中断，请重新连接扩展。'
            : confirming ? `已识别账号「${account?.name || '请核对创作者中心'}」。确认后才会读取作品与指标。`
              : waitingLogin ? '请在同一个 Edge 标签中完成抖音登录；登录后工作台会自动继续。'
                : phaseLabel(result?.phase, result?.count, result?.limit);

  return <div className="modal-backdrop connection-backdrop">
    <section className="connection-dialog browser-session-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-title">
      <div className="connection-dialog-heading">
        <div><span className="eyebrow">复用你日常使用的浏览器</span><h2 id="connection-title">{heading}</h2></div>
        <button className="icon-button" aria-label="收起连接窗口" title="收起，稍后继续" onClick={onClose}><X size={20} /></button>
      </div>
      <p className="connection-dialog-intro">扩展会复用或打开 Edge 中的抖音创作者中心。已登录时直接识别账号；未登录时，请在同一标签中本人完成登录或验证。</p>

      <div className="browser-session-state">
        <Monitor size={34} strokeWidth={1.4} />
        <div>
          <strong>{connected ? `${browser?.browserName || 'Edge'} 已连接` : 'Edge 未连接'}</strong>
          <p>{account ? `当前账号：${account.name}${account.id ? `（${account.id}）` : ''}` : '登录状态由你的 Edge 自己保存'}</p>
          <span>工作台不读取 Cookie、不复制浏览器资料，也不会关闭你的标签。</span>
        </div>
      </div>

      <ol className="browser-session-timeline">
        {STEPS.map((step, position) => {
          const state = done ? 'done'
            : failed && position === index ? 'failed'
              : position < index ? 'done'
                : position === index ? 'active' : 'pending';
          return <li key={step.phase} className={state}>
            <span className="timeline-marker">{state === 'done' ? <Check size={11} /> : position + 1}</span>
            <div><strong>{step.label}</strong><small>{step.detail}</small></div>
          </li>;
        })}
      </ol>

      {result?.limit && ['capturing', 'paging', 'importing'].includes(result.phase || '') && <div className="browser-session-progress">
        <div><span>{phaseLabel(result.phase, result.count, result.limit)}</span><b>{result.count ?? 0} / {result.limit}</b></div>
        <span className="browser-progress-track"><i style={{ width: `${Math.min(100, Math.max(0, ((result.count ?? 0) / result.limit) * 100))}%` }} /></span>
      </div>}

      <div className="connection-live-status" role="status"><CircleHelp size={16} /><span>{status}</span></div>

      <div className="browser-session-actions">
        <button className="button" disabled={Boolean(busy) || stopping || !connected} onClick={() => void action('focus', onFocus)}>
          {busy === 'focus' ? <LoaderCircle className="spin" size={15} /> : <ExternalLink size={15} />}前往 Edge 创作者中心
        </button>
        {!connected && !stopping && <button className="button" onClick={onSetup}><Monitor size={15} />重新连接扩展</button>}
      </div>

      {actionError && <p className="connection-action-error" role="alert">{actionError}</p>}

      <div className="connection-dialog-footer">
        <span><ShieldCheck size={15} />取消只停止本次采集，不关闭页面，也不清除 Edge 登录状态。</span>
        <div>
          <button className="button" disabled={Boolean(busy) || stopping} onClick={() => void action('cancel', onCancel)}>取消本次采集</button>
          {confirming && <button className="button primary" disabled={Boolean(busy) || stopping || !connected} onClick={() => void action('confirm', onConfirm)}>
            {busy === 'confirm' ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}确认当前账号并同步
          </button>}
        </div>
      </div>
    </section>
  </div>;
}
