import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Activity, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, Check, CheckCircle2,
  ChevronRight, CircleHelp, Command, Copy, ExternalLink, FileText, Flame,
  GitBranch, LayoutDashboard, Library, LoaderCircle, Menu, MessageSquare, Monitor,
  PenLine, Play, Plus, RefreshCw, Search, Send, Settings2, ShieldCheck, Sparkles, Target,
  Terminal, TrendingUp, Workflow, X, XCircle,
} from 'lucide-react';
import PredictionDetailsView from './PredictionDetailsView';
import ConnectionDialog from './ConnectionDialog';
import BrowserConnectionSetup from './BrowserConnectionSetup';
import CheatInitWizard from './CheatInitWizard';
import { contentFormLabels, type ContentForm } from '../shared/initialization';
import RetrospectiveDialog, { hasPublishedRecord } from './RetrospectiveDialog';
import { browserTaskResult, edgeChipState, phaseLabel, shouldOpenSession, syncErrorHint } from './browserState';
import { activeChannelLabel, blindChip, channelAction, channelCodeLabel, channelTone, resolvedCodeBuddyAuth, reviewChannelLabel } from './modelState';
import type { BrowserPairing } from '../shared/browser';
import type { ContextSummary, Draft, Metrics, Prediction, PredictionProposal, PrimaryChannel, Review, SkillInfo, Snapshot, Task, Topic, Work } from '../shared/types';

type Page = 'today' | 'ideas' | 'drafts' | 'reviews' | 'forecast' | 'retro' | 'library' | 'method';
type View = { id: string; label: string; page?: Page; draftId?: string; workId?: string; documentPath?: string; proposalTaskId?: string; predictionId?: string };
type Notice = { text: string; type: 'success' | 'error' };
type DraftFilter = 'all' | Draft['stage'];

const navItems: Record<Page, { label: string; icon: typeof LayoutDashboard }> = {
  today: { label: '今日工作台', icon: LayoutDashboard },
  ideas: { label: '选题', icon: Flame },
  drafts: { label: '稿件', icon: PenLine },
  reviews: { label: '评审', icon: ShieldCheck },
  forecast: { label: '预测', icon: Target },
  retro: { label: '复盘', icon: Activity },
  library: { label: '作品库', icon: Library },
  method: { label: '方法与设置', icon: Workflow },
};
const cycleNav: Page[] = ['ideas', 'drafts', 'reviews', 'forecast', 'retro'];
const cycleIndex: Record<string, string> = { ideas: '01', drafts: '02', reviews: '03', forecast: '04', retro: '05' };
const stageLabels: Record<Draft['stage'], string> = { draft: '初稿', reviewed: '已评审', predicted: '已预测', published: '已发布' };
const stageTones: Record<Draft['stage'], string> = { draft: '', reviewed: 'ink', predicted: 'green', published: 'seal' };
const stageNext: Record<Draft['stage'], { label: string; detail: string; icon: typeof ShieldCheck }> = {
  draft: { label: '启动独立评审', detail: '锁定版本，拿到七维评分与原文引用', icon: ShieldCheck },
  reviewed: { label: '生成事前预测', detail: '在发布前留下可校准的主观判断', icon: Target },
  predicted: { label: '登记发布链接', detail: '关联实际作品，进入 T+3 复盘窗口', icon: ExternalLink },
  published: { label: '录入成熟复盘', detail: '用真实指标校准这一次判断', icon: Activity },
};
const metricNames: Record<keyof Metrics, string> = { plays: '播放', likes: '点赞', comments: '评论', collects: '收藏', shares: '分享' };
const taskNames: Record<string, string> = { queued: '排队中', running: '进行中', waiting: '待操作', cancelling: '清理中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
const format = (n: number | null | undefined) => n == null ? '—' : n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万` : new Intl.NumberFormat('zh-CN').format(n);
const number = (n: number | null | undefined) => n == null ? '—' : new Intl.NumberFormat('zh-CN').format(n);
const date = (v: string) => v && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : '未记录';
const fullDate = (v: string) => v && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) : '未记录';
const time = (v: string) => v && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
const activeTask = (t: Task) => ['queued', 'running', 'waiting', 'cancelling'].includes(t.status);
const legacySyncTask = (t: Task) => t.kind === 'sync' && !browserTaskResult(t);
const taskEventText = (message: string) => message.replace(/Cheat 工作区/g, '创作空间');
const excerpt = (text: string, length = 76) => text.replace(/\s+/g, ' ').trim().slice(0, length);

function Badge({ children, tone = '' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function Spinner() {
  return <LoaderCircle className="spin" size={16} />;
}
function PageHead({ kicker, title, description, actions }: { kicker: string; title: string; description: string; actions?: ReactNode }) {
  return <header className="page-head">
    <div className="page-head-copy">
      <div className="page-kicker">{kicker}</div>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
    {actions && <div className="page-head-actions">{actions}</div>}
  </header>;
}
function EmptyPanel({ icon: Icon = FileText, title, description, action, index }: { icon?: typeof FileText; title: string; description: string; action?: ReactNode; index?: string }) {
  return <div className="empty-panel">
    {index && <span className="empty-index">{index}</span>}
    <span className="empty-glyph"><Icon size={19} strokeWidth={1.6} /></span>
    <div><h3>{title}</h3><p>{description}</p></div>
    {action && <div className="empty-action">{action}</div>}
  </div>;
}
function PanelHead({ title, meta, action }: { title: string; meta?: ReactNode; action?: ReactNode }) {
  return <div className="panel-head"><div><h2>{title}</h2>{meta && <span>{meta}</span>}</div>{action}</div>;
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const space = snapshot?.mode || 'owner';
  const [loadError, setLoadError] = useState('');
  const [view, setView] = useState<View>({ id: 'today', label: '今日工作台', page: 'today' });
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [navOpen, setNavOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [initOpen, setInitOpen] = useState(false);
  const [connectionTaskId, setConnectionTaskId] = useState<string | null>(null);
  const [alignmentSync, setAlignmentSync] = useState(false);
  const [dismissedConnection, setDismissedConnection] = useState<string | null>(null);
  const [selectedWorks, setSelectedWorks] = useState<string[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [chat, setChat] = useState('');
  const [contextSummary, setContextSummary] = useState<ContextSummary | null>(null);
  const [topicQuery, setTopicQuery] = useState('');
  const [libraryQuery, setLibraryQuery] = useState('');
  const [librarySort, setLibrarySort] = useState<'recent' | 'plays'>('recent');
  const [metric, setMetric] = useState<keyof Metrics>('plays');
  const [draftQuery, setDraftQuery] = useState('');
  const [draftFilter, setDraftFilter] = useState<DraftFilter>('all');
  const [skillQuery, setSkillQuery] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [dirty, setDirty] = useState(false);
  const [doc, setDoc] = useState<{ path: string; content: string } | null>(null);
  const [publishDraft, setPublishDraft] = useState<Draft | null>(null);
  const [publishUrl, setPublishUrl] = useState('');
  const [actualPrediction, setActualPrediction] = useState<Prediction | null>(null);
  const [provider, setProvider] = useState<PrimaryChannel>('codebuddy');
  const [codebuddyAuth, setCodebuddyAuth] = useState<'auto' | 'account' | 'model-api'>('auto');
  const [modelApi, setModelApi] = useState<'deepseek' | 'openai-compatible'>('deepseek');
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com');
  const [model, setModel] = useState('deepseek-flash');
  const [budget, setBudget] = useState('50');
  const [apiKey, setApiKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [newDraft, setNewDraft] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [skillInstruction, setSkillInstruction] = useState('');
  const [reviseInstruction, setReviseInstruction] = useState('');
  const [draftingTopic, setDraftingTopic] = useState<Topic | null>(null);
  const [personalBrief, setPersonalBrief] = useState('');
  const editBuffers = useRef<Record<string, { title: string; content: string; dirty: boolean }>>({});
  const activeDraftId = useRef<string | undefined>(undefined);
  const editor = useRef<HTMLTextAreaElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const paletteInput = useRef<HTMLInputElement>(null);

  const draft = snapshot?.drafts.find(d => d.id === view.draftId);
  activeDraftId.current = draft?.id;
  const review = snapshot?.reviews.filter(r => r.draftId === draft?.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const pending = snapshot?.tasks.filter(activeTask) || [];
  const recentTasks = snapshot?.tasks.filter(task => !legacySyncTask(task)) || [];
  const legacyTasks = snapshot?.tasks.filter(legacySyncTask) || [];
  const activeConnection = space === 'owner' ? pending.filter(t => t.kind === 'sync').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] : undefined;
  const connectionTask = connectionTaskId ? snapshot?.tasks.find(task => task.id === connectionTaskId && task.kind === 'sync') : undefined;
  const chip = space === 'owner' ? edgeChipState(snapshot?.browser, activeConnection) : null;
  const drafts = snapshot?.drafts || [];
  const activeDrafts = drafts.filter(d => d.stage !== 'published').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const waitingRetro = (snapshot?.predictions || []).filter(p => hasPublishedRecord(p) && p.status !== 'retrospected');
  const matureRetro = (snapshot?.predictions || []).filter(p => p.status === 'retrospected' && !p.earlyRetro);
  const focusDraft = activeDrafts[0];
  const todayLabel = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());

  const toast = useCallback((text: string, type: Notice['type'] = 'success') => setNotice({ text, type }), []);
  const endpoint = useCallback((path: string) => path, []);
  const request = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(endpoint(path), { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || body.message || `请求失败（${response.status}）`);
    }
    return response.json();
  }, [endpoint]);
  const refresh = useCallback(async () => {
    try {
      const data = await request<Snapshot>('/api/snapshot');
      setSnapshot(data);
      setLoadError('');
      return data;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '无法连接工作台服务');
    }
  }, [request]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), pending.length || setupOpen ? 2000 : 10000);
    return () => window.clearInterval(timer);
  }, [refresh, pending.length, setupOpen]);
  useEffect(() => {
    if (!activeConnection || dismissedConnection === activeConnection.id) return;
    if (!shouldOpenSession(activeConnection)) return;
    setConnectionTaskId(activeConnection.id);
    setSetupOpen(false);
  }, [activeConnection, dismissedConnection]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(null), 5000); return () => window.clearTimeout(timer); }, [notice]);
  useEffect(() => {
    const saved = draft ? editBuffers.current[draft.id] : undefined;
    setDraftContent(saved?.content ?? draft?.content ?? '');
    setDraftTitle(saved?.title ?? draft?.title ?? '');
    setDirty(saved?.dirty ?? false);
    setReviseInstruction('');
  }, [draft?.id, draft?.content, draft?.title, draft?.version]);
  useEffect(() => {
    if (!view.documentPath) return;
    let cancelled = false;
    request<{ path: string; content: string }>('/api/files?path=' + encodeURIComponent(view.documentPath))
      .then(data => { if (!cancelled) setDoc(data); })
      .catch(error => { if (!cancelled) toast(error.message, 'error'); });
    return () => { cancelled = true; };
  }, [view.documentPath, request, toast]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (Object.values(editBuffers.current).some(buffer => buffer.dirty)) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  useEffect(() => {
    const settings = snapshot?.settings;
    if (!settings) return;
    setProvider(settings.provider); setCodebuddyAuth(settings.codebuddyAuth); setModelApi(settings.modelApi);
    setBaseUrl(settings.baseUrl); setModel(settings.model); setBudget(String(settings.budget));
  }, [snapshot?.settings.provider, snapshot?.settings.codebuddyAuth, snapshot?.settings.modelApi, snapshot?.settings.baseUrl, snapshot?.settings.model, snapshot?.settings.budget, snapshot?.settings.deepseekConfigured]);
  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: 'smooth' }); }, [snapshot?.messages.length]);
  useEffect(() => {
    if (!assistantOpen) return;
    const query = new URLSearchParams();
    if (draft?.id) query.set('draftId', draft.id);
    if (selectedWorks.length) query.set('workIds', selectedWorks.join(','));
    let cancelled = false;
    request<ContextSummary>(`/api/context-summary?${query.toString()}`)
      .then(data => { if (!cancelled) setContextSummary(data); })
      .catch(() => { if (!cancelled) setContextSummary(null); });
    return () => { cancelled = true; };
  }, [assistantOpen, draft?.id, selectedWorks.join(','), snapshot?.messages.length, request]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPaletteOpen(open => !open); }
      if (event.key === 'Escape') { setPaletteOpen(false); setTaskOpen(false); setSetupOpen(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { if (paletteOpen) window.setTimeout(() => paletteInput.current?.focus(), 40); else setPaletteQuery(''); }, [paletteOpen]);

  const openView = (next: View) => { setView(next); setNavOpen(false); };
  const go = (page: Page) => openView({ id: page, label: navItems[page].label, page });
  const openDraft = (d: Draft) => openView({ id: `draft-${d.id}`, label: d.title, draftId: d.id });
  const openWork = (w: Work) => openView({ id: `work-${w.id}`, label: w.title, workId: w.id });
  const openPrediction = (p: Prediction) => openView({ id: `prediction-${p.id}`, label: p.title, predictionId: p.id });
  const openDoc = (skill: SkillInfo) => openView({ id: `doc-${skill.id}`, label: skill.name, documentPath: skill.path });
  const backFromView = () => {
    if (view.draftId) go('drafts');
    else if (view.workId) go('library');
    else if (view.predictionId || view.proposalTaskId) go('forecast');
    else if (view.documentPath) go('method');
    else go('today');
  };
  const job = async (kind: string, input: Record<string, unknown>, showTasks = true) => {
    try {
      setBusy(true);
      const task = await request<Task>('/api/jobs', { method: 'POST', body: JSON.stringify({ kind, input }) });
      if (showTasks) { setTaskOpen(true); setAssistantOpen(false); }
      await refresh();
      return task;
    } catch (error) {
      toast(error instanceof Error ? error.message : '任务启动失败', 'error');
    } finally { setBusy(false); }
  };
  const openInitialize = () => setInitOpen(true);
  const saveSettings = async (silent = false): Promise<boolean> => {
    const parsedBudget = Number(budget);
    if (!Number.isFinite(parsedBudget) || parsedBudget <= 0 || parsedBudget > 500) { toast('模型预算必须为 0 到 500 元之间的正数', 'error'); return false; }
    try {
      setBusy(true);
      await request('/api/settings', { method: 'POST', body: JSON.stringify({
        provider, codebuddyAuth, modelApi, baseUrl: baseUrl.trim(), model: model.trim(), budget: parsedBudget,
        ...(apiKey ? { deepseekKey: apiKey } : {}),
      }) });
      setApiKey('');
      await refresh();
      if (!silent) toast('运行设置已保存，Key 只保留在当前后台进程');
      return true;
    } catch (error) { toast((error as Error).message, 'error'); return false; }
    finally { setBusy(false); }
  };
  const testConnection = async () => {
    if (!(await saveSettings(true))) return;
    try {
      setTesting(true); setTestResult(null);
      const result = await request<{ ok: boolean; channel: string; model?: string; latencyMs: number; detail: string }>('/api/settings/test', { method: 'POST', body: '{}' });
      setTestResult({ ok: result.ok, text: `${result.detail}${result.model && !result.detail.includes(result.model) ? ` · ${result.model}` : ''} · ${result.latencyMs}ms` });
      if (result.ok) await refresh();
      toast(result.ok ? '连接测试通过' : '连接测试未通过', result.ok ? 'success' : 'error');
    } catch (error) { setTestResult({ ok: false, text: (error as Error).message }); toast((error as Error).message, 'error'); }
    finally { setTesting(false); }
  };
  const saveDraft = async () => {    if (!draft) return;
    const submitted = { id: draft.id, title: draftTitle || '未命名稿件', content: draftContent };
    try {
      setBusy(true);
      const saved = await request<Draft>('/api/drafts', { method: 'POST', body: JSON.stringify(submitted) });
      const latest = editBuffers.current[draft.id];
      const hasNewerEdits = latest && (latest.title !== draftTitle || latest.content !== submitted.content);
      if (!hasNewerEdits) {
        delete editBuffers.current[draft.id];
        if (activeDraftId.current === draft.id) setDirty(false);
      }
      await refresh();
      toast(hasNewerEdits ? '已保存提交版本；刚输入的修改仍待保存' : '稿件已保存，版本记录已更新');
      return saved;
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally { setBusy(false); }
  };
  const score = async (kind: 'review' | 'predict') => {
    if (!draft) return;
    if (dirty && !(await saveDraft())) return;
    await job(kind, { draftId: draft.id });
  };
  const createDraft = async () => {
    if (!newTitle.trim()) return;
    try {
      setBusy(true);
      const created = await request<Draft>('/api/drafts', { method: 'POST', body: JSON.stringify({ title: newTitle.trim(), content: '' }) });
      setNewDraft(false);
      setNewTitle('');
      await refresh();
      openDraft(created);
    } catch (error) { toast((error as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast('已复制到剪贴板'); }
    catch { toast('浏览器未允许复制，请手动选择文本', 'error'); }
  };
  const sendChat = async (message = chat) => {
    if (!message.trim()) return;
    if (draft && dirty && !(await saveDraft())) return;
    setChat('');
    await job('chat', { message: message.trim(), ...(draft ? { draftId: draft.id } : {}), ...(selectedWorks.length ? { workIds: selectedWorks } : {}) }, false);
  };

  if (!snapshot) {
    return <div className="boot">
      <div className="boot-mark"><GitBranch size={24} /></div>
      <span className="boot-kicker">CHEAT WORKBENCH</span>
      <h1>创作者实验台</h1>
      <p>{loadError || '正在打开本地创作者工作台…'}</p>
      {loadError ? <button className="button primary" onClick={() => void refresh()}><RefreshCw size={15} />重新连接</button> : <Spinner />}
    </div>;
  }

  const openEdgePanel = () => {
    if (chip?.action === 'session' && activeConnection) {
      setDismissedConnection(null); setConnectionTaskId(activeConnection.id); setSetupOpen(false);
    } else setSetupOpen(true);
  };
  const startSync = async (forInitialization = false): Promise<boolean> => {
    if (space === 'demo') { toast('体验空间不会连接真实账号。', 'error'); return false; }
    if (activeConnection) {
      setDismissedConnection(null); setConnectionTaskId(activeConnection.id);
      toast('已有同步任务正在进行，可查看当前阶段');
      return false;
    }
    const browser = snapshot.browser;
    if (!browser || browser.pairingRequired) { setSetupOpen(true); return false; }
    if (!browser.connected) {
      setSetupOpen(true);
      toast('Edge 扩展当前没有响应，请确认 Edge 已打开并保持扩展启用。', 'error');
      return false;
    }
    const limit = forInitialization ? Math.min(50, Math.max(1, snapshot.project.historyRequested ?? 10)) : 10;
    const task = await job('sync', { limit, ...(forInitialization ? { forInitialization: true } : {}) }, false);
    if (task) { setDismissedConnection(null); setAlignmentSync(false); toast('已交给 Edge 读取作品，可在顶部查看进度'); }
    return Boolean(task);
  };
  const syncSummary = (task: Task) => {
    if (task.error) return syncErrorHint(task.errorCode, task.error);
    const result = browserTaskResult(task);
    return phaseLabel(result?.phase, result?.count, result?.limit);
  };
  const openAssistant = () => { setAssistantOpen(true); setTaskOpen(false); };
  const openTasks = () => { setTaskOpen(true); setAssistantOpen(false); };

  const latestReview = (draftId: string) => snapshot.reviews.filter(r => r.draftId === draftId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const reviewTotal = (r?: Review) => r ? `${r.dimensions.reduce((sum, d) => sum + d.score, 0)}/${r.dimensions.reduce((sum, d) => sum + d.max, 0)}` : '—';

  const filteredDrafts = drafts.filter(d =>
    (draftFilter === 'all' || d.stage === draftFilter) &&
    (!draftQuery.trim() || `${d.title} ${d.content}`.toLowerCase().includes(draftQuery.trim().toLowerCase())),
  ).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const filteredWorks = snapshot.works.filter(w => !libraryQuery.trim() || `${w.title} ${w.description || ''}`.toLowerCase().includes(libraryQuery.trim().toLowerCase()))
    .sort((a, b) => librarySort === 'plays'
      ? (b.metrics.plays ?? -1) - (a.metrics.plays ?? -1)
      : (b.publishedAt || b.capturedAt).localeCompare(a.publishedAt || a.capturedAt));
  const filteredSkills = snapshot.skills.filter(s => !skillQuery.trim() || `${s.name} ${s.description}`.toLowerCase().includes(skillQuery.trim().toLowerCase()));
  const totalPlays = snapshot.works.reduce((sum, w) => sum + (w.metrics.plays || 0), 0);
  const knownPlays = snapshot.works.filter(w => w.metrics.plays != null).length;
  const totalInteractions = snapshot.works.reduce((sum, w) => sum + (w.metrics.likes || 0) + (w.metrics.comments || 0) + (w.metrics.collects || 0) + (w.metrics.shares || 0), 0);

  const cycleSteps = [
    { page: 'ideas' as Page, label: '选题', count: snapshot.topics.length, unit: '个候选', note: '热点 · 来源 · 个人经历' },
    { page: 'drafts' as Page, label: '稿件', count: drafts.length, unit: '篇', note: '可编辑初稿与版本' },
    { page: 'reviews' as Page, label: '评审', count: snapshot.reviews.length, unit: '次盲评', note: '七维评分 · 原文引用' },
    { page: 'forecast' as Page, label: '预测', count: snapshot.predictions.length, unit: '份判断', note: '锁稿后 · 不可改写' },
    { page: 'retro' as Page, label: '复盘', count: matureRetro.length, unit: '次成熟复盘', note: 'T+3 实绩校准' },
  ];
  const firstEmpty = cycleSteps.findIndex(step => step.count === 0);
  const focusStep = focusDraft ? (focusDraft.stage === 'draft' ? 3 : focusDraft.stage === 'reviewed' || focusDraft.stage === 'predicted' ? 4 : 5) : 0;
  const activeStep = focusStep || (firstEmpty === -1 ? 5 : firstEmpty + 1);
  const completedSteps = cycleSteps.filter(step => step.count > 0).length;

  const nextActions: { icon: typeof Flame; title: string; detail: string; onClick: () => void }[] = [];
  if (focusDraft) {
    const meta = stageNext[focusDraft.stage];
    nextActions.push({ icon: meta.icon, title: meta.label, detail: focusDraft.title, onClick: () => openDraft(focusDraft) });
  } else if (!drafts.length) {
    nextActions.push({
      icon: Flame,
      title: snapshot.topics.length ? '从候选选题起草' : '先侦察一个选题',
      detail: snapshot.topics.length ? `${snapshot.topics.length} 个候选等待选择` : '把热点、来源与自己的经历接起来',
      onClick: () => go('ideas'),
    });
  }
  if (waitingRetro.length) nextActions.push({ icon: Activity, title: '录入发布后实绩', detail: `${waitingRetro.length} 份预测已到复盘窗口`, onClick: () => go('retro') });
  if (space === 'owner' && !snapshot.works.length) nextActions.push({
    icon: Monitor,
    title: '连接你的真实作品',
    detail: chip?.tone === 'ok' ? 'Edge 已就绪，读取最近 10 条作品' : '一次配对，之后无需重复登录',
    onClick: () => void startSync(),
  });
  if (!snapshot.reviews.length && drafts.length) nextActions.push({ icon: ShieldCheck, title: '完成第一次盲评', detail: '把感觉换成分维度的具体判断', onClick: () => openDraft(drafts[0]) });
  const visibleNextActions = nextActions.slice(0, 3);

  function chart(works: Work[]) {
    const values = works.slice(0, 10).reverse();
    if (!values.length) return <EmptyPanel icon={TrendingUp} title="还没有作品表现" description="连接作品库后，这里会出现每一次发布的真实指标。" action={<button className="button small" onClick={() => go('library')}>打开作品库</button>} />;
    if (values.every(w => w.metrics[metric] == null)) return <div className="chart-empty"><span>当前指标尚未获取</span><p>缺失指标保持为空，不会被补成零。可以切换其他指标查看。</p></div>;
    const max = Math.max(...values.map(w => w.metrics[metric] || 0), 1);
    return <div className="performance-chart">
      <div className="chart-lines">{[1, 0.5, 0].map(f => <div key={f}><span>{format(max * f)}</span><i /></div>)}</div>
      <div className="chart-bars">{values.map((w, i) => <button key={w.id} className="chart-bar-slot" title={`${w.title} · ${metricNames[metric]} ${format(w.metrics[metric])}`} onClick={() => openWork(w)}>
        <span className={`chart-bar ${i === values.length - 1 ? 'latest' : ''} ${w.metrics[metric] == null ? 'missing' : ''}`} style={{ height: `${Math.max(2, ((w.metrics[metric] || 0) / max) * 100)}%` }} />
        <small>{date(w.publishedAt)}</small>
      </button>)}</div>
    </div>;
  }

  const draftRows = (rows: Draft[], compact = false) => <div className={`draft-ledger ${compact ? 'compact' : ''}`}>
    <div className="ledger-head"><span>稿件</span><span>阶段</span><span>评审</span><span>最近修改</span><span>下一步</span></div>
    {rows.map(d => {
      const r = latestReview(d.id);
      return <button key={d.id} className="ledger-row" onClick={() => openDraft(d)}>
        <span className="ledger-title"><strong>{d.title}</strong><small>{excerpt(d.content) || '还没有正文，从一个真实的想法开始。'}</small></span>
        <span><Badge tone={stageTones[d.stage]}>{stageLabels[d.stage]}</Badge></span>
        <span className="ledger-review">{reviewTotal(r)}</span>
        <span className="ledger-date">{date(d.updatedAt)}</span>
        <span className="ledger-next">{stageNext[d.stage].label}<ArrowUpRight size={13} /></span>
      </button>;
    })}
  </div>;

  const workRows = (works: Work[], selectable = false) => <div className={`work-table ${selectable ? 'selectable' : ''}`}>
    <div className="work-table-head">
      {selectable && <span />}
      <span>作品</span><span>播放</span><span>互动</span><span>发布</span><span />
    </div>
    {works.map(w => <div className={`work-row ${selectable && selectedWorks.includes(w.id) ? 'selected' : ''}`} key={w.id}>
      {selectable && <input aria-label={`选择${w.title}`} type="checkbox" checked={selectedWorks.includes(w.id)} onChange={() => setSelectedWorks(a => a.includes(w.id) ? a.filter(id => id !== w.id) : [...a, w.id])} />}
      <button className="work-title" onClick={() => openWork(w)}>
        <span className="work-thumbnail"><Play size={13} fill="currentColor" /></span>
        <span><strong>{w.title}</strong><small>{w.source || '抖音'} · {date(w.capturedAt)}采集</small></span>
      </button>
      <span className="metric-number">{format(w.metrics.plays)}</span>
      <span className="work-interaction">{format(w.metrics.likes)} <i>/</i> {format(w.metrics.comments)}</span>
      <span className="work-date">{date(w.publishedAt)}</span>
      <a className="icon-button" aria-label="打开原作品" href={w.url} target="_blank" rel="noreferrer"><ArrowUpRight size={15} /></a>
    </div>)}
  </div>;

  const reviewPanel = (r: Review) => <div className="review-panel">
    <div className="review-header">
      <div><ShieldCheck size={16} /><strong>独立稿件评审</strong></div>
      <Badge tone={r.version === draft?.version && !dirty ? 'green' : 'amber'}>v{r.version}{r.version !== draft?.version ? ' · 历史版本' : dirty ? ' · 稿件已修改' : ''}</Badge>
    </div>
    <p className="review-summary">{r.summary}</p>
    <div className="dimension-list">{r.dimensions.map((d, i) => <button key={i} className="dimension" onClick={() => {
      const index = draftContent.indexOf(d.quote);
      if (index >= 0 && editor.current) {
        editor.current.focus();
        editor.current.setSelectionRange(index, index + d.quote.length);
        editor.current.scrollTop = Math.max(0, (draftContent.slice(0, index).split('\n').length - 3) * 30);
      } else toast('引用不在当前稿件中，请查看对应历史版本', 'error');
    }}>
      <span className="dimension-top"><strong>{d.name}</strong><b>{d.score}<small> / {d.max}</small></b></span>
      <span className="score-track"><i style={{ width: `${Math.max(0, Math.min(100, d.score / d.max * 100))}%` }} /></span>
      <span className="dimension-reason">{d.reason}</span>
      {d.quote && <span className="quote">“{d.quote}”<ArrowUpRight size={12} /></span>}
    </button>)}</div>
    {r.suggestions.length > 0 && <div className="suggestions"><h4>下一次修改</h4>{r.suggestions.map((s, i) => <p key={i}><span>{String(i + 1).padStart(2, '0')}</span>{s}</p>)}</div>}
    <div className="micro muted">{r.blind ? '独立请求 · 仅输入锁定稿件与评分规则' : '辅助分析'} · {reviewChannelLabel(r)} · {date(r.createdAt)}</div>
  </div>;

  function renderToday() {
    const known = snapshot!.works.filter(w => w.metrics.plays != null);
    return <div className="page today-page">
      <PageHead
        kicker={`工作台 · ${todayLabel}`}
        title="今日工作台"
        description="一眼看清创作循环停在哪一步，然后只做下一件事。"
        actions={<button className="button primary" onClick={() => setNewDraft(true)}><Plus size={15} />新建稿件</button>}
      />
      {space === 'owner' && (!snapshot!.project.initialized || snapshot!.project.legacyInit) && <section className="init-banner">
        <span className="init-banner-index">00</span>
        <div className="init-banner-copy">
          <strong>{snapshot!.project.legacyInit ? '检测到早期自动初始化，建议补完设置' : '先把 Cheat 创作空间初始化'}</strong>
          <p>{snapshot!.project.legacyInit ? '旧版启动时写入过时间戳，但内容形态、对标账号与历史对齐还没有记录。重新初始化会保留现有作品、选题与预测。' : '按上游 Phase 0–5 完成内容形态、历史导入、数据回收与对标设置；已有作品与选题不会被清除。'}</p>
        </div>
        <button className="button primary small" onClick={openInitialize}>{snapshot!.project.legacyInit ? '补完初始化' : '开始初始化'}<ArrowRight size={14} /></button>
      </section>}
      <section className="cycle-board">
        <div className="cycle-head">
          <div><span className="cycle-kicker">创作循环</span><h2>选题 → 稿件 → 评审 → 预测 → 复盘</h2></div>
          <div className="cycle-progress"><span>已建立记录</span><strong>{completedSteps}<small>/5</small></strong></div>
        </div>
        <div className="cycle-track">
          {cycleSteps.map((step, index) => {
            const state = index + 1 === activeStep ? 'active' : step.count > 0 ? 'done' : 'idle';
            return <button key={step.page} className={`cycle-step ${state}`} onClick={() => go(step.page)}>
              <span className="cycle-num">{String(index + 1).padStart(2, '0')}</span>
              <span className="cycle-state">{state === 'active' ? '当前' : state === 'done' ? '已有记录' : '待开始'}</span>
              <strong>{step.label}</strong>
              <span className="cycle-count">{step.count}<small>{step.unit}</small></span>
              <span className="cycle-note">{step.note}</span>
            </button>;
          })}
        </div>
      </section>

      <div className="dash-grid">
        <div className="dash-main">
          <section className="panel workflow-panel">
            <PanelHead
              title="正在推进"
              meta={`${activeDrafts.length} 篇稿件`}
              action={<button className="text-button" onClick={() => go('drafts')}>全部稿件<ArrowRight size={13} /></button>}
            />
            {activeDrafts.length
              ? draftRows(activeDrafts.slice(0, 4), true)
              : <EmptyPanel icon={PenLine} title="循环还停在起点" description="先选一个值得讲的角度，或者直接把脑子里的想法写成初稿。" action={<><button className="button primary small" onClick={() => go('ideas')}><Flame size={14} />去找选题</button><button className="button small" onClick={() => setNewDraft(true)}><Plus size={14} />直接写稿</button></>} index="02" />}
          </section>

          <section className="panel performance-panel">
            <PanelHead
              title="作品表现"
              meta={snapshot!.works.length ? `${snapshot!.works.length} 条作品 · 累计 ${format(totalPlays)} 播放` : '尚未连接作品库'}
              action={snapshot!.works.length ? <select className="compact-select" aria-label="切换指标" value={metric} onChange={e => setMetric(e.target.value as keyof Metrics)}>
                {Object.entries(metricNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select> : <button className="text-button" onClick={() => go('library')}>打开作品库<ArrowRight size={13} /></button>}
            />
            {chart(snapshot!.works)}
            {snapshot!.works.length > 0 && <div className="chart-foot"><span>{known.length === snapshot!.works.length ? '指标来自最近一次同步' : `${snapshot!.works.length - known.length} 条作品缺少播放数据`}</span><span>数据源 · {space === 'demo' ? '虚构样例' : 'Edge 创作者中心'}</span></div>}
          </section>
        </div>

        <aside className="dash-rail">
          <section className="panel next-panel">
            <PanelHead title="下一步" meta="根据当前循环推导" action={<span className="pulse-dot" />} />
            <div className="next-list">{visibleNextActions.map((action, index) => <button key={`${action.title}-${index}`} className="next-action" onClick={action.onClick}>
              <span className="next-action-icon"><action.icon size={16} /></span>
              <span><strong>{action.title}</strong><small>{action.detail}</small></span>
              <ArrowUpRight size={15} />
            </button>)}</div>
            {!visibleNextActions.length && <div className="rail-note">所有动作都已完成。可以整理方法，或等待下一轮数据。</div>}
          </section>

          <section className="panel status-panel">
            <PanelHead title="运行状态" meta={space === 'demo' ? '独立体验空间' : '本机真实空间'} />
            {space === 'owner' ? <button className="status-row" onClick={openEdgePanel}>
              <span className={`status-light ${chip?.tone || 'idle'}`} />
              <span><strong>{chip?.label || '连接 Edge'}</strong><small>{snapshot!.browser?.connected ? `${snapshot!.browser.browserName || 'Edge'} · 扩展已就绪` : '复用日常 Edge 的抖音登录'}</small></span>
              <ChevronRight size={14} />
            </button> : <div className="status-row">
              <span className="status-light idle" />
              <span><strong>示例数据源</strong><small>不会连接真实账号</small></span>
            </div>}
            <div className="status-row">
              <span className="status-light idle" />
              <span><strong>{snapshot!.browser?.lastSyncAt ? `上次同步 ${date(snapshot!.browser.lastSyncAt)}` : '尚未同步过作品'}</strong><small>{snapshot!.browser?.account?.name || '账号会在同步时识别'}</small></span>
            </div>
            <button className="status-row" onClick={openTasks}>
              <span className={`status-light ${pending.length ? 'busy' : 'ok'}`} />
              <span><strong>{pending.length ? `${pending.length} 个任务进行中` : '任务中心空闲'}</strong><small>{pending[0]?.label || (recentTasks.length ? `${recentTasks.length} 条执行记录` : '同步、评审与预测都会记在这里')}</small></span>
              <ChevronRight size={14} />
            </button>
          </section>

          <section className="panel calibration-panel">
            <PanelHead title="校准进度" meta="预测 → 成熟复盘" />
            <div className="calibration-value"><strong>{snapshot!.project.calibrationSamples}<small>/5</small></strong><span>成熟校准样本</span></div>
            <div className="calibration-track"><i style={{ width: `${Math.min(100, snapshot!.project.calibrationSamples / 5 * 100)}%` }} /></div>
            <p className="calibration-note">达到 5 个成熟复盘后，才具备升级 rubric 的最低样本数。早期快照不计入。</p>
            <button className="text-button" onClick={() => go('retro')}>查看复盘台账<ArrowRight size={13} /></button>
          </section>
        </aside>
      </div>
    </div>;
  }

  function renderIdeas() {
    return <div className="page ideas-page">
      <PageHead
        kicker="创作循环 · 01"
        title="选题"
        description="把正在发生的事、可核对来源和你的个人经历放在一起，再决定讲什么。"
        actions={<Badge>{snapshot!.topics.length} 个候选</Badge>}
      />
      <div className="ideas-layout">
        <aside className="recon-panel">
          <div className="recon-head"><span className="recon-index">01</span><span className="recon-kicker">热点侦察</span></div>
          <h2>这一次，你想关注什么？</h2>
          <p>先侦察可核对的事件材料，再生成三个可讨论的角度。来源与热度以实际取得为准。</p>
          <label className="recon-field">
            <span>检索方向</span>
            <input value={topicQuery} onChange={e => setTopicQuery(e.target.value)} placeholder="例如：AI 教育、普通人的效率工具…" onKeyDown={e => { if (e.key === 'Enter' && topicQuery.trim()) void job('topics', { query: topicQuery.trim() }); }} />
          </label>
          <div className="recon-chips">{['AI 教育', '内容创作', '普通人的效率工具'].map(text => <button key={text} className="recon-chip" onClick={() => setTopicQuery(text)}>{text}</button>)}</div>
          <button className="button primary full" disabled={busy || !topicQuery.trim()} onClick={() => void job('topics', { query: topicQuery.trim() })}>
            {busy ? <Spinner /> : <Sparkles size={15} />}寻找创作角度
          </button>
          <button className="button ghost full" disabled={busy} onClick={() => void job('trends', { query: topicQuery })}><Search size={14} />只侦察热点</button>
          <div className="recon-foot"><ShieldCheck size={14} /><span>没有可核对来源时，不会生成虚构热点。</span></div>
        </aside>

        <section className="idea-results">
          <div className="results-head"><div><span className="results-kicker">候选选题</span><h2>从材料到可写的角度</h2></div><span className="results-count">{snapshot!.topics.length}</span></div>
          {snapshot!.topics.length ? <div className="topic-list">{snapshot!.topics.map((t, i) => <article className="topic-row" key={t.id}>
            <div className="topic-number">{String(i + 1).padStart(2, '0')}</div>
            <div className="topic-body">
              <div className="topic-meta"><span>{date(t.capturedAt)}</span>{t.category && <span className="topic-category">{t.category}</span>}{t.sourceTitle && <a href={t.sourceUrl} target="_blank" rel="noreferrer">{t.sourceTitle}<ArrowUpRight size={12} /></a>}</div>
              <h3>{t.title}</h3>
              <p className="topic-angle">{t.angle}</p>
              <p className="topic-reason"><Sparkles size={13} />{t.reason}</p>
              {t.personalInput && <p className="personal-input">待补充：{t.personalInput}</p>}
            </div>
            <div className="topic-actions">
              <button className="button small" disabled={busy} onClick={() => { setDraftingTopic(t); setPersonalBrief(''); }}>用这个角度起草<ArrowRight size={13} /></button>
              {t.sourceUrl && <a className="text-button" href={t.sourceUrl} target="_blank" rel="noreferrer">查看来源<ArrowUpRight size={12} /></a>}
            </div>
          </article>)}</div>
            : <EmptyPanel icon={Flame} title="候选池还是空的" description="输入一个方向，工作台会先找可核对的材料，再给出三个带来源的角度。" action={<button className="button primary small" onClick={() => document.querySelector<HTMLInputElement>('.recon-field input')?.focus()}>输入检索方向</button>} index="01" />}
          {snapshot!.trends.length > 0 && <details className="raw-trends">
            <summary><span><TrendingUp size={14} />原始热榜线索</span><span>{snapshot!.trends.length} 条 · 未按账号方向筛选</span></summary>
            <p>这些只是侦察到的原始条目，不是候选选题。「寻找创作角度」会按账号方向筛材料，再给出三个不同 category 的角度。</p>
            <div className="raw-trend-list">{snapshot!.trends.map(item => <a key={item.id} href={item.sourceUrl} target="_blank" rel="noreferrer">
              <span>{item.category || '热点'}</span><strong>{item.title}</strong><em>{item.sourceTitle}</em><ArrowUpRight size={12} />
            </a>)}</div>
          </details>}
        </section>
      </div>
    </div>;
  }

  function renderDrafts() {
    const counts: Record<DraftFilter, number> = { all: drafts.length, draft: drafts.filter(d => d.stage === 'draft').length, reviewed: drafts.filter(d => d.stage === 'reviewed').length, predicted: drafts.filter(d => d.stage === 'predicted').length, published: drafts.filter(d => d.stage === 'published').length };
    const filters: { id: DraftFilter; label: string }[] = [{ id: 'all', label: '全部' }, { id: 'draft', label: '初稿' }, { id: 'reviewed', label: '已评审' }, { id: 'predicted', label: '已预测' }, { id: 'published', label: '已发布' }];
    return <div className="page drafts-page">
      <PageHead kicker="创作循环 · 02" title="稿件" description="所有可编辑版本都在这里。锁定版本之后，才进入评审与预测。" actions={<button className="button primary" onClick={() => setNewDraft(true)}><Plus size={15} />新建稿件</button>} />
      <div className="ledger-toolbar">
        <div className="segmented">{filters.map(filter => <button key={filter.id} className={draftFilter === filter.id ? 'active' : ''} onClick={() => setDraftFilter(filter.id)}>{filter.label}<span>{counts[filter.id]}</span></button>)}</div>
        <label className="search-field"><Search size={14} /><input placeholder="搜索标题或正文" value={draftQuery} onChange={e => setDraftQuery(e.target.value)} /></label>
      </div>
      <section className="panel ledger-panel">
        {filteredDrafts.length
          ? draftRows(filteredDrafts)
          : <EmptyPanel icon={PenLine} title={drafts.length ? '没有符合筛选的稿件' : '还没有第一篇稿件'} description={drafts.length ? '换一个阶段或清除搜索词。' : '从选题开始，或者直接把一个真实经历写下来。'} action={<><button className="button small" onClick={() => go('ideas')}><Flame size={14} />去选题</button><button className="button primary small" onClick={() => setNewDraft(true)}><Plus size={14} />新建稿件</button></>} index="02" />}
      </section>
    </div>;
  }

  function renderReviews() {
    const rows = [...snapshot!.reviews].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return <div className="page reviews-page">
      <PageHead kicker="创作循环 · 03" title="评审" description="只把锁定稿件和评分规则交给独立评审。每一个分数都必须落回原文。" actions={<button className="button" onClick={() => go('drafts')}>从稿件发起评审<ArrowRight size={14} /></button>} />
      <div className="stat-strip">
        <div><span>评审记录</span><strong>{snapshot!.reviews.length}</strong><small>份</small></div>
        <div><span>覆盖稿件</span><strong>{new Set(snapshot!.reviews.map(r => r.draftId)).size}</strong><small>篇</small></div>
        <div><span>最近一次</span><strong className="stat-date">{rows[0] ? date(rows[0].createdAt) : '—'}</strong><small>{rows[0] ? reviewChannelLabel(rows[0]) : '尚无记录'}</small></div>
      </div>
      {rows.length ? <div className="review-feed">{rows.map(r => {
        const ownerDraft = drafts.find(d => d.id === r.draftId);
        const total = r.dimensions.reduce((sum, d) => sum + d.score, 0);
        const max = r.dimensions.reduce((sum, d) => sum + d.max, 0);
        return <article className="review-card" key={r.id}>
          <header>
            <div><span className="review-kicker">{date(r.createdAt)} · v{r.version} · {r.blind ? '独立盲评' : '辅助分析'}</span><h2>{ownerDraft?.title || '稿件已移出当前空间'}</h2></div>
            <div className="review-total"><strong>{total}</strong><span>/ {max}</span></div>
          </header>
          <div className="review-bars">{r.dimensions.map((d, i) => <div key={i} title={`${d.name} ${d.score}/${d.max}`}><span>{d.name.split(' ')[0]}</span><i><b style={{ width: `${d.score / d.max * 100}%` }} /></i><strong>{d.score}</strong></div>)}</div>
          <p className="review-summary">{r.summary}</p>
          <footer><span>{r.suggestions.length} 条修改建议 · {r.provider}</span><button className="text-button" onClick={() => ownerDraft ? openDraft(ownerDraft) : undefined}>打开稿件<ArrowUpRight size={13} /></button></footer>
        </article>;
      })}</div> : <section className="panel"><EmptyPanel icon={ShieldCheck} title="评审是循环里的第一个刹车" description="在同一份评分规则下逐项打分，引用必须逐字存在，且不把历史数据或播放量喂给评审。去稿件里锁定版本并启动一次独立评审。" action={<button className="button primary small" onClick={() => go('drafts')}>打开稿件<ArrowRight size={13} /></button>} index="03" /></section>}
    </div>;
  }

  function renderForecast() {
    const predictions = [...snapshot!.predictions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const eligible = drafts.filter(d => ['reviewed', 'predicted'].includes(d.stage));
    return <div className="page forecast-page">
      <PageHead kicker="创作循环 · 04" title="预测" description="发布之前写下主观概率与判断依据。一旦锁定，原记录只追加，不改写。" actions={<button className="button" onClick={() => go('drafts')}>选择稿件生成预测<ArrowRight size={14} /></button>} />
      <div className="calibration-banner">
        <div><span className="calibration-kicker">校准进度</span><strong>{snapshot!.project.calibrationSamples}<small> / 5 成熟样本</small></strong><p>预测不是流量承诺。只有真实复盘才能校准下一次判断。</p></div>
        <div className="calibration-banner-track"><i style={{ width: `${Math.min(100, snapshot!.project.calibrationSamples / 5 * 100)}%` }} /></div>
      </div>
      {predictions.length ? <div className="forecast-list">{predictions.map(p => {
        const details = p.details;
        const status = p.status === 'retrospected' ? (p.earlyRetro ? '早期快照' : '已复盘') : p.status === 'published' ? '等待复盘' : '尚未发布';
        return <article className="forecast-row" key={p.id}>
          <div className="forecast-status"><Badge tone={p.status === 'retrospected' ? 'green' : p.status === 'published' ? 'seal' : ''}>{status}</Badge><span>v{p.version} · {date(p.createdAt)}</span></div>
          <div className="forecast-main"><h2>{p.title}</h2><p>{p.forecast}</p><small>{p.rationale}</small></div>
          <div className="forecast-numbers">{details ? <><div><span>主判断</span><strong>{details.buckets.find(b => b.id === details.headlineBucketId)?.label || details.headlineBucketId}</strong></div><div><span>中枢估计</span><strong>{number(details.centralEstimate)}</strong></div><div><span>信心</span><strong>{details.confidence === 'high' ? '高' : details.confidence === 'medium' ? '中' : '低'}</strong></div></> : <span className="micro muted">旧版预测仅保留文字记录</span>}</div>
          <div className="forecast-actions">{p.details && <button className="button small" onClick={() => openPrediction(p)}><Target size={13} />查看判断</button>}{hasPublishedRecord(p) && p.status !== 'retrospected' && <button className="button small primary" onClick={() => go('retro')}>去复盘<ArrowRight size={13} /></button>}</div>
        </article>;
      })}</div>
        : <section className="panel"><EmptyPanel icon={Target} title="还没有事前预测" description="在稿件完成独立评审后生成预测提案，核对五桶概率与判断依据，再锁定为不可改写的事前记录。" action={eligible.length ? <div className="eligible-list">{eligible.map(d => <button key={d.id} className="eligible-row" onClick={() => openDraft(d)}><span>{d.title}</span><Badge>{stageLabels[d.stage]}</Badge><ArrowUpRight size={13} /></button>)}</div> : <button className="button primary small" onClick={() => go('drafts')}>打开稿件<ArrowRight size={13} /></button>} index="04" /></section>}
    </div>;
  }

  function renderRetro() {
    const published = (snapshot!.predictions || []).filter(p => hasPublishedRecord(p)).sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
    const pendingRetro = published.filter(p => p.status !== 'retrospected');
    return <div className="page retro-page">
      <PageHead kicker="创作循环 · 05" title="复盘" description="发布满 T+3 后录入成熟实绩。真实结果只追加，不用来美化旧判断。" actions={<button className="button" onClick={() => go('forecast')}>查看预测台账<ArrowRight size={14} /></button>} />
      <div className="stat-strip retro-strip">
        <div><span>等待复盘</span><strong>{pendingRetro.length}</strong><small>份</small></div>
        <div><span>成熟复盘</span><strong>{matureRetro.length}</strong><small>次</small></div>
        <div><span>早期快照</span><strong>{snapshot!.predictions.filter(p => p.earlyRetro).length}</strong><small>条不计校准</small></div>
        <div><span>校准样本</span><strong>{snapshot!.project.calibrationSamples}<small> / 5</small></strong></div>
      </div>
      {published.length ? <div className="retro-ledger">{published.map(p => {
        const matured = p.status === 'retrospected' && !p.earlyRetro;
        return <article className={`retro-row ${matured ? 'mature' : ''}`} key={p.id}>
          <div className="retro-row-head">
            <div><Badge tone={matured ? 'green' : p.earlyRetro ? 'amber' : 'seal'}>{matured ? '成熟复盘' : p.earlyRetro ? '早期快照' : '等待 T+3'}</Badge><h2>{p.title}</h2><span>发布于 {fullDate(p.publishedAt || '')}{p.dueAt ? ` · 复盘窗口 ${date(p.dueAt)}` : ''}</span></div>
            <button className="button small" disabled={busy} onClick={() => setActualPrediction(p)}>{p.earlyRetro ? '补录成熟实绩' : p.status === 'retrospected' ? '再次复盘' : '录入实际结果'}<ArrowRight size={13} /></button>
          </div>
          <div className="retro-compare">
            <div><span>事前判断</span><p>{p.forecast}</p></div>
            <div><span>实际表现</span>{p.actual ? <div className="retro-metrics">{Object.entries(metricNames).map(([key, label]) => <div key={key}><small>{label}</small><strong>{format(p.actual![key as keyof Metrics])}</strong></div>)}</div> : <p className="retro-missing">还没有录入实际指标。未取得的数据会保持为空，不补 0。</p>}</div>
          </div>
          <footer><button className="text-button" onClick={() => openPrediction(p)}>查看完整判断<ArrowUpRight size={12} /></button><button className="text-button" onClick={() => openView({ id: `prediction-${p.id}-record`, label: p.title + ' · 记录', documentPath: p.path })}>查看原始记录<ArrowUpRight size={12} /></button></footer>
        </article>;
      })}</div>
        : <section className="panel"><EmptyPanel icon={Activity} title="还没有可以复盘的发布" description="先完成预测并在稿件里登记发布链接。满 T+3 后，这里才会开启成熟实绩录入。" action={<><button className="button small" onClick={() => go('forecast')}>查看预测</button><button className="button primary small" onClick={() => go('drafts')}>打开稿件<ArrowRight size={13} /></button></>} index="05" /></section>}
    </div>;
  }

  function renderLibrary() {
    return <div className="page library-page">
      <PageHead kicker="资产 · 真实作品与指标" title="作品库" description="从 Edge 的创作者中心读取作品与累计指标，作为选题、预测和复盘的现实基线。" actions={space === 'owner' ? <button className="button" disabled={busy} onClick={() => void startSync()}><RefreshCw size={14} />同步抖音作品</button> : <Badge tone="amber">虚构样例数据</Badge>} />
      {snapshot!.works.length ? <>
        <div className="stat-strip library-stats">
          <div><span>作品</span><strong>{snapshot!.works.length}</strong><small>条</small></div>
          <div><span>累计播放</span><strong>{knownPlays ? format(totalPlays) : '—'}</strong><small>{knownPlays === snapshot!.works.length ? '全部已取得' : `${snapshot!.works.length - knownPlays} 条缺失`}</small></div>
          <div><span>累计互动</span><strong>{format(totalInteractions)}</strong><small>赞 / 评 / 藏 / 转</small></div>
          <div><span>最近同步</span><strong className="stat-date">{snapshot!.browser?.lastSyncAt ? date(snapshot!.browser.lastSyncAt) : '示例数据'}</strong><small>{snapshot!.browser?.account?.name || '来源 Edge 创作者中心'}</small></div>
        </div>
        <div className="ledger-toolbar">
          <label className="search-field"><Search size={14} /><input placeholder="搜索作品标题或正文" value={libraryQuery} onChange={e => setLibraryQuery(e.target.value)} /></label>
          <div className="toolbar-right"><select className="compact-select" aria-label="作品排序" value={librarySort} onChange={e => setLibrarySort(e.target.value as 'recent' | 'plays')}><option value="recent">最近发布</option><option value="plays">播放最高</option></select>{selectedWorks.length > 0 && <><span className="selection-count">{selectedWorks.length} 条已选</span><button className="button small" onClick={() => { openAssistant(); void sendChat('请比较我选中的这些作品，结合已有指标说明差异，并区分证据与假设。'); }}><Sparkles size={14} />用 AI 对比</button></>}</div>
        </div>
        <section className="panel table-panel">{workRows(filteredWorks, true)}</section>
        <p className="table-note"><ShieldCheck size={14} />指标反映采集时的累计表现；缺失指标显示为「—」，不会补成零。勾选作品可以加入 AI 的参考材料。</p>
      </> : <section className="connect-empty">
        <div className="connect-empty-copy">
          <span className="recon-index">00</span>
          <h2>把真实作品带进工作台</h2>
          <p>{space === 'demo' ? '体验空间使用虚构样例，不会连接真实账号。真实空间会复用你日常 Edge 的抖音登录。' : '一次配对，长期复用。同步只读取创作者中心页面自身的作品响应，不读取 Cookie，也不会启动第二个浏览器。'}</p>
          <div className="connect-actions">{space === 'owner' && <><button className="button primary" disabled={busy} onClick={() => void startSync()}><Monitor size={15} />{snapshot!.browser?.pairingRequired ? '连接 Edge 并同步' : '同步作品'}</button><button className="button" onClick={() => setSetupOpen(true)}>查看连接设置</button></>}</div>
        </div>
        <ol className="connect-steps">
          <li><span>01</span><div><strong>加载本机扩展</strong><p>Edge 扩展目录只申请创作者中心与本机工作台的访问权限。</p></div></li>
          <li><span>02</span><div><strong>粘贴一次配对码</strong><p>配对长期有效，工作台与 Edge 重启都不需要重新配对。</p></div></li>
          <li><span>03</span><div><strong>读取最近作品</strong><p>缺失指标保持未获取，至少一条真实指标才算成功。</p></div></li>
        </ol>
      </section>}
    </div>;
  }

  function renderMethod() {
    return <div className="page method-page">
      <PageHead kicker="方法 · 开源框架与运行设置" title="方法与设置" description="保留 Cheat on Content 的方法与文件格式，只把每一步变得可见、可操作。" actions={<a className="button" href="https://github.com/XBuilderLAB/cheat-on-content" target="_blank" rel="noreferrer">上游仓库<ArrowUpRight size={14} /></a>} />
      <div className="method-grid">
        <section className="framework-plate">
          <div className="framework-top"><span className="recon-index">CHEAT</span><GitBranch size={22} strokeWidth={1.5} /></div>
          <h2>Cheat on Content</h2>
          <p>打分 → 盲预测 → 发布 → T+3 复盘 → 进化 rubric。创作者实验台把这条循环装进一个本地工作台。</p>
          <div className="framework-meta"><span>UPSTREAM {snapshot!.project.upstreamCommit.slice(0, 10)}</span><span>{snapshot!.project.rootLabel}</span></div>
        </section>
        <section className="principles-plate">
          <span className="principles-kicker">三条不可妥协</span>
          <ol>
            <li><span>01</span><div><strong>盲预测</strong><p>看到实际数据之前写完判断；写完后只能追加复盘。</p></div></li>
            <li><span>02</span><div><strong>升级即全量重打</strong><p>rubric 变化时，校准池用新公式重新打分。</p></div></li>
            <li><span>03</span><div><strong>rubric 是工作台</strong><p>被推翻的观察删除，不保留考古层。</p></div></li>
          </ol>
        </section>
      </div>

      <section className="panel init-panel">
        <PanelHead
          title="Cheat 初始化"
          meta={space === 'demo' ? '演示空间 · 预置样例' : snapshot!.project.legacyInit ? '早期自动初始化 · 待补完' : snapshot!.project.initialized ? 'Phase 0–5 已记录' : '尚未完成初始化'}
          action={<span className={`badge ${snapshot!.project.initialized && !snapshot!.project.legacyInit ? 'ink' : 'seal'}`}>{snapshot!.project.initialized && !snapshot!.project.legacyInit ? '已初始化' : '待完成'}</span>}
        />
        <div className="init-panel-body">
          <div className="init-panel-copy">
            <p>初始化按上游 Cheat on Content 的 Phase 0–5 记录期望、内容形态、历史同步方式、数据回收与对标账号。状态文件最后写入；现有作品、选题、预测与校准样本都会保留。</p>
            <dl className="init-facts">
              <div><dt>名称</dt><dd>{snapshot!.project.name || '未设置'}</dd></div>
              <div><dt>领域</dt><dd>{snapshot!.project.domain || '未设置'}</dd></div>
              <div><dt>内容形态</dt><dd>{contentFormLabels[snapshot!.project.contentForm as ContentForm] || snapshot!.project.contentForm}</dd></div>
              <div><dt>初始化时间</dt><dd>{snapshot!.project.initializedAt ? fullDate(snapshot!.project.initializedAt) : '—'}</dd></div>
              <div><dt>历史样本</dt><dd>{snapshot!.project.historySamples > 0 ? `${snapshot!.project.historySamples} 条 · ${snapshot!.project.historyImportStatus === 'imported' ? '已对齐' : snapshot!.project.historyImportStatus || '待对齐'}` : snapshot!.project.historyImportStatus === 'pending' ? `待对齐 ${snapshot!.project.historyRequested ?? ''} 条` : '未导入'}</dd></div>
              <div><dt>校准样本</dt><dd>{snapshot!.project.calibrationSamples} 个成熟复盘 · {snapshot!.project.confidence}</dd></div>
              <div><dt>历史基线</dt><dd>{snapshot!.project.historyBaselinePlays == null ? '尚未建立' : `${format(snapshot!.project.historyBaselinePlays)} 播放`}</dd></div>
              <div><dt>对标账号</dt><dd>{snapshot!.project.benchmarkStatus === 'imported' ? `${snapshot!.project.benchmarkName || '已导入'} · ${snapshot!.project.benchmarkSampleCount} 条样本` : snapshot!.project.benchmarkStatus === 'pending' ? '待补齐样本' : '未设置'}</dd></div>
            </dl>
            {snapshot!.project.rubricFormMismatch && <div className="subtle-note"><CircleHelp size={14} />评分规则文件仍来自其他内容形态；可在重新初始化时按当前形态生成。</div>}
          </div>
          {space === 'owner'
            ? <div className="init-panel-actions">
              {snapshot!.project.historyImportStatus === 'pending' && <button className="button small" disabled={busy} onClick={() => { setAlignmentSync(true); setSetupOpen(true); }}><Monitor size={14} />对齐历史作品</button>}
              <button className={`button ${snapshot!.project.initialized && !snapshot!.project.legacyInit ? 'small' : 'primary'}`} disabled={busy} onClick={openInitialize}>{snapshot!.project.legacyInit ? '补完初始化' : snapshot!.project.initialized ? '重新初始化' : '开始初始化'}<ArrowRight size={14} /></button>
            </div>
            : <span className="init-demo-note">体验空间使用虚构样例，无需初始化。</span>}
        </div>
      </section>

      <section className="panel settings-panel">
        <PanelHead title="模型与运行设置" meta="本机 Agent 优先 · 费用按两个空间累计" action={<Settings2 size={17} />} />
        {snapshot!.settings.providerIssue && <div className="settings-issue">
          <CircleHelp size={15} />
          <span>{snapshot!.settings.providerIssue}</span>
          <button className="text-button" onClick={() => { setProvider('codebuddy'); setCodebuddyAuth('auto'); }}>改用 CodeBuddy</button>
          <button className="text-button" onClick={() => setProvider('model-api')}>改用模型 API</button>
        </div>}
        <div className="settings-preset" role="group" aria-label="执行通道预设">
          <button className={provider === 'codebuddy' ? 'active' : ''} disabled={space === 'demo'} onClick={() => { setProvider('codebuddy'); setCodebuddyAuth('auto'); }}>
            <Terminal size={17} /><span><strong>本机 CodeBuddy</strong><small>推荐 · 默认主 agent 直接执行</small></span>{provider === 'codebuddy' && <Check size={14} />}
          </button>
          <button className={provider === 'model-api' ? 'active' : ''} disabled={space === 'demo'} onClick={() => setProvider('model-api')}>
            <Sparkles size={17} /><span><strong>独立模型 API</strong><small>DeepSeek / OpenAI 兼容接口</small></span>{provider === 'model-api' && <Check size={14} />}
          </button>
        </div>
        <div className="channel-grid" aria-label="通道状态">
          {snapshot!.settings.channels.map(status => <div key={status.id} className={`channel-card ${status.active ? 'active' : ''} ${status.code}`}>
            <div className="channel-card-head">
              <strong>{status.label}</strong>
              <span className={`channel-code ${channelTone(status.code)}`}>{channelCodeLabel(status.code)}</span>
            </div>
            <p>{status.detail}</p>
            <small>{status.version ? `v${status.version} · ` : ''}{channelAction(status)}</small>
            {status.models?.length ? <small className="channel-models">{status.models.slice(0, 4).join(' / ')}</small> : null}
          </div>)}
        </div>
        <div className="settings-grid">
          <label>CodeBuddy 认证方式<select disabled={space === 'demo' || provider !== 'codebuddy'} value={codebuddyAuth} onChange={e => setCodebuddyAuth(e.target.value as typeof codebuddyAuth)}>
            <option value="auto">自动（优先本机登录，其次模型 API）</option>
            <option value="account">本机 CodeBuddy 登录</option>
            <option value="model-api">用独立模型 API 作为后端</option>
          </select><small className="field-note">当前实际：{resolvedCodeBuddyAuth(snapshot!.settings) === 'account' ? '本机登录' : '模型 API 后端'}</small></label>
          <label>模型接口<select disabled={space === 'demo'} value={modelApi} onChange={e => setModelApi(e.target.value as typeof modelApi)}><option value="deepseek">DeepSeek</option><option value="openai-compatible">OpenAI 兼容</option></select></label>
          <label>接口地址<input disabled={space === 'demo'} value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com" spellCheck={false} /></label>
          <label>模型<input disabled={space === 'demo'} value={model} onChange={e => setModel(e.target.value)} placeholder="deepseek-flash" spellCheck={false} /></label>
          <label>共享费用估算上限（元）<input disabled={space === 'demo'} type="number" min="1" max="500" value={budget} onChange={e => setBudget(e.target.value)} /></label>
          <label className="key-setting">模型 API Key<input disabled={space === 'demo'} type="password" autoComplete="new-password" placeholder={snapshot!.settings.deepseekConfigured ? '已配置 · 输入新密钥以替换' : '仅当前后台进程保存，不回显'} value={apiKey} onChange={e => setApiKey(e.target.value)} /></label>
        </div>
        <div className="blind-panel">
          <div className="blind-panel-head"><ShieldCheck size={16} /><strong>独立盲评</strong><span className={`channel-code ${blindChip(snapshot!.settings).tone}`}>{snapshot!.settings.blind.ready ? '就绪' : '不可用'}</span></div>
          <p>固定为 <b>CodeBuddy 主 agent → {snapshot!.settings.blind.subagent} 子 agent</b>。主 agent 只负责派发一次子 agent 调用，评分文本取自子 agent 的结果；没有通过调用校验就不会保存评分。</p>
          <small>{snapshot!.settings.blind.detail}</small>
          <small className="field-note">模型 API 后端使用临时隔离配置；本机登录态没有一次性配置目录，但同样只传当前稿件与纯评分规则、禁用全部工具。CodeBuddy 不可用时盲评会直接停止，不会改用其他通道。</small>
        </div>
        <div className="settings-footer">
          <div className="availability">
            <span className={snapshot!.settings.channels.find(c => c.id === 'codebuddy')?.code === 'ready' ? 'available' : ''}>CodeBuddy {snapshot!.settings.channels.find(c => c.id === 'codebuddy')?.code === 'ready' ? '就绪' : '待配置'}</span>
            <span className={snapshot!.settings.deepseekConfigured ? 'available' : ''}>模型 API {snapshot!.settings.deepseekConfigured ? '已配置 Key' : '未配置 Key'}</span>
            <span>{space === 'demo' ? '演示空间只读' : `当前实际 · ${activeChannelLabel(snapshot!.settings).label}`}</span>
          </div>
          <div className="settings-actions">
            <button className="button small" disabled={busy || testing || space === 'demo'} onClick={() => void testConnection()}>{testing ? <Spinner /> : <RefreshCw size={13} />}测试连接</button>
            <button className="button primary small" disabled={busy || space === 'demo'} onClick={() => void saveSettings()}>保存设置</button>
          </div>
        </div>
        {testResult && <div className={`settings-test ${testResult.ok ? 'ok' : 'error'}`}>{testResult.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}{testResult.text}</div>}
        <p className="settings-declaration">Qoder、Claude Code、Codex 等通用 Agent 接入正在持续开发，暂不保证兼容；当前完整支持 CodeBuddy 与独立模型 API。Key 仅保留在当前运行的后台进程，不写入设置文件、任务日志或界面响应。</p>
      </section>

      <section className="workspace-facts panel">
        <PanelHead title="当前工作空间" meta={space === 'demo' ? '独立演示目录' : '本地真实目录'} />
        <dl>
          <div><dt>名称</dt><dd>{snapshot!.project.name || '我的创作空间'}</dd></div>
          <div><dt>领域</dt><dd>{snapshot!.project.domain || '尚未填写'}</dd></div>
          <div><dt>平台</dt><dd>{snapshot!.project.platform || '抖音'}</dd></div>
          <div><dt>内容形态</dt><dd>{contentFormLabels[snapshot!.project.contentForm as ContentForm] || snapshot!.project.contentForm}</dd></div>
          <div><dt>历史基线</dt><dd>{snapshot!.project.baselinePlays == null ? '尚未建立' : `${format(snapshot!.project.baselinePlays)} 播放`}</dd></div>
          <div><dt>校准样本</dt><dd>{snapshot!.project.calibrationSamples} 个成熟复盘 · {snapshot!.project.confidence}</dd></div>
          <div><dt>历史样本</dt><dd>{snapshot!.project.historySamples > 0 ? `${snapshot!.project.historySamples} 条` : '未导入'}</dd></div>
        </dl>
      </section>

      <div className="skills-head"><div><span className="results-kicker">上游技能</span><h2>方法与操作说明</h2></div><label className="search-field"><Search size={14} /><input placeholder="搜索技能" value={skillQuery} onChange={e => setSkillQuery(e.target.value)} /></label></div>
      <label className="skill-instruction">任务补充说明（可选）<input placeholder="例如：请先检查现有资料，说明缺少什么再继续" value={skillInstruction} onChange={e => setSkillInstruction(e.target.value)} /></label>
      <div className="skill-grid">{filteredSkills.map(s => <div className="skill-card" key={s.id}>
        <div className="skill-name"><Terminal size={15} /><strong>{s.name}</strong></div>
        <p>{s.description}</p>
        <div className="skill-actions"><button className="text-button" onClick={() => openDoc(s)}>阅读文档<ArrowUpRight size={13} /></button><button className="icon-button" title={`预览${s.name}的操作流程`} aria-label={`预览${s.name}`} disabled={busy || space === 'demo'} onClick={() => void job('skill', { skillId: s.id, instruction: skillInstruction })}><Play size={13} /></button></div>
      </div>)}</div>
    </div>;
  }

  function renderDraft() {
    if (!draft) return <EmptyPanel title="找不到这篇稿件" description="它可能已被移出当前空间。" />;
    const stageIndex = draft.stage === 'draft' ? 0 : draft.stage === 'reviewed' ? 2 : draft.stage === 'predicted' ? 3 : 4;
    const stageFlow = ['写稿', '评审', '预测', '发布', '复盘'];
    const action = stageNext[draft.stage];
    const ActionIcon = action.icon;
    const runAction = async () => {
      if (draft.stage === 'draft') { await score('review'); return; }
      if (draft.stage === 'reviewed') { await score('predict'); return; }
      if (draft.stage === 'predicted') { if (dirty && !(await saveDraft())) return; setPublishDraft(draft); setPublishUrl(''); return; }
      go('retro');
    };
    return <div className="editor-page">
      <div className="editor-stage">{stageFlow.map((label, index) => <div key={label} className={index < stageIndex ? 'done' : index === stageIndex ? 'active' : ''}><span>{index < stageIndex ? <Check size={10} /> : String(index + 1).padStart(2, '0')}</span><strong>{label}</strong>{index < stageFlow.length - 1 && <i />}</div>)}</div>
      <div className="editor-grid">
        <section className="editor-document">
          <div className="editor-toolbar">
            <div className="editor-meta"><Badge tone={stageTones[draft.stage]}>{stageLabels[draft.stage]}</Badge><span>v{draft.version}</span><span className={dirty ? 'unsaved' : ''}>{dirty ? '有未保存修改' : `已保存 · ${time(draft.updatedAt)}`}</span></div>
            <div className="editor-actions"><button className="icon-button" title="复制稿件" aria-label="复制稿件" onClick={() => void copy(draftContent)}><Copy size={15} /></button><a className="icon-button" title="导出已保存版本" aria-label="导出已保存版本" href={endpoint('/api/export?draftId=' + encodeURIComponent(draft.id))} download><ArrowDownToLine size={15} /></a><button className="button small primary" disabled={!dirty || busy} onClick={() => void saveDraft()}>{busy ? <Spinner /> : <Check size={14} />}保存</button></div>
          </div>
          <div className="editor-sheet">
            <span className="editor-kicker">口播稿 / 创作编辑</span>
            <textarea aria-label="稿件标题" rows={2} className="draft-title-input" value={draftTitle} onChange={e => { setDraftTitle(e.target.value); setDirty(true); editBuffers.current[draft.id] = { title: e.target.value, content: draftContent, dirty: true }; }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); editor.current?.focus(); } }} placeholder="为这篇内容起个名字" />
            <div className="editor-byline">{draftContent.replace(/\s/g, '').length} 字 · 最近更新 {date(draft.updatedAt)}</div>
            <textarea ref={editor} className="draft-editor" aria-label="稿件正文" placeholder="把你的想法写在这里。&#10;&#10;也可以在右侧告诉 AI：这一次，你想讲一个怎样的故事？" value={draftContent} onChange={e => { setDraftContent(e.target.value); setDirty(true); editBuffers.current[draft.id] = { title: draftTitle, content: e.target.value, dirty: true }; }} />
          </div>
          <div className="writing-footer"><span><ShieldCheck size={13} />稿件与预测按版本留存</span><button className="text-button" onClick={() => { openAssistant(); setChat('请帮我分析这份稿件，给出具体的修改建议。'); }}>和 AI 讨论<ArrowRight size={13} /></button></div>
        </section>

        <aside className="editor-rail">
          <section className="panel action-panel">
            <span className="rail-kicker">当前动作</span>
            <h3>{action.label}</h3>
            <p>{action.detail}</p>
            <button className="button primary full" disabled={busy || !draftContent.trim()} onClick={() => void runAction()}>{busy ? <Spinner /> : <ActionIcon size={15} />}{action.label}</button>
            {draft.stage !== 'draft' && <button className="button ghost full" disabled={busy || !draftContent.trim()} onClick={() => void score('review')}><ShieldCheck size={14} />重新评审当前版本</button>}
          </section>

          <section className="panel revision-panel">
            <span className="rail-kicker">按你的要求改稿</span>
            <textarea value={reviseInstruction} onChange={e => setReviseInstruction(e.target.value)} placeholder="例如：开头改成我的一次真实经历，语气更自然…" />
            <button className="button small full" disabled={busy || !reviseInstruction.trim() || !draftContent.trim()} onClick={async () => {
              if (dirty && !(await saveDraft())) return;
              const task = await job('revise', { draftId: draft.id, instruction: reviseInstruction });
              if (task) setReviseInstruction('');
            }}><Sparkles size={13} />生成新版本</button>
          </section>

          {review ? reviewPanel(review) : <section className="panel review-empty"><Activity size={22} strokeWidth={1.4} /><h3>还没有独立评审</h3><p>锁定当前版本后，评审会给出七维评分、逐字引用和可执行的修改建议。</p></section>}
        </aside>
      </div>
    </div>;
  }

  function renderMain() {
    if (view.proposalTaskId) {
      const task = snapshot!.tasks.find(task => task.id === view.proposalTaskId);
      const proposal = (task?.result as { proposal?: PredictionProposal } | undefined)?.proposal;
      if (!proposal) return <div className="page"><EmptyPanel icon={Target} title="预测提案尚未就绪" description="请在任务中心查看真实执行进度；生成成功后可检查提案。" action={<button className="button" onClick={openTasks}>打开任务中心<ArrowRight size={13} /></button>} /></div>;
      const proposalDraft = snapshot!.drafts.find(draft => draft.id === proposal.draftId);
      const confirmed = Boolean((task?.result as { confirmedPredictionId?: string } | undefined)?.confirmedPredictionId) || snapshot!.predictions.some(prediction => prediction.draftId === proposal.draftId && prediction.hash === proposal.draftHash && prediction.reviewId === proposal.reviewId);
      const stale = !proposalDraft || proposalDraft.version !== proposal.draftVersion || Boolean(editBuffers.current[proposal.draftId]?.dirty);
      return <PredictionDetailsView title={proposalDraft?.title || '当前稿件'} version={proposal.draftVersion} forecast={proposal.forecast} rationale={proposal.rationale} details={proposal.details} proposal confirmed={confirmed} stale={stale} busy={busy} onBack={proposalDraft ? () => openDraft(proposalDraft) : undefined} onConfirm={async () => {
        try {
          setBusy(true);
          const saved = await request<Prediction>('/api/predictions/confirm', { method: 'POST', body: JSON.stringify({ taskId: task!.id }) });
          await refresh();
          openPrediction(saved);
          toast('事前预测已确认锁定，原记录会持续保留');
        } catch (error) { toast((error as Error).message, 'error'); }
        finally { setBusy(false); }
      }} />;
    }
    if (view.predictionId) {
      const prediction = snapshot!.predictions.find(prediction => prediction.id === view.predictionId);
      if (!prediction?.details) return <div className="page"><EmptyPanel icon={Target} title="这条记录没有结构化预测详情" description="旧版预测仍可在复盘列表与完整记录中查看。" action={<button className="button" onClick={() => go('forecast')}>返回预测<ArrowRight size={13} /></button>} /></div>;
      const predictionDraft = snapshot!.drafts.find(draft => draft.id === prediction.draftId);
      return <PredictionDetailsView title={prediction.title} version={prediction.version} forecast={prediction.forecast} rationale={prediction.rationale} details={prediction.details} proposal={false} confirmed stale={false} busy={busy} onBack={predictionDraft ? () => openDraft(predictionDraft) : () => go('forecast')} />;
    }
    if (view.documentPath) return <div className="page document-page"><div className="reader-head"><button className="text-button" onClick={backFromView}><ArrowLeft size={13} />返回</button><span className="reader-type">{view.documentPath.endsWith('SKILL.md') ? '上游技能文档' : '工作区原始记录'}</span></div><h1>{view.label}</h1><p className="path-label">{view.documentPath}</p>{doc?.path === view.documentPath ? <pre className="markdown-document">{doc.content}</pre> : <div className="loading-inline"><Spinner />正在读取文档</div>}</div>;
    if (view.workId) {
      const w = snapshot!.works.find(w => w.id === view.workId);
      if (!w) return <div className="page"><EmptyPanel title="找不到这条作品" description="它可能已被移出当前空间。" /></div>;
      return <div className="page work-detail-page"><PageHead kicker={`作品 · ${w.source || '抖音'}`} title={w.title} description={`${fullDate(w.publishedAt)}发布 · ${date(w.capturedAt)}采集`} actions={<a className="button" href={w.url} target="_blank" rel="noreferrer"><ExternalLink size={14} />原作品</a>} /><div className="stat-strip work-metrics">{Object.entries(metricNames).map(([key, label]) => <div key={key}><span>{label}</span><strong>{format(w.metrics[key as keyof Metrics])}</strong><small>累计</small></div>)}</div><section className="panel work-body"><PanelHead title="作品资料" meta={w.source} /><p className="body-text">{w.description || '这条作品尚未补充正文。可以在 AI 助手中选中它，结合已取得的标题与表现展开分析。'}</p><div className="subtle-note"><CircleHelp size={14} />指标反映采集时的累计表现；缺失指标保持为「—」。</div><button className="button" onClick={() => { setSelectedWorks(a => a.includes(w.id) ? a : [...a, w.id]); openAssistant(); toast('已加入 AI 助手参考材料'); }}><Plus size={14} />加入 AI 参考材料</button></section></div>;
    }
    if (draft) return renderDraft();
    switch (view.page) {
      case 'ideas': return renderIdeas();
      case 'drafts': return renderDrafts();
      case 'reviews': return renderReviews();
      case 'forecast': return renderForecast();
      case 'retro': return renderRetro();
      case 'library': return renderLibrary();
      case 'method': return renderMethod();
      default: return renderToday();
    }
  }

  const pageForBreadcrumb: Page | undefined = view.page
    || (view.draftId ? 'drafts' : view.workId ? 'library' : view.predictionId || view.proposalTaskId ? 'forecast' : view.documentPath ? 'method' : 'today');
  const paletteEntries = [
    ...(Object.keys(navItems) as Page[]).map(page => ({ group: '页面', title: navItems[page].label, meta: '跳转到页面', icon: navItems[page].icon, run: () => go(page) })),
    ...(space === 'owner' ? [
      { group: '操作', title: snapshot.project.initialized && !snapshot.project.legacyInit ? '重新初始化创作空间' : '初始化创作空间', meta: 'Cheat Phase 0–5 · 六问、对标与历史对齐', icon: Workflow, run: () => setInitOpen(true) },
      { group: '操作', title: '模型与盲评设置', meta: activeChannelLabel(snapshot.settings).label, icon: Settings2, run: () => go('method') },
    ] : []),
    ...drafts.map(d => ({ group: '稿件', title: d.title, meta: `v${d.version} · ${stageLabels[d.stage]}`, icon: FileText, run: () => openDraft(d) })),
    ...snapshot.works.map(w => ({ group: '作品', title: w.title, meta: `${format(w.metrics.plays)} 播放`, icon: Play, run: () => openWork(w) })),
    ...snapshot.predictions.map(p => ({ group: '预测', title: p.title, meta: p.status === 'retrospected' ? '已复盘' : '预测记录', icon: Target, run: () => p.details ? openPrediction(p) : openView({ id: `prediction-${p.id}-record`, label: p.title + ' · 记录', documentPath: p.path }) })),
    ...snapshot.skills.map(s => ({ group: '文档', title: s.name, meta: s.description, icon: BookOpen, run: () => openDoc(s) })),
  ].filter(entry => !paletteQuery.trim() || `${entry.title} ${entry.meta}`.toLowerCase().includes(paletteQuery.trim().toLowerCase())).slice(0, 14);

  return <div className={`app-shell ${navOpen ? 'nav-open' : ''}`}>
    <aside className="rail">
      <a className="rail-brand" href="/">
        <span className="brand-seal"><GitBranch size={19} strokeWidth={1.8} /></span>
        <span><strong>创作者实验台</strong><small>CHEAT WORKBENCH</small></span>
      </a>
      <button className="rail-close" aria-label="关闭导航" onClick={() => setNavOpen(false)}><X size={17} /></button>
      <div className="workspace-card">
        <span className="workspace-avatar">{space === 'demo' ? '演' : '我'}</span>
        <span className="workspace-card-copy"><strong>{snapshot.project.name || '我的创作空间'}</strong><small>{snapshot.project.platform || '抖音'} · {space === 'demo' ? '虚构样例' : '本地保存'}</small></span>
        <span className="workspace-tag">{space === 'demo' ? '演示' : '本地'}</span>
      </div>
      <nav className="rail-nav">
        <span className="rail-label">工作台</span>
        <button className={pageForBreadcrumb === 'today' && !view.draftId && !view.workId && !view.predictionId ? 'active' : ''} onClick={() => go('today')}><LayoutDashboard size={16} /><span>今日工作台</span>{pending.length > 0 && <b>{pending.length}</b>}</button>
        <span className="rail-label">创作循环</span>
        {cycleNav.map(page => {
          const item = navItems[page];
          const count = page === 'ideas' ? snapshot.topics.length : page === 'drafts' ? drafts.length : page === 'reviews' ? snapshot.reviews.length : page === 'forecast' ? snapshot.predictions.length : matureRetro.length;
          const active = pageForBreadcrumb === page && !view.draftId && !view.workId && !view.predictionId && !view.documentPath;
          return <button key={page} className={active ? 'active' : ''} onClick={() => go(page)}><em>{cycleIndex[page]}</em><item.icon size={16} /><span>{item.label}</span>{count > 0 && <b>{count}</b>}</button>;
        })}
        <span className="rail-label">资产</span>
        <button className={pageForBreadcrumb === 'library' && !view.workId ? 'active' : ''} onClick={() => go('library')}><Library size={16} /><span>作品库</span>{snapshot.works.length > 0 && <b>{snapshot.works.length}</b>}</button>
        <button className={pageForBreadcrumb === 'method' && !view.documentPath ? 'active' : ''} onClick={() => go('method')}><Workflow size={16} /><span>方法与设置</span></button>
      </nav>
      <div className="rail-foot">
        {space === 'owner' ? <button className={`rail-connect ${chip?.tone || 'idle'}`} onClick={openEdgePanel}><Monitor size={15} /><span><strong>{chip?.label || '连接 Edge'}</strong><small>{chip?.busy ? '同步进行中' : snapshot.browser?.connected ? '数据源已就绪' : '复用日常登录'}</small></span><i /></button>
          : <div className="rail-connect demo"><ShieldCheck size={15} /><span><strong>独立体验空间</strong><small>不会连接真实账号</small></span><i /></div>}
        <button className="rail-tasks" onClick={openTasks}><Terminal size={15} /><span>任务中心</span>{pending.length > 0 ? <b>{pending.length}</b> : <small>就绪</small>}</button>
        <div className="rail-signature"><span>{space === 'demo' ? 'DEMO' : 'LOCAL FIRST'}</span><span>CHEAT ON CONTENT</span></div>
      </div>
    </aside>
    {navOpen && <button className="rail-scrim" aria-label="关闭导航" onClick={() => setNavOpen(false)} />}

    <div className="shell-main">
      <header className="topbar">
        <div className="topbar-left">
          <button className="mobile-menu" aria-label="打开导航" onClick={() => setNavOpen(true)}><Menu size={18} /></button>
          <div className="crumbs"><span>创作空间</span><ChevronRight size={12} /><strong>{navItems[pageForBreadcrumb].label}</strong>{view.draftId && <><ChevronRight size={12} /><span className="crumb-current">{view.label}</span></>}</div>
        </div>
        <div className="topbar-actions">
          <button className="search-trigger" onClick={() => setPaletteOpen(true)}><Search size={14} /><span>搜索或跳转</span><kbd><Command size={10} />K</kbd></button>
          {space === 'demo' && <span className="space-badge">示例空间</span>}
          <button className={`model-chip ${activeChannelLabel(snapshot.settings).tone}`} title={`${activeChannelLabel(snapshot.settings).detail}\n${blindChip(snapshot.settings).detail}`} aria-label={`执行通道：${activeChannelLabel(snapshot.settings).label}`} onClick={() => go('method')}>{activeChannelLabel(snapshot.settings).tone === 'amber' ? <CircleHelp size={13} /> : <Terminal size={13} />}<span>{activeChannelLabel(snapshot.settings).label}</span></button>
          <button className={`blind-chip ${blindChip(snapshot.settings).tone}`} title={blindChip(snapshot.settings).detail} aria-label={`盲评通道：${blindChip(snapshot.settings).label}`} onClick={() => go('method')}><ShieldCheck size={13} /><span>{blindChip(snapshot.settings).label}</span></button>
          {space === 'owner' && chip && <button className={`edge-chip ${chip.tone}`} title={chip.hint} aria-label={chip.hint} onClick={openEdgePanel}>{chip.busy ? <Spinner /> : <Monitor size={14} />}<span>{chip.label}</span></button>}
          <button className={`assistant-toggle ${assistantOpen ? 'active' : ''}`} aria-label={assistantOpen ? '关闭 AI 助手' : '打开 AI 助手'} onClick={() => assistantOpen ? setAssistantOpen(false) : openAssistant()}><Sparkles size={15} /><span>AI 助手</span>{(draft || selectedWorks.length > 0) && <i />}</button>
          <span className="user-avatar">{space === 'demo' ? '演' : '我'}</span>
        </div>
      </header>
      <main className="workspace">
        {loadError && <div className="connection-error"><XCircle size={14} />连接状态读取失败：{loadError}<button onClick={() => void refresh()}>重试</button></div>}
        <div className="workspace-scroll" key={view.id}>{renderMain()}</div>
      </main>
    </div>

    {assistantOpen && <><button className="panel-scrim" aria-label="关闭 AI 助手" onClick={() => setAssistantOpen(false)} /><aside className="assistant-panel">
      <div className="assistant-header"><span className="assistant-symbol"><Sparkles size={16} /></span><div><strong>AI 创作助手</strong><small>围绕当前材料共创，不替你下结论</small></div><button className="icon-button" aria-label="关闭 AI 助手" onClick={() => setAssistantOpen(false)}><X size={17} /></button></div>
      <div className="assistant-context">
        <div className="context-label"><span>本次额外材料</span><span>{selectedWorks.length + (draft ? 1 : 0)} 项</span></div>
        <div className="context-chips">{draft && <span><FileText size={11} />{draft.title}</span>}{selectedWorks.map(id => <span key={id}><Play size={10} />{snapshot.works.find(w => w.id === id)?.title || '作品'}<button aria-label="移除参考作品" onClick={() => setSelectedWorks(a => a.filter(v => v !== id))}><X size={10} /></button></span>)}{!draft && !selectedWorks.length && <p>不勾选也可以：账号资料会随消息自动读取。</p>}</div>
        <div className="context-loaded">
          <span className="context-label">已自动读取本机资料</span>
          {contextSummary ? <div className="context-source">
            {([['受众画像', contextSummary.audience, contextSummary.truncated.audience], ['评分规则', contextSummary.rubric, contextSummary.truncated.rubric], ['写稿结构', contextSummary.scriptPatterns, contextSummary.truncated.scriptPatterns], ['对标账号', contextSummary.benchmark, contextSummary.truncated.benchmark], ['评分备忘', contextSummary.rubricMemo, contextSummary.truncated.rubricMemo]] as const).map(([label, chars, clipped]) => <span key={label} className={chars > 0 ? 'on' : 'off'} title={chars > 0 ? `已附带 ${chars.toLocaleString('zh-CN')} 字符${clipped ? '（原文更长，仅附前部）' : ''}` : '本地文件缺失或为空'}>{label}{chars > 0 ? ` ${chars.toLocaleString('zh-CN')} 字` : ' 缺失'}{clipped ? ' · 截断' : ''}</span>)}
            <span className={contextSummary.works ? 'on' : 'off'} title={`本次附带 ${contextSummary.works} 条，本地共 ${contextSummary.worksTotal} 条`}>历史作品 {contextSummary.works} / {contextSummary.worksTotal}</span>
            <span className={contextSummary.topics ? 'on' : 'off'} title={`本次附带 ${contextSummary.topics} 条，本地共 ${contextSummary.topicsTotal} 条`}>候选选题 {contextSummary.topics} / {contextSummary.topicsTotal}</span>
            {contextSummary.trends > 0 && <span className="on" title={`本次附带 ${contextSummary.trends} 条，本地共 ${contextSummary.trendsTotal} 条`}>原始线索 {contextSummary.trends} / {contextSummary.trendsTotal}</span>}
            {contextSummary.draft && <span className="on" title={contextSummary.truncated.draft ? '稿件超过长度上限，仅附带前部' : '当前稿件全文已附带'}>当前稿件 {contextSummary.draftChars.toLocaleString('zh-CN')} 字{contextSummary.truncated.draft ? ' · 截断' : ''}</span>}
          </div> : <p>正在读取本地文件…</p>}
        </div>
      </div>
      <div className="chat-messages">
        {snapshot.messages.length ? snapshot.messages.map(m => <div key={m.id} className={`chat-message ${m.role}`}><div className="message-role">{m.role === 'assistant' ? <Sparkles size={12} /> : <span className="mini-avatar">我</span>}<span>{m.role === 'assistant' ? '创作助手' : '你'}</span><time>{time(m.createdAt)}</time></div><div className="message-content">{m.content}</div></div>)
          : <div className="assistant-welcome"><span className="assistant-kicker">开始一次对话</span><h2>{draft ? '把这篇稿件改得更具体。' : '从材料出发，而不是从空话出发。'}</h2><p>{draft ? '可以让我指出证据不足的段落、比较两种开头，或把一段抽象表达改写成真实经历。' : '账号画像、评分规则和写稿结构会随消息自动读取。打开稿件或勾选作品，可以再加一层具体材料，我会据此梳理角度、检查证据，并区分事实与假设。'}</p><div className="prompt-suggestions">{['从我的历史作品里，发现值得继续的方向', '帮我把一个模糊的想法讲清楚', '解释一下评审与事前预测的区别'].map((s, i) => <button key={s} onClick={() => void sendChat(s)}><span>{[<Library size={14} />, <MessageSquare size={14} />, <Target size={14} />][i]}</span>{s}<ArrowUpRight size={12} /></button>)}</div></div>}
        {pending.some(t => t.kind === 'chat') && <div className="assistant-thinking"><Spinner />正在整理想法…</div>}
        <div ref={chatEnd} />
      </div>
      <div className="chat-compose"><div className="chat-input-wrap"><textarea aria-label="给 AI 助手发消息" placeholder={draft ? '围绕这篇稿件，聊聊你的想法…' : '告诉我，你想做怎样的内容…'} value={chat} onChange={e => setChat(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!busy) void sendChat(); } }} /><div><span>Shift + Enter 换行</span><button className="send-button" aria-label="发送消息" disabled={!chat.trim() || busy} onClick={() => void sendChat()}><Send size={15} /></button></div></div><p>AI 的建议需要你的判断，事实与来源请核实。</p></div>
    </aside></>}

    {taskOpen && <><button className="panel-scrim" aria-label="关闭任务中心" onClick={() => setTaskOpen(false)} /><aside className="task-drawer">
      <div className="task-drawer-header"><div><span className="assistant-symbol"><Terminal size={15} /></span><div><strong>任务中心</strong><small>同步、评审、预测与复盘的真实执行记录</small><div className="task-drawer-channels"><span className={`model-chip ${activeChannelLabel(snapshot.settings).tone}`} title={activeChannelLabel(snapshot.settings).detail}><Terminal size={11} /><span>{activeChannelLabel(snapshot.settings).label}</span></span><span className={`blind-chip ${blindChip(snapshot.settings).tone}`} title={blindChip(snapshot.settings).detail}><ShieldCheck size={11} /><span>{blindChip(snapshot.settings).label}</span></span></div></div></div><button className="icon-button" aria-label="关闭任务中心" onClick={() => setTaskOpen(false)}><X size={17} /></button></div>
      <div className="task-drawer-body">{recentTasks.length ? [...recentTasks].sort((a, b) => Number(activeTask(b)) - Number(activeTask(a)) || b.createdAt.localeCompare(a.createdAt)).map(t => <article key={t.id} className={`task-item ${t.status}`}>
        <div className="task-item-head"><span className="task-state-icon">{activeTask(t) ? <Spinner /> : t.status === 'completed' ? <CheckCircle2 size={15} /> : <XCircle size={15} />}</span><strong>{t.label}</strong><Badge tone={t.status === 'failed' ? 'red' : t.status === 'completed' ? 'green' : ''}>{taskNames[t.status]}</Badge><time>{date(t.createdAt)} {time(t.createdAt)}</time>{activeTask(t) && t.status !== 'cancelling' && <button className="text-button" onClick={async () => { try { await request(`/api/jobs/${t.id}/cancel`, { method: 'POST' }); await refresh(); toast('已请求取消任务'); } catch (e) { toast((e as Error).message, 'error'); } }}>取消</button>}</div>
        <div className="task-events">{t.events.filter((event, index, events) => index === 0 || event.message !== events[index - 1].message).map((e, i) => <div className={e.level || ''} key={i}><time>{time(e.at)}</time><span>{taskEventText(e.message)}</span></div>)}{t.error && <p className="task-error">{t.error}</p>}{t.status === 'waiting' && <div className="waiting-message"><CircleHelp size={14} />此任务需要你完成登录或补充操作。</div>}</div>
        {t.status === 'completed' && t.result != null && <div className="task-result">
          {(t.result as { draft?: Draft }).draft && <button className="button small" onClick={() => { openDraft((t.result as { draft: Draft }).draft); setTaskOpen(false); }}>打开生成的稿件<ArrowRight size={13} /></button>}
          {typeof (t.result as { message?: string }).message === 'string' && <div className="task-result-text">{(t.result as { message: string }).message}</div>}
          {(t.kind === 'topics' || t.kind === 'trends') && <button className="button small" onClick={() => { go('ideas'); setTaskOpen(false); }}>查看选题与来源<ArrowRight size={13} /></button>}
          {t.kind === 'review' && <button className="button small" onClick={() => { const d = snapshot.drafts.find(d => d.id === (t.result as Review).draftId); if (d) openDraft(d); setTaskOpen(false); }}>查看评审结果<ArrowRight size={13} /></button>}
          {t.kind === 'predict' && (t.result as { proposal?: PredictionProposal }).proposal ? <button className="button small" onClick={() => { openView({ id: `proposal-${t.id}`, label: '事前预测提案', proposalTaskId: t.id }); setTaskOpen(false); }}><Target size={13} />{(t.result as { confirmedPredictionId?: string }).confirmedPredictionId ? '查看已锁定预测' : '查看并确认预测'}<ArrowRight size={13} /></button> : (t.kind === 'predict' || t.kind === 'retro') && <button className="button small" onClick={() => { go('retro'); setTaskOpen(false); }}>查看复盘<ArrowRight size={13} /></button>}
        </div>}
        {t.kind === 'sync' && space === 'owner' && browserTaskResult(t) && <div className="sync-task-view"><span><Monitor size={14} />{syncSummary(t)}</span><button className="button small" onClick={() => { setDismissedConnection(null); setConnectionTaskId(t.id); setTaskOpen(false); }}>{activeTask(t) ? '查看同步阶段' : '查看本次记录'}<ArrowRight size={13} /></button></div>}
      </article>) : <EmptyPanel icon={Terminal} title={legacyTasks.length ? '还没有新流程的执行记录' : '还没有执行记录'} description="同步作品、搜索热点、评审和预测的真实进度会记录在这里。" />}
        {legacyTasks.length > 0 && <details className="task-legacy-group">
          <summary><span>旧版采集记录</span><Badge>{legacyTasks.length}</Badge><small>启用 Edge 扩展前</small></summary>
          <p>这些任务来自已停用的旧版同步流程，只保留结果，不再展示过程日志。</p>
          <div className="task-legacy-rows">{[...legacyTasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(t => <div key={t.id} className="task-legacy-row"><span className={`legacy-mark ${t.status}`} /><time>{date(t.createdAt)}</time><strong>{taskNames[t.status] || t.status}</strong><small>{t.error ? excerpt(t.error, 34) : '旧版采集'}</small></div>)}</div>
        </details>}
      </div>
    </aside></>}

    {paletteOpen && <div className="palette-backdrop" onMouseDown={() => setPaletteOpen(false)}><div className="palette" role="dialog" aria-modal="true" aria-label="搜索或跳转" onMouseDown={e => e.stopPropagation()}>
      <div className="palette-search"><Search size={16} /><input ref={paletteInput} placeholder="搜索页面、稿件、作品、预测或文档…" value={paletteQuery} onChange={e => setPaletteQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && paletteEntries[0]) { paletteEntries[0].run(); setPaletteOpen(false); } }} /><kbd>ESC</kbd></div>
      <div className="palette-results">{paletteEntries.length ? paletteEntries.map((entry, index) => <button key={`${entry.group}-${entry.title}-${index}`} onClick={() => { entry.run(); setPaletteOpen(false); }}><span className="palette-icon"><entry.icon size={15} /></span><span><strong>{entry.title}</strong><small>{entry.meta}</small></span><em>{entry.group}</em></button>) : <div className="palette-empty">没有匹配的结果。</div>}</div>
      <div className="palette-foot"><span><kbd>↵</kbd> 打开第一项</span><span><kbd>⌘K</kbd> 随时呼出</span></div>
    </div></div>}

    {connectionTask && <ConnectionDialog key={connectionTask.id} task={connectionTask} browser={snapshot.browser} onClose={() => { setDismissedConnection(connectionTask.id); setConnectionTaskId(null); }} onConfirm={async () => { await request(`/api/connections/${connectionTask.id}/confirm`, { method: 'POST', body: JSON.stringify({ confirmed: true }) }); await refresh(); toast('已确认账号，继续同步'); }} onCancel={async () => { await request(`/api/jobs/${connectionTask.id}/cancel`, { method: 'POST' }); await refresh(); toast('已请求取消，不会导入部分结果'); }} onFocus={async () => { await request('/api/browser/focus', { method: 'POST', body: JSON.stringify({ taskId: connectionTask.id }) }); toast('已聚焦 Edge 创作者中心标签'); }} onSetup={() => { setDismissedConnection(connectionTask.id); setConnectionTaskId(null); setSetupOpen(true); }} />}
    {space === 'owner' && setupOpen && <BrowserConnectionSetup browser={snapshot.browser} onClose={() => { setSetupOpen(false); setAlignmentSync(false); }} onGenerate={async () => request<BrowserPairing>('/api/browser/pairing', { method: 'POST', body: '{}' })} onReveal={async () => { await request('/api/browser/reveal-extension', { method: 'POST', body: '{}' }); toast('已在文件管理器中打开扩展目录'); }} onStart={async () => { const started = await startSync(alignmentSync); if (started) setSetupOpen(false); }} />}
    {space === 'owner' && initOpen && <CheatInitWizard project={snapshot.project} request={request} onClose={() => setInitOpen(false)} onRefresh={refresh} onToast={toast} onAlignHistory={() => { setInitOpen(false); setAlignmentSync(true); setSetupOpen(true); }} />}
    {notice && <div className={`toast ${notice.type}`} role="status">{notice.type === 'success' ? <CheckCircle2 size={16} /> : <XCircle size={16} />}<span>{notice.text}</span><button aria-label="关闭提示" onClick={() => setNotice(null)}><X size={13} /></button></div>}

    {newDraft && <div className="modal-backdrop" onClick={() => setNewDraft(false)}><div className="modal new-draft-modal" role="dialog" aria-modal="true" aria-labelledby="new-draft-title" onClick={e => e.stopPropagation()}><button className="modal-close icon-button" aria-label="关闭" onClick={() => setNewDraft(false)}><X size={18} /></button><span className="modal-index">02 / 稿件</span><h2 id="new-draft-title">开始一篇新稿件</h2><p>先给它一个名字。你随时可以在编辑器里继续修改，版本会被保留。</p><label>稿件标题<input autoFocus value={newTitle} placeholder="这一次，我想讲…" onChange={e => setNewTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void createDraft(); }} /></label><button className="button primary full" disabled={!newTitle.trim() || busy} onClick={() => void createDraft()}>{busy ? <Spinner /> : <ArrowRight size={15} />}创建并打开稿件</button></div></div>}
    {draftingTopic && <div className="modal-backdrop" onClick={() => setDraftingTopic(null)}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="topic-brief-title" onClick={e => e.stopPropagation()}><button className="modal-close icon-button" aria-label="关闭" onClick={() => setDraftingTopic(null)}><X size={18} /></button><span className="modal-index">01 / 选题</span><h2 id="topic-brief-title">把你的经历带进这个角度</h2><p className="modal-topic-title">{draftingTopic.title}</p><p>{draftingTopic.personalInput || '补充你亲历的故事、事实或希望表达的观点。留空时，AI 会标明需要补充的内容。'}</p><label>个人材料与写作要求<textarea className="brief-textarea" autoFocus value={personalBrief} onChange={e => setPersonalBrief(e.target.value)} placeholder="我曾经遇到过… / 这次希望讲给… / 不要使用…" /></label><button className="button primary full" disabled={busy} onClick={async () => { const task = await job('draft', { topicId: draftingTopic.id, brief: draftingTopic.angle + (personalBrief.trim() ? `\n用户补充：${personalBrief.trim()}` : ''), title: draftingTopic.title }); if (task) setDraftingTopic(null); }}><Sparkles size={15} />生成可编辑初稿</button></div></div>}
    {publishDraft && <div className="modal-backdrop" onClick={() => setPublishDraft(null)}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="publish-title" onClick={e => e.stopPropagation()}><button className="modal-close icon-button" aria-label="关闭" onClick={() => setPublishDraft(null)}><X size={18} /></button><span className="modal-index">04 / 发布</span><h2 id="publish-title">登记发布记录</h2><p>关联已经发布的作品，之后用实际表现完成复盘。这里不会自动发布内容。</p><label>作品链接<input autoFocus value={publishUrl} onChange={e => setPublishUrl(e.target.value)} placeholder="https://www.douyin.com/video/…" type="url" /></label><button className="button primary full" disabled={!publishUrl.trim() || busy} onClick={async () => { try { setBusy(true); await request('/api/publish', { method: 'POST', body: JSON.stringify({ draftId: publishDraft.id, url: publishUrl }) }); setPublishDraft(null); await refresh(); toast('已登记发布记录'); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); } }}>保存发布记录<Check size={15} /></button></div></div>}
    {actualPrediction && <RetrospectiveDialog key={actualPrediction.id} prediction={actualPrediction} onClose={() => setActualPrediction(null)} onSubmit={async (actual, earlyConfirmed) => { const task = await job('retro', { predictionId: actualPrediction.id, actual, ...(earlyConfirmed ? { earlyConfirmed: true } : {}) }); if (task && !['failed', 'cancelled', 'interrupted'].includes(task.status)) { setActualPrediction(null); return true; } return false; }} />}
  </div>;
}
