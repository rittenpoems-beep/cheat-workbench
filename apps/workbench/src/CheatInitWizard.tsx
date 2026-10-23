import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft, ArrowRight, Check, CheckCircle2, CircleHelp, FileText, LoaderCircle, Monitor,
  Plus, ShieldCheck, Sparkles, Trash2, Workflow, X, XCircle,
} from 'lucide-react';
import {
  cadenceLabels, cadenceOptions, contentFormLabels, contentForms, durationLabels, durationOptions,
  durationQuestionForms, type ContentForm, type InitInput, type InitReport, type InitSample, type InitStatus,
} from '../shared/initialization';
import type { Snapshot, Task } from '../shared/types';

type Stage = 'expectations' | 'form' | 'duration' | 'cadence' | 'history' | 'platform' | 'history-method' | 'history-count'
  | 'collection' | 'pool' | 'hooks' | 'benchmark-mode' | 'benchmark-account' | 'benchmark-samples' | 'review' | 'running' | 'complete';
type AnalysisState = { status: 'idle' | 'running' | 'done' | 'error'; detail: string };
type Props = {
  project: Snapshot['project'];
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  onClose: () => void;
  onRefresh: () => Promise<unknown>;
  onToast: (text: string, type?: 'success' | 'error') => void;
  onAlignHistory: () => void;
};

const DRAFT_KEY = 'cheat-workbench:init-draft:v1';
const activeStatuses = ['queued', 'running', 'waiting', 'cancelling'];
const formDetails: Record<ContentForm, string> = {
  'opinion-video': '口播、评论与观点表达，默认 1–3 分钟',
  'long-essay': '深度文章、Newsletter 或长帖',
  'short-text': '短文、Thread 或短评',
  podcast: '播客、对谈或长视频',
  'tutorial-builder': '步骤、代码与 Builder 记录',
  other: '不属于以上形态',
  mixed: '多种形态并行，先用观点视频规则起步',
};
const poolLabels = { none: '暂不建立', markdown: '本地 Markdown 列表', notion: 'Notion / 外部文档' } as const;
const groups = [
  { label: '期望', stages: ['expectations'] },
  { label: '形态', stages: ['form', 'duration', 'cadence'] },
  { label: '历史', stages: ['history', 'platform', 'history-method', 'history-count'] },
  { label: '数据', stages: ['collection', 'pool', 'hooks'] },
  { label: '对标', stages: ['benchmark-mode', 'benchmark-account', 'benchmark-samples'] },
  { label: '确认', stages: ['review'] },
  { label: '执行', stages: ['running', 'complete'] },
] as const;
const stageLabels: Record<Stage, string> = {
  expectations: '期望', form: 'Q1', duration: 'Q1.5', cadence: 'Q1.6', history: 'Q2', platform: 'Q2.1',
  'history-method': 'Q2.2', 'history-count': 'Q2.3', collection: 'Q3', pool: 'Q4', hooks: 'Q5',
  'benchmark-mode': '对标', 'benchmark-account': '对标账号', 'benchmark-samples': '对标样本',
  review: '确认', running: '执行', complete: '完成',
};
const blankSample = (): InitSample => ({ title: '', plays: null, likes: null, comments: null, shares: null, impression: 'medium', url: '', transcript: '' });
const metricFields = [['plays', '播放'], ['likes', '点赞'], ['comments', '评论'], ['shares', '转发']] as const;
const parseMetric = (value: string): number | null => {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
};
const formatMoment = (value: string | null) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '未记录';

function Spinner() { return <LoaderCircle className="spin" size={16} />; }
function Question({ kicker, title, hint, children }: { kicker: string; title: string; hint?: ReactNode; children: ReactNode }) {
  return <section className="init-question">
    <span className="init-kicker">{kicker}</span>
    <h3>{title}</h3>
    {hint && <p className="init-hint">{hint}</p>}
    {children}
  </section>;
}
function Choice({ selected, title, detail, onClick, icon }: { selected: boolean; title: string; detail?: ReactNode; onClick: () => void; icon?: ReactNode }) {
  return <button type="button" role="radio" aria-checked={selected} className={`init-choice ${selected ? 'selected' : ''}`} onClick={onClick}>
    <span className="init-choice-mark">{selected ? <Check size={14} /> : icon}</span>
    <span className="init-choice-copy"><strong>{title}</strong>{detail && <small>{detail}</small>}</span>
  </button>;
}

export default function CheatInitWizard({ project, request, onClose, onRefresh, onToast, onAlignHistory }: Props) {
  const saved = useRef<Record<string, unknown> | null>(null);
  if (saved.current === null) {
    try { saved.current = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null'); } catch { saved.current = null; }
  }
  const draftAnswers = saved.current;
  const [status, setStatus] = useState<InitStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [stage, setStage] = useState<Stage>('expectations');
  const [name, setName] = useState(() => typeof draftAnswers?.name === 'string' ? draftAnswers.name : project.name);
  const [domain, setDomain] = useState(() => typeof draftAnswers?.domain === 'string' ? draftAnswers.domain : project.domain);
  const [contentForm, setContentForm] = useState<ContentForm>(() => contentForms.includes(draftAnswers?.contentForm as ContentForm) ? draftAnswers!.contentForm as ContentForm : (project.contentForm as ContentForm) || 'opinion-video');
  const [duration, setDuration] = useState<number>(() => durationOptions.includes(draftAnswers?.duration as any) ? draftAnswers!.duration as number : project.typicalDurationSeconds || 90);
  const [cadence, setCadence] = useState<number>(() => cadenceOptions.includes(draftAnswers?.cadence as any) ? draftAnswers!.cadence as number : project.cadenceDays || 2);
  const [historyMode, setHistoryMode] = useState<'import' | 'skip'>(() => draftAnswers?.historyMode === 'import' ? 'import' : draftAnswers?.historyMode === 'skip' ? 'skip' : 'import');
  const [historyCount, setHistoryCount] = useState(() => typeof draftAnswers?.historyCount === 'string' ? draftAnswers.historyCount : '20');
  const [dataCollection, setDataCollection] = useState<'manual' | 'adapter'>(() => draftAnswers?.dataCollection === 'manual' ? 'manual' : 'adapter');
  const [poolStatus, setPoolStatus] = useState<'none' | 'markdown' | 'notion'>(() => ['none', 'markdown', 'notion'].includes(draftAnswers?.poolStatus as string) ? draftAnswers!.poolStatus as 'none' | 'markdown' | 'notion' : project.poolStatus === 'markdown' || project.poolStatus === 'notion' ? project.poolStatus : 'none');
  const [hooks, setHooks] = useState(() => draftAnswers?.hooks === true);
  const [benchmarkMode, setBenchmarkMode] = useState<'imported' | 'pending' | 'none'>(() => ['imported', 'pending', 'none'].includes(draftAnswers?.benchmarkMode as string) ? draftAnswers!.benchmarkMode as 'imported' | 'pending' | 'none' : project.benchmarkStatus);
  const [benchmarkName, setBenchmarkName] = useState(() => typeof draftAnswers?.benchmarkName === 'string' ? draftAnswers.benchmarkName : project.benchmarkName || '');
  const [benchmarkStyle, setBenchmarkStyle] = useState(() => typeof draftAnswers?.benchmarkStyle === 'string' ? draftAnswers.benchmarkStyle : '');
  const [samples, setSamples] = useState<InitSample[]>(() => Array.isArray(draftAnswers?.samples) ? draftAnswers!.samples as InitSample[] : []);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [task, setTask] = useState<Task | null>(null);
  const [report, setReport] = useState<InitReport | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisState>({ status: 'idle', detail: '' });

  useEffect(() => {
    let cancelled = false;
    setStatus(null); setStatusError('');
    request<InitStatus>('/api/init/status')
      .then(value => {
        if (cancelled) return;
        setStatus(value);
        if (!draftAnswers) {
          if (value.works > 0) setHistoryCount(String(value.works));
          if (value.hasData) setDataCollection('adapter');
        }
      })
      .catch((reason: Error) => { if (!cancelled) setStatusError(reason.message); });
    return () => { cancelled = true; };
  }, [request]);

  useEffect(() => {
    if (stage === 'complete') return;
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
        name, domain, contentForm, duration, cadence, historyMode, historyCount, dataCollection,
        poolStatus, hooks, benchmarkMode, benchmarkName, benchmarkStyle, samples,
      }));
    } catch { /* Session storage may be unavailable; answers remain in memory. */ }
  }, [name, domain, contentForm, duration, cadence, historyMode, historyCount, dataCollection, poolStatus, hooks, benchmarkMode, benchmarkName, benchmarkStyle, samples, stage]);

  const close = () => {
    if (stage === 'running') { onToast('初始化正在写入，请等待完成或先取消任务。', 'error'); return; }
    onClose();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stage]);

  const showError = (message: string) => setError(message);
  const goBack = () => {
    setError('');
    const previous: Partial<Record<Stage, Stage>> = {
      form: 'expectations', duration: 'form', cadence: durationQuestionForms.includes(contentForm) ? 'duration' : 'form',
      history: 'cadence', platform: 'history', 'history-method': 'platform', 'history-count': 'history-method',
      collection: historyMode === 'import' ? 'history-count' : 'history', pool: 'collection', hooks: 'pool',
      'benchmark-mode': 'hooks', 'benchmark-account': 'benchmark-mode', 'benchmark-samples': 'benchmark-account',
      review: benchmarkMode === 'none' ? 'hooks' : benchmarkMode === 'imported' ? 'benchmark-samples' : 'benchmark-account',
    };
    const target = previous[stage];
    if (target) setStage(target);
  };
  const goNext = () => {
    setError('');
    if (stage === 'expectations') {
      if (!name.trim()) return showError('请填写创作空间名称。');
      if (name.trim().length > 100) return showError('创作空间名称不能超过 100 字。');
      return setStage('form');
    }
    if (stage === 'form') return setStage(durationQuestionForms.includes(contentForm) ? 'duration' : 'cadence');
    if (stage === 'duration') return setStage('cadence');
    if (stage === 'cadence') return setStage('history');
    if (stage === 'history') return setStage(historyMode === 'import' ? 'platform' : 'collection');
    if (stage === 'platform') return setStage('history-method');
    if (stage === 'history-method') return setStage('history-count');
    if (stage === 'history-count') {
      const count = Number(historyCount);
      if (!Number.isInteger(count) || count < 1 || count > 500) return showError('请填写 1 到 500 之间的历史作品数量。');
      return setStage('collection');
    }
    if (stage === 'collection') return setStage('pool');
    if (stage === 'pool') return setStage('hooks');
    if (stage === 'hooks') return setStage('benchmark-mode');
    if (stage === 'benchmark-mode') {
      if (benchmarkMode === 'imported' && samples.length < 3) setSamples([blankSample(), blankSample(), blankSample()]);
      return setStage(benchmarkMode === 'none' ? 'review' : 'benchmark-account');
    }
    if (stage === 'benchmark-account') {
      if (benchmarkMode === 'imported' && !benchmarkName.trim()) return showError('导入对标时请填写对标账号名。');
      return setStage(benchmarkMode === 'imported' ? 'benchmark-samples' : 'review');
    }
    if (stage === 'benchmark-samples') {
      if (samples.length < 3) return showError('对标分析至少需要 3 条样本。');
      if (samples.some(sample => !sample.title.trim())) return showError('每条对标样本都需要填写视频标题。');
      return setStage('review');
    }
    if (stage === 'review') {
      if (status?.initialized && !confirmed) return showError('请先确认重新初始化会重写配置。');
      void execute();
    }
  };

  const buildInput = (): InitInput => ({
    confirmed: status?.initialized ? confirmed : false,
    name: name.trim(), domain: domain.trim(), contentForm,
    typicalDurationSeconds: durationQuestionForms.includes(contentForm) ? duration as 30 | 90 | 240 | 450 | 900 : null,
    cadenceDays: cadence as 1 | 2 | 7,
    historyMode,
    historyCount: historyMode === 'import' ? Number(historyCount) : null,
    dataCollection, poolStatus, hooks,
    benchmark: {
      mode: benchmarkMode,
      name: benchmarkMode === 'none' ? '' : benchmarkName.trim(),
      style: benchmarkStyle.trim(), platform: '抖音',
      samples: benchmarkMode === 'imported'
        ? samples.map(sample => ({ ...sample, title: sample.title.trim(), url: sample.url || '', transcript: sample.transcript || '' }))
        : [],
    },
  });

  const pollTask = async (id: string, update: (latest: Task) => void): Promise<Task> => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      await new Promise(resolve => window.setTimeout(resolve, 700));
      const latest = await request<Task>(`/api/tasks/${id}`);
      update(latest);
      if (!activeStatuses.includes(latest.status)) return latest;
    }
    throw new Error('任务耗时过长，请到任务中心查看结果。');
  };
  const execute = async () => {
    setStage('running'); setTask(null); setReport(null); setError(''); setAnalysis({ status: 'idle', detail: '' });
    try {
      const started = await request<Task>('/api/jobs', { method: 'POST', body: JSON.stringify({ kind: 'initialize', input: buildInput() }) });
      setTask(started);
      const latest = await pollTask(started.id, setTask);
      if (latest.status !== 'completed') throw new Error(latest.error || '初始化没有完成。');
      setReport(latest.result as InitReport);
      setStage('complete');
      try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
      await onRefresh();
      onToast('Cheat 创作空间已完成初始化');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '初始化失败');
    }
  };
  const cancelInitialize = async () => {
    if (!task) return;
    try {
      await request(`/api/jobs/${task.id}/cancel`, { method: 'POST' });
      onToast('已请求取消初始化');
    } catch (reason) { showError((reason as Error).message); }
  };
  const runBenchmark = async () => {
    setAnalysis({ status: 'running', detail: '正在读取对标样本并调用主 agent…' });
    try {
      const started = await request<Task>('/api/jobs', { method: 'POST', body: JSON.stringify({ kind: 'benchmark', input: {} }) });
      const latest = await pollTask(started.id, value => setAnalysis({ status: 'running', detail: value.events.at(-1)?.message || '正在分析对标样本…' }));
      if (latest.status !== 'completed') throw new Error(latest.error || '对标分析没有完成。');
      const result = latest.result as { benchmark?: { summary?: string; sampleCount?: number } };
      setAnalysis({ status: 'done', detail: result.benchmark?.summary || '定性观察已写入 benchmark.md、script_patterns.md 与 rubric-memo.md。' });
      await onRefresh();
    } catch (reason) {
      setAnalysis({ status: 'error', detail: reason instanceof Error ? reason.message : '对标分析失败。' });
    }
  };
  const updateSample = (index: number, change: Partial<InitSample>) => setSamples(list => list.map((sample, position) => position === index ? { ...sample, ...change } : sample));

  const activeGroup = stage === 'complete' ? groups.length : Math.max(0, groups.findIndex(group => (group.stages as readonly Stage[]).includes(stage)));
  const canNext = stage === 'expectations' ? Boolean(name.trim())
    : stage === 'benchmark-account' ? benchmarkMode !== 'imported' || Boolean(benchmarkName.trim())
      : stage === 'benchmark-samples' ? benchmarkMode !== 'imported' || (samples.length >= 3 && samples.every(sample => sample.title.trim()))
        : stage === 'review' ? !status?.initialized || confirmed
          : true;

  const stageBody = () => {
    if (statusError) return <Question kicker="无法读取初始化状态" title="工作台服务没有返回状态" hint={statusError}>
      <button className="button" onClick={() => { setStatusError(''); void request<InitStatus>('/api/init/status').then(setStatus).catch((reason: Error) => setStatusError(reason.message)); }}>重新读取状态</button>
    </Question>;
    switch (stage) {
      case 'expectations': return <Question kicker="PHASE 1 · 期望" title="这个创作空间要服务什么样的内容？" hint="初始化按 Cheat on Content 的 Phase 0–5 写入状态、评分规则、模板与对标档案。现有作品、选题和预测会保留；不会导入其他工作区。">
        <div className="init-field-grid">
          <label>创作空间名称<input autoFocus value={name} maxLength={100} onChange={event => setName(event.target.value)} placeholder="例如：我的 AI 教学" /></label>
          <label>领域或内容方向<input value={domain} maxLength={300} onChange={event => setDomain(event.target.value)} placeholder="例如：AI 教育 · Agent 实践" /></label>
        </div>
        <div className={`init-detected ${status?.legacy ? 'amber' : ''}`}>
          <CircleHelp size={15} />
          <span>{status
            ? status.legacy
              ? `检测到旧版自动初始化（${formatMoment(status.initializedAt)}）：${status.works} 条作品、${status.topics} 个选题、${status.predictions} 份预测会保留。本次会补齐真实初始化标记、rubric 与项目档案。`
              : status.hasData
                ? `检测到 ${status.works} 条作品、${status.topics} 个选题、${status.predictions} 份预测；初始化不会清空这些记录。`
                : '当前空间还没有作品或选题，初始化会建立一套完整但为空的方法档案。'
            : '正在读取创作空间状态…'}</span>
        </div>
      </Question>;

      case 'form': return <Question kicker="Q1 · 内容形态" title="你主要做什么形态的内容？" hint="评分规则会按形态生成。混合形态先用观点视频的 starter 规则，再通过真实复盘校准。">
        <div className="init-choice-grid" role="radiogroup" aria-label="内容形态">
          {contentForms.map(form => <Choice key={form} selected={contentForm === form} title={contentFormLabels[form]} detail={formDetails[form]} onClick={() => setContentForm(form)} />)}
        </div>
      </Question>;

      case 'duration': return <Question kicker="Q1.5 · 时长" title="一条内容通常多长？" hint="用于默认创作节奏与预测上下文，不会限制你的实际时长。">
        <div className="init-choice-grid compact" role="radiogroup" aria-label="典型时长">
          {durationOptions.map(option => <Choice key={option} selected={duration === option} title={durationLabels[option]} onClick={() => setDuration(option)} />)}
        </div>
      </Question>;

      case 'cadence': return <Question kicker="Q1.6 · 频率" title="你希望以什么频率发布？" hint="工作台据此提示复盘窗口，不会自动发布。">
        <div className="init-choice-grid compact" role="radiogroup" aria-label="发布频率">
          {cadenceOptions.map(option => <Choice key={option} selected={cadence === option} title={cadenceLabels[option]} onClick={() => setCadence(option)} />)}
        </div>
      </Question>;

      case 'history': return <Question kicker="Q2 · 历史作品" title="要现在对齐已有抖音作品吗？" hint="通过 Edge 创作者中心读取公开页面数据。初始化本身不依赖同步成功；失败可以稍后重试。导入数量不会计入校准样本。">
        <div className="init-choice-grid" role="radiogroup" aria-label="历史对齐">
          <Choice selected={historyMode === 'import'} title="对齐已有作品" detail={`使用已配对的 Edge 扩展；当前空间已有 ${status?.works ?? 0} 条作品记录`} icon={<Monitor size={15} />} onClick={() => { setHistoryMode('import'); setDataCollection('adapter'); }} />
          <Choice selected={historyMode === 'skip'} title="暂不对齐" detail="稍后可从作品库或 Edge 设置中补充；初始化先写入方法档案" icon={<ArrowLeft size={15} />} onClick={() => setHistoryMode('skip')} />
        </div>
      </Question>;

      case 'platform': return <Question kicker="Q2.1 · 平台" title="历史作品来自哪个平台？" hint="目前只完整支持抖音创作者中心。其他平台暂不接入，不会读取 Cookie 或启动第二个浏览器。">
        <div className="init-choice-grid" role="radiogroup" aria-label="平台">
          <Choice selected title="抖音 · 创作者中心" detail="复用日常 Edge 登录；只读取创作者中心页面自身的作品响应" icon={<Monitor size={15} />} onClick={() => undefined} />
        </div>
      </Question>;

      case 'history-method': return <Question kicker="Q2.2 · 对齐方式" title="用哪种方式对齐？" hint="Edge 扩展只需配对一次；工作台重启后会自动重连同一账号。初始化完成后也可以再执行账号对齐。">
        <div className="init-choice-grid" role="radiogroup" aria-label="对齐方式">
          <Choice selected title="Edge 创作者中心" detail="真实作品标题、链接与指标；缺失指标保持未获取，不补零" icon={<Monitor size={15} />} onClick={() => undefined} />
        </div>
      </Question>;

      case 'history-count': return <Question kicker="Q2.3 · 数量" title="计划对齐最近多少条作品？" hint="建议 10–30 条。baseline 会取所有已取得播放的作品中位数；导入历史不等于校准。">
        <label className="init-number-field">历史作品数量<input autoFocus type="number" min="1" max="500" value={historyCount} onChange={event => setHistoryCount(event.target.value)} /><small>{status?.works ? `当前已检测到 ${status.works} 条作品` : '当前空间还没有作品记录'}</small></label>
      </Question>;

      case 'collection': return <Question kicker="Q3 · 数据回收" title="发布后的数据怎么回到工作台？" hint="两种方式可以并存；这里记录你的默认路径。复盘始终需要你确认数据采集窗口。">
        <div className="init-choice-grid" role="radiogroup" aria-label="数据回收">
          <Choice selected={dataCollection === 'adapter'} title="Edge 自动同步" detail="从创作者中心读取作品指标；缺失值保持未获取" icon={<Monitor size={15} />} onClick={() => setDataCollection('adapter')} />
          <Choice selected={dataCollection === 'manual'} title="手工录入" detail="在复盘对话框里录入实际播放、点赞、评论、转发、收藏" icon={<FileText size={15} />} onClick={() => setDataCollection('manual')} />
        </div>
      </Question>;

      case 'pool': return <Question kicker="Q4 · 候选池" title="你已经有候选选题池吗？" hint="工作台只记录偏好，不会自动读取 Notion 或外部文件夹。">
        <div className="init-choice-grid" role="radiogroup" aria-label="候选池">
          {(Object.keys(poolLabels) as Array<keyof typeof poolLabels>).map(pool => <Choice key={pool} selected={poolStatus === pool} title={poolLabels[pool]} onClick={() => setPoolStatus(pool)} />)}
        </div>
      </Question>;

      case 'hooks': return <Question kicker="Q5 · 不可变保护" title="要写入上游 hooks 文件吗？" hint="工作台自身始终强制预测 append-only。即使写入文件，Web 应用也无法验证外部 harness 是否触发，state 会保持 hooks_installed:false。">
        <div className="init-choice-grid" role="radiogroup" aria-label="hooks">
          <Choice selected={!hooks} title="不写入 hooks" detail="仅依赖工作台的强制追加与锁定" onClick={() => setHooks(false)} />
          <Choice selected={hooks} title="写入 .cheat-hooks 并合并 .claude/settings.json" detail="文件会写入，但触发状态未验证" icon={<ShieldCheck size={15} />} onClick={() => setHooks(true)} />
        </div>
      </Question>;

      case 'benchmark-mode': return <Question kicker="PHASE 2.5 · 对标" title="要导入一个对标账号吗？" hint="上游要求至少 3 条样本，推荐 5–10 条。样本只用于形成定性观察，不会自动修改 rubric_notes.md。">
        <div className="init-choice-grid" role="radiogroup" aria-label="对标方式">
          <Choice selected={benchmarkMode === 'imported'} title="导入账号与样本" detail="现在填写账号与至少 3 条作品，初始化后可运行对标分析" icon={<Sparkles size={15} />} onClick={() => setBenchmarkMode('imported')} />
          <Choice selected={benchmarkMode === 'pending'} title="先登记账号" detail="稍后补样本；在补齐前不能运行分析" icon={<Workflow size={15} />} onClick={() => setBenchmarkMode('pending')} />
          <Choice selected={benchmarkMode === 'none'} title="跳过对标" detail="之后仍可在方法与设置中补充" onClick={() => setBenchmarkMode('none')} />
        </div>
      </Question>;

      case 'benchmark-account': return <Question kicker="PHASE 2.5 · 对标账号" title="对标谁？" hint={benchmarkMode === 'imported' ? '账号名会写入 benchmark.md 与 samples/ 目录；样本必须来自公开可见的作品标题。' : '可以先登记账号名，稍后再补样本。'}>
        <div className="init-field-grid">
          <label>对标账号名<input autoFocus value={benchmarkName} maxLength={120} onChange={event => setBenchmarkName(event.target.value)} placeholder="例如：影视飓风" /></label>
          <label>风格 / 调性（可选）<input value={benchmarkStyle} maxLength={300} onChange={event => setBenchmarkStyle(event.target.value)} placeholder="例如：冷静、信息密度高、先抛结论" /></label>
        </div>
      </Question>;

      case 'benchmark-samples': return <Question kicker="PHASE 2.5 · 对标样本" title={`录入样本（${samples.length}/15）`} hint="至少 3 条。样本指标只写入原始档案，不进入盲评输入；对标分析只允许输出定性观察，不能写数字指标或百分比。">
        <div className="init-sample-list">
          {samples.map((sample, index) => <div className="init-sample" key={index}>
            <div className="init-sample-head"><span>样本 {String(index + 1).padStart(2, '0')}</span><button type="button" className="icon-button" aria-label={`删除样本 ${index + 1}`} onClick={() => setSamples(list => list.filter((_, position) => position !== index))}><Trash2 size={14} /></button></div>
            <label>视频标题<input value={sample.title} maxLength={200} onChange={event => updateSample(index, { title: event.target.value })} placeholder="从对标账号复制的原标题" /></label>
            <div className="init-sample-metrics">
              {metricFields.map(([field, label]) => <label key={field}>{label}<input type="number" min="0" value={sample[field] ?? ''} onChange={event => updateSample(index, { [field]: parseMetric(event.target.value) })} placeholder="未获取" /></label>)}
              <label>主观印象<select value={sample.impression} onChange={event => updateSample(index, { impression: event.target.value as InitSample['impression'] })}><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label>
            </div>
            <label>作品链接（可选）<input value={sample.url} maxLength={500} onChange={event => updateSample(index, { url: event.target.value })} placeholder="https://www.douyin.com/video/…" /></label>
            <details><summary>逐字稿（可选）</summary><textarea value={sample.transcript} maxLength={30_000} onChange={event => updateSample(index, { transcript: event.target.value })} placeholder="能拿到逐字稿时粘贴在这里；没有也可以分析标题与结构。" /></details>
          </div>)}
        </div>
        <button type="button" className="button small" disabled={samples.length >= 15} onClick={() => setSamples(list => [...list, blankSample()])}><Plus size={14} />添加样本</button>
      </Question>;

      case 'review': return <Question kicker="PHASE 4 · 检查" title="写入前确认这份初始化档案" hint="状态文件最后写入：任何前置文件失败，都不会留下“已初始化”的假状态。">
        <dl className="init-review">
          <div><dt>创作空间</dt><dd>{name.trim() || '未填写'}</dd></div>
          <div><dt>领域</dt><dd>{domain.trim() || '未填写'}</dd></div>
          <div><dt>内容形态</dt><dd>{contentFormLabels[contentForm]}{durationQuestionForms.includes(contentForm) ? ` · ${durationLabels[duration]}` : ''}{` · ${cadenceLabels[cadence]}`}</dd></div>
          <div><dt>历史对齐</dt><dd>{historyMode === 'import' ? `最近 ${historyCount} 条 · Edge 创作者中心` : '跳过，稍后可补'}</dd></div>
          <div><dt>数据回收</dt><dd>{dataCollection === 'adapter' ? 'Edge 自动同步' : '手工录入'}</dd></div>
          <div><dt>候选池</dt><dd>{poolLabels[poolStatus]}</dd></div>
          <div><dt>hooks</dt><dd>{hooks ? '写入文件（触发未验证，state 保持 false）' : '不写入'}</dd></div>
          <div><dt>对标</dt><dd>{benchmarkMode === 'imported' ? `${benchmarkName.trim()} · ${samples.length} 条样本` : benchmarkMode === 'pending' ? `${benchmarkName.trim() || '待补账号名'} · 稍后补样本` : '跳过'}</dd></div>
        </dl>
        <div className="init-file-preview">
          <strong>将写入</strong>
          <p>.gitignore 凭证规则 · rubric_notes.md（{contentForm === 'mixed' ? 'opinion-video' : contentForm}-zero）· rubric-memo.md · script_patterns.md · audience.md · WORKFLOW.md · STATUS.md{benchmarkMode !== 'none' ? ' · benchmark.md' : ''}{benchmarkMode === 'imported' ? ` · samples/ 下 ${samples.length} 条样本` : ''}{hooks ? ' · .cheat-hooks/ 与合并后的 .claude/settings.json' : ''}。</p>
        </div>
        <div className="init-preserved">
          <strong>将保留</strong>
          <p>{status ? `${status.works} 条作品 · ${status.topics} 个选题 · ${status.predictions} 份预测 · 已有校准样本（${status.calibrationSamples}）与 baseline` : '正在读取现有记录…'}。不会导入其他工作区的稿件或账号数据。</p>
        </div>
        {status?.legacy && <div className="init-detected amber"><CircleHelp size={15} /><span>这是旧版自动初始化。完成后会写入 <code>metadata.workbench.init.completedAt</code>，历史导入与校准样本仍分开计算。</span></div>}
        {status?.initialized && <label className="init-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我确认重新初始化：保留作品、选题与预测，但按本次答案重写配置与未校准的 starter rubric。</label>}
        {status && !status.initialized && status.hasData && <p className="init-footnote">本次不是重新初始化；现有数据会保留，只是补齐 Cheat 档案。</p>}
      </Question>;

      case 'running': {
        const terminal = Boolean(task && !activeStatuses.includes(task.status));
        const failed = terminal && task?.status !== 'completed';
        const lastEvent = task?.events.at(-1)?.message;
        return <Question kicker="PHASE 3 · 写入" title={failed ? '初始化没有完成' : '正在写入 Cheat 创作空间'} hint="目录、rubric、模板、对标样本与 hooks（如选择）会依次写入；状态文件最后落盘。">
          {!terminal && <div className="init-running"><Spinner /><div><strong>{task?.status === 'queued' ? '排队中…' : '正在执行…'}</strong><p>{lastEvent || '正在准备初始化任务…'}</p></div></div>}
          {failed && <div className="init-error-box" role="alert"><XCircle size={15} /><span>{task?.error || error || '初始化失败。'}</span></div>}
          {task && task.events.length > 0 && <ol className="init-event-log">{task.events.slice(-8).map((event, index) => <li key={index} className={event.level || ''}><time>{new Date(event.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><span>{event.message}</span></li>)}</ol>}
          {!terminal && <div className="init-inline-actions"><button type="button" className="text-button" onClick={() => void cancelInitialize()}>取消初始化</button></div>}
          {failed && <div className="init-inline-actions"><button type="button" className="button" onClick={() => { setError(''); setStage('review'); }}><ArrowLeft size={14} />返回检查</button><button type="button" className="button primary" onClick={() => void execute()}>重试写入</button></div>}
        </Question>;
      }

      case 'complete': {
        if (!report) return null;
        return <section className="init-complete">
          <div className="init-complete-head"><span className="init-complete-mark"><CheckCircle2 size={26} /></span><div><span className="init-kicker">CHEAT / INITIALIZED</span><h3>创作空间已写入</h3><p>{formatMoment(report.initializedAt)} · {contentFormLabels[report.contentForm]} · {report.confidence.label}</p></div></div>
          <div className="init-complete-grid">
            <div><span>保留数据</span><strong>{report.preservedData.works} 作品 / {report.preservedData.topics} 选题 / {report.preservedData.predictions} 预测</strong></div>
            <div><span>历史对齐</span><strong>{report.history.mode === 'import' ? `待对齐 ${report.history.requested ?? ''} 条` : '未启用'}</strong><small>导入不计入校准样本</small></div>
            <div><span>对标</span><strong>{report.benchmark.status === 'imported' ? `${report.benchmark.name} · ${report.benchmark.sampleCount} 条` : report.benchmark.status === 'pending' ? `${report.benchmark.name || '待补'} · 待补样本` : '未设置'}</strong></div>
          </div>
          <details open={report.created.length <= 8}><summary>新建 {report.created.length} 项</summary><ul className="init-report-list">{report.created.map(item => <li key={item}><Check size={12} />{item}</li>)}</ul></details>
          {report.preserved.length > 0 && <details><summary>保留 {report.preserved.length} 项</summary><ul className="init-report-list muted">{report.preserved.map(item => <li key={item}>{item}</li>)}</ul></details>}
          {report.skipped.length > 0 && <details><summary>跳过 {report.skipped.length} 项</summary><ul className="init-report-list muted">{report.skipped.map(item => <li key={item}>{item}</li>)}</ul></details>}
          {report.warnings.length > 0 && <div className="init-warning-box"><CircleHelp size={15} /><ul>{report.warnings.map(item => <li key={item}>{item}</li>)}</ul></div>}
          <div className="init-next"><strong>接下来</strong><ol>{report.nextSteps.map(item => <li key={item}>{item}</li>)}</ol></div>
          {report.history.mode === 'import' && <div className="init-followup">
            <div><strong>账号对齐</strong><p>{report.history.status === 'pending' ? 'Edge 已连接时同步最近作品；baseline 取所有有播放数据作品的中位数。' : '本次已完成历史写入。'}</p></div>
            <button type="button" className="button small" onClick={onAlignHistory}><Monitor size={14} />打开 Edge 账号对齐</button>
          </div>}
          {report.benchmark.status === 'imported' && report.benchmark.sampleCount >= 3 && <div className="init-followup">
            <div><strong>对标分析</strong><p>{analysis.status === 'done' ? analysis.detail : analysis.status === 'error' ? analysis.detail : '把样本中的结构、表达与可迁移信号提炼为定性观察，不写数字指标，不改 rubric_notes.md。'}</p></div>
            <button type="button" className="button small" disabled={analysis.status === 'running'} onClick={() => void runBenchmark()}>{analysis.status === 'running' ? <Spinner /> : <Sparkles size={14} />}{analysis.status === 'running' ? '分析中…' : analysis.status === 'done' ? '重新分析' : analysis.status === 'error' ? '重试分析' : '运行对标分析'}</button>
          </div>}
          {report.benchmark.status === 'pending' && <div className="init-followup"><div><strong>对标样本还没补齐</strong><p>补齐至少 3 条样本后，在方法与设置中运行对标分析。</p></div></div>}
        </section>;
      }
    }
  };

  const showFooter = !['running', 'complete'].includes(stage);
  return <div className="modal-backdrop init-backdrop" onMouseDown={close}>
    <div className="init-wizard" role="dialog" aria-modal="true" aria-labelledby="init-wizard-title" onMouseDown={event => event.stopPropagation()}>
      <header className="init-wizard-head">
        <div>
          <span className="modal-index">CHEAT / INITIALIZE</span>
          <h2 id="init-wizard-title">{stage === 'complete' ? '初始化完成' : status?.initialized ? '重新初始化创作空间' : '初始化创作空间'}</h2>
          <p>{stage === 'complete' ? '结果已写入本地文件；可以继续对齐账号或运行对标分析。' : '按上游 Cheat on Content 的 Phase 0–5 完成设置。作品、选题与预测会保留。'}</p>
        </div>
        <button type="button" className="icon-button" aria-label="关闭初始化" onClick={close}><X size={18} /></button>
      </header>
      {stage !== 'complete' && <nav className="init-progress" aria-label="初始化进度">
        {groups.map((group, index) => <span key={group.label} className={index < activeGroup ? 'done' : index === activeGroup ? 'active' : ''}>
          <i>{index < activeGroup ? <Check size={10} /> : String(index + 1).padStart(2, '0')}</i>{group.label}
        </span>)}
      </nav>}
      <div className="init-wizard-body">
        {error && <div className="init-error-box" role="alert"><XCircle size={15} /><span>{error}</span></div>}
        <div className="init-stage" key={stage}>{stageBody()}</div>
      </div>
      {showFooter && <footer className="init-wizard-foot">
        <button type="button" className="button" onClick={goBack} disabled={stage === 'expectations'}><ArrowLeft size={14} />上一步</button>
        <span className="init-step-label">{stageLabels[stage]}</span>
        <button type="button" className="button primary" onClick={goNext} disabled={!canNext}>{stage === 'review' ? '写入创作空间' : '继续'}<ArrowRight size={14} /></button>
      </footer>}
      {stage === 'complete' && <footer className="init-wizard-foot"><span className="init-step-label">已写入 · 可随时在方法与设置中重新初始化</span><button type="button" className="button primary" onClick={onClose}><Check size={14} />完成</button></footer>}
    </div>
  </div>;
}
