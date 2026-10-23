import { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, FolderOpen, LoaderCircle, Monitor, ShieldCheck, X } from 'lucide-react';
import type { BrowserPairing, BrowserStatus } from '../shared/browser';

const stamp = (value: string | null) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '尚未同步';
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

export default function BrowserConnectionSetup({ browser, onClose, onGenerate, onStart, onReveal }: {
  browser?: BrowserStatus;
  onClose: () => void;
  onGenerate: () => Promise<BrowserPairing>;
  onStart: () => Promise<void>;
  onReveal: () => Promise<void>;
}) {
  const [pairing, setPairing] = useState<BrowserPairing | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const connected = browser?.connected === true;
  const extensionDirectory = browser?.extensionPath || '服务端未提供扩展目录，请查看 BROWSER_CONNECTION.md。';
  const expired = Boolean(pairing) && remaining <= 0;

  useEffect(() => {
    if (!pairing) { setRemaining(0); return; }
    const tick = () => setRemaining(Math.max(0, Math.floor((Date.parse(pairing.expiresAt) - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [pairing]);
  useEffect(() => { if (connected) { setPairing(null); setError(''); } }, [connected]);

  const copy = async (text: string, label: string) => { try { await navigator.clipboard.writeText(text); setCopied(label); } catch { setError('浏览器未允许复制，请手动选择并复制。'); } };
  const generate = async () => {
    setBusy('generate'); setError(''); setCopied('');
    try { setPairing(await onGenerate()); } catch (caught) { setError((caught as Error).message); } finally { setBusy(''); }
  };
  const reveal = async () => {
    setBusy('reveal'); setError('');
    try { await onReveal(); } catch (caught) { setError((caught as Error).message); } finally { setBusy(''); }
  };
  const start = async () => {
    setBusy('start'); setError('');
    try { await onStart(); } catch (caught) { setError((caught as Error).message); } finally { setBusy(''); }
  };

  return <div className="modal-backdrop browser-setup-backdrop"><section className="connection-dialog browser-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="browser-setup-title">
    <div className="connection-dialog-heading"><div><span className="eyebrow">一次配对，长期复用</span><h2 id="browser-setup-title">连接你日常使用的 Edge</h2></div><button className="icon-button" aria-label="关闭 Edge 连接设置" onClick={onClose}><X size={20} /></button></div>
    <p className="connection-dialog-intro">扩展只复用这个 Edge 中的抖音创作者中心登录状态。配对一次后，工作台重启或 Edge 重启都不需要重新配对；换账号时才需要你确认。</p>

    <div className={`browser-pairing-status ${connected ? 'connected' : ''}`} role="status"><Monitor size={19} /><div><strong>{connected ? `${browser?.browserName || 'Edge'} 已连接` : browser?.pairingRequired ? '尚未配对' : 'Edge 未响应'}</strong><span>{connected ? '可以在同一浏览器检查登录状态并同步作品。' : browser?.pairingRequired ? '安装扩展并粘贴一次配对码，之后长期有效。' : '扩展已配对，但当前没有连接。请确认 Edge 已打开，扩展未被停用。'}</span></div></div>

    {connected ? <div className="browser-connection-facts">
      <div><span>当前账号</span><strong>{browser?.account?.name || '登录后自动识别'}</strong></div>
      <div><span>上次同步</span><strong>{stamp(browser?.lastSyncAt ?? null)}</strong></div>
      <div><span>扩展版本</span><strong>{browser?.version ? `v${browser.version}` : '未知'}</strong></div>
    </div> : <ol className="browser-setup-steps">
      <li><strong>在日常使用的 Edge 中加载本地扩展</strong><p>在 Edge 地址栏打开 <code>edge://extensions</code>，开启“开发人员模式”，选择“加载解压缩”，选中下面的扩展源码目录。安装与授权由你本人完成。</p><div className="extension-directory"><code>{extensionDirectory}</code><div><button className="button small" onClick={() => void copy(extensionDirectory, '已复制扩展源码目录')}><Copy size={13} />复制目录</button>{browser?.extensionPath && <button className="button small" disabled={Boolean(busy)} onClick={() => void reveal()}>{busy === 'reveal' ? <LoaderCircle className="spin" size={13} /> : <FolderOpen size={13} />}打开目录</button>}</div></div></li>
      <li><strong>生成一次性配对码</strong><p>点击 Edge 工具栏中的扩展图标，把配对码粘贴到扩展里并连接。配对码 10 分钟内有效，只能使用一次；生成新码会让旧码失效。</p>{!pairing ? <button className="button" disabled={Boolean(busy)} onClick={() => void generate()}>{busy === 'generate' ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}生成一次性配对码</button> : <div className={`pairing-code-area ${expired ? 'expired' : ''}`}><label>一次性配对码<input aria-label="一次性配对码" readOnly autoComplete="off" value={pairing.code} /></label><div><button className="button primary small" disabled={expired} onClick={() => void copy(pairing.code, '已复制配对码，请粘贴到 Edge 扩展')}><Copy size={14} />复制配对码</button><button className="text-button" disabled={Boolean(busy)} onClick={() => void generate()}>重新生成</button></div><span className="pairing-countdown">{expired ? '配对码已过期，请重新生成。' : `剩余 ${clock(remaining)} · 到期 ${new Date(pairing.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`}。请勿把配对码发到聊天或分享给他人。</span></div>}</li>
      <li><strong>连接成功后，这里会自动更新</strong><p>保持 Edge 打开。第一次同步时，工作台会复用或打开创作者中心；未登录时请本人在该标签登录，登录状态只由 Edge 自己保存。</p></li>
    </ol>}

    <div className="browser-permissions"><ShieldCheck size={17} /><span>扩展只申请 storage、alarms 与抖音创作者中心、本机工作台的访问权限；不读取 Cookie，不请求调试器或全站权限。取消同步不会关闭你的标签或清除登录状态。</span></div>
    {copied && <p className="pairing-copy-status" role="status"><Check size={15} />{copied}</p>}{error && <p className="connection-action-error" role="alert">{error}</p>}
    <div className="browser-setup-footer"><span>{connected ? '可以直接开始同步；已登录时不会再弹出账号确认。' : '未连接时不会启动同步，也不会切换到其他浏览器。'}</span><button className="button primary" disabled={!connected || Boolean(busy)} onClick={() => void start()}>{busy === 'start' ? <LoaderCircle className="spin" size={15} /> : <ExternalLink size={15} />}{connected ? '同步最新作品' : '配对后可同步'}</button></div>
  </section></div>;
}
