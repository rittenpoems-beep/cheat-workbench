import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ChatMessage, Draft, Metrics, Prediction, PredictionDetails, Review, Snapshot, Space, Topic, Work } from '../shared/types.js';
import { confidenceFor, localIso, renderBenchmarkMarkdown, renderSampleMeta, rubricFileFor, safeDirectoryName, sampleId, type ContentForm, type InitInput, type InitReport, type InitSample, type InitStatus } from '../shared/initialization.js';

type SnapshotData = Pick<Snapshot, 'project' | 'works' | 'drafts' | 'topics' | 'reviews' | 'predictions' | 'messages'>;
type Publication = { draftId: string; predictionId: string; url: string; publishedAt: string; platform?: string; platformId?: string; videoFolder?: string; adHocPublish?: boolean };
type RetroSchedule = { predictionId?: string; draftId?: string; dueAt?: string | null; [key: string]: unknown };
type InitMetadata = { completedAt: string; contentForm: ContentForm; historyPlatform?: 'douyin-creator-edge'; historyRequested?: number | null; historyImportStatus?: 'pending' | 'imported' | 'failed' | 'cancelled' | 'skipped'; historySamples?: number; historyBaselinePlays?: number | null; historyError?: string };
type Metadata = { name: string; domain?: string; setupCompletedAt?: string; topics: Topic[]; reviews: Review[]; messages: ChatMessage[]; publications: Publication[]; demoSeeded?: boolean; retroSchedule?: Record<string, RetroSchedule>; legacyPendingRetros?: unknown[]; directionRecorded?: string[]; init?: InitMetadata };
export interface RetroEligibility { published: boolean; publishedAt: string | null; dueAt: string | null; early: boolean }
export interface RetrospectiveOptions { earlyConfirmed?: boolean; measuredAt?: string; observations?: string[] }
type RetroRecord = { id?: string; createdAt: string; measuredAt?: string; actual?: Metrics; note?: string; calibrationEligible?: boolean; early_retro?: boolean; observations?: string[] };
type CheatState = Record<string, unknown> & { metadata?: { workbench?: Metadata; [key: string]: unknown } };
type Document = { attributes: Record<string, unknown>; body: string };
const METRIC_NAMES = ['plays', 'likes', 'comments', 'shares', 'collects'] as const;
const EMPTY_METRICS: Metrics = { plays: null, likes: null, comments: null, shares: null, collects: null };
const UPSTREAM_COMMIT = '5e8fb6ffb8a0f67f8456348ee08932c93e93abf5';
const contentFormValues = new Set(['opinion-video', 'long-essay', 'short-text', 'podcast', 'tutorial-builder', 'other', 'mixed']);
function contentFormOf(state: CheatState): ContentForm {
  const value = state.content_form;
  return typeof value === 'string' && contentFormValues.has(value) ? value as ContentForm : 'opinion-video';
}

export function draftHash(content: string): string { return createHash('sha256').update(content, 'utf8').digest('hex'); }
const now = () => new Date().toISOString();
const RETRO_WINDOW_MS = 3 * 86400_000;
const identifier = (prefix: string) => `${prefix}-${randomUUID().slice(0, 12)}`;
const safeId = (id: string) => /^[^<>:"/\\|?*\x00-\x1f.]{1,160}$/u.test(id) && id.trim() === id;
const safeText = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;
const titleLine = (value: string) => value.replace(/[\r\n]/g, ' ').trim();
const tableCell = (value: string) => titleLine(value).replace(/\|/g, '\\|');
const probabilityPercent = (value: number) => Number((value * 100).toFixed(2));
const jsonComment = (label: string, value: unknown) => `<!-- workbench-${label}:${JSON.stringify(value).replace(/-->/g, '\\u002d\\u002d>')} -->`;

/** JSON values form valid YAML scalars, while unknown upstream frontmatter is preserved. */
function parseDocument(text: string): Document {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { attributes: {}, body: normalized };
  const end = normalized.indexOf('\n---', 4);
  if (end < 0 || !/^(?:\n|$)/.test(normalized.slice(end + 4))) return { attributes: {}, body: normalized };
  const attributes: Record<string, unknown> = {};
  for (const line of normalized.slice(4, end).split('\n')) {
    const match = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!match) continue;
    try { attributes[match[1]] = JSON.parse(match[2]); }
    catch { attributes[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2'); }
  }
  return { attributes, body: normalized.slice(end + 4).replace(/^\n/, '') };
}
function document(attributes: Record<string, unknown>, body: string): string {
  return `---\n${Object.entries(attributes).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n${body}`;
}
function metricValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function metrics(value: unknown): Metrics {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return Object.fromEntries(METRIC_NAMES.map(key => [key, metricValue(source[key])])) as unknown as Metrics;
}
function markdownNumber(value: string | undefined): number | null {
  if (!value || /^(?:-|未知|未获取|null)$/i.test(value.trim())) return null;
  const match = value.replace(/,/g, '').match(/^\s*([\d.]+)\s*(w|万|亿)?/i);
  if (!match) return null;
  return metricValue(Number(match[1]) * (match[2] === '亿' ? 1e8 : match[2] ? 1e4 : 1));
}
function markdownField(text: string, label: string): string {
  const match = text.match(new RegExp(`(?:^|\\n)\\s*(?:-\\s*)?(?:\\*\\*)?${label}(?:\\*\\*)?\\s*[：:]\\s*(.*)`));
  return match?.[1]?.trim().replace(/^`|`$/g, '') || '';
}
function comments<T>(body: string, label: string): T[] {
  const results: T[] = [];
  for (const match of body.matchAll(new RegExp(`<!-- workbench-${label}:([\\s\\S]*?) -->`, 'g'))) {
    try { results.push(JSON.parse(match[1]) as T); } catch { /* ordinary text cannot become application state */ }
  }
  return results;
}

function checkedPredictionDetails(input: PredictionDetails): PredictionDetails {
  if (!Array.isArray(input.buckets) || input.buckets.length !== 5 || new Set(input.buckets.map(bucket => bucket.id)).size !== 5) throw new Error('预测必须包含五个不同的概率桶');
  if (input.buckets.some(bucket => !bucket.id || !bucket.label || !Number.isFinite(bucket.min) || bucket.min < 0 || (bucket.max !== null && (!Number.isFinite(bucket.max) || bucket.max <= bucket.min)) || !Number.isFinite(bucket.probability) || bucket.probability < 0 || bucket.probability > 1)) throw new Error('预测桶范围或概率无效');
  if (Math.abs(input.buckets.reduce((sum, bucket) => sum + bucket.probability, 0) - 1) > 0.00001) throw new Error('五桶概率合计必须为 100%（比例合计为 1）');
  const headline = input.buckets.find(bucket => bucket.id === input.headlineBucketId);
  if (!headline || !Number.isFinite(input.centralEstimate) || input.centralEstimate < headline.min || (headline.max !== null && input.centralEstimate > headline.max)) throw new Error('预测中枢必须位于主预测桶内');
  if (!Number.isFinite(input.composite) || input.composite < 0 || input.composite > 10 || (input.baselinePlays !== null && metricValue(input.baselinePlays) === null) || !Number.isInteger(input.calibrationSamples) || input.calibrationSamples < 0 || !input.confidence?.trim()) throw new Error('预测评分或置信度快照无效');
  if (!Array.isArray(input.factors) || !input.factors.length || input.factors.some(item => !item.factor?.trim() || !item.reason?.trim() || !['positive', 'negative', 'uncertain'].includes(item.direction) || !['high', 'medium', 'low'].includes(item.confidence))) throw new Error('预测必须包含具体推理因素');
  if (!Array.isArray(input.anchors) || input.anchors.some(item => !item.workId || !item.title?.trim() || !item.comparison?.trim()) || (!input.anchors.length && !input.anchorNote?.trim())) throw new Error('请提供锚点对比或说明锚点缺失的原因');
  if (!Array.isArray(input.counterfactuals) || input.counterfactuals.length !== 5 || new Set(input.counterfactuals.map(item => item.bucketId)).size !== 5 || input.counterfactuals.some(item => !input.buckets.some(bucket => bucket.id === item.bucketId) || !item.analysis?.trim())) throw new Error('五个概率桶都必须有具体反事实场景');
  if (!Array.isArray(input.assumptions) || !input.assumptions.length || input.assumptions.some(item => !item.trim())) throw new Error('预测必须记录待验证的校准假设');
  return JSON.parse(JSON.stringify(input)) as PredictionDetails;
}

/** The upstream Markdown workspace is authoritative; there is no shadow application database. */
export class Workspace {
  readonly root: string;
  readonly mode: Space;
  readonly upstreamRoot: string;
  private mutations: Promise<unknown> = Promise.resolve();

  constructor(root: string, mode: Space, upstreamRoot: string) {
    this.root = path.resolve(root);
    this.mode = mode;
    this.upstreamRoot = path.resolve(upstreamRoot);
    if (this.root === this.upstreamRoot || this.root === path.parse(this.root).root) throw new Error('工作空间必须使用独立目录');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    for (const directory of ['scripts', 'scripts/.versions', 'predictions', 'videos']) {
      await fs.mkdir(path.join(this.root, directory), { recursive: true });
      await this.checkedPath(directory);
    }
    try { await fs.access(path.join(this.root, '.cheat-state.json')); }
    catch {
      await this.writeState({
        schema_version: '1.4', skill_version: '1.0.0', rubric_version: 'v0', content_form: 'opinion-video',
        typical_duration_seconds: 90, target_publish_cadence_days: 2, rubric_form_mismatch: false,
        benchmark_status: 'none', benchmark_name: null, benchmark_sample_count: 0, baseline_plays: null,
        calibration_samples: 0, calibration_samples_at_last_bump: 0, data_collection: 'manual', pool_status: 'none',
        data_layer: 'markdown', hooks_installed: false, enabled_trend_sources: ['manual-paste'], enabled_perf_adapters: [],
        last_bump_at: null, last_bump_self_audited: false, last_published_at: null, last_published_file: null,
        last_retro_at: null, last_trends_run_at: null, last_trends_added_count: 0, last_prediction_self_scored: false,
        last_self_scored_at: null, consecutive_directional_errors: [], pending_retros: [], shoots: [],
        // Owner spaces become initialized only after the real Phase 0–5 flow completes.
        in_progress_session: null, initialized_at: this.mode === 'demo' ? now() : null, metadata: { workbench: this.defaultMetadata() },
      });
    }
    await this.migratePendingRetros();
    if (this.mode === 'demo') {
      await this.getRubric();
      if (!(await this.state()).metadata?.workbench?.demoSeeded) await this.seedDemo();
    }
  }

  private defaultMetadata(): Metadata {
    return { name: this.mode === 'demo' ? '示例创作者 · 演示空间' : '我的创作工作室', topics: [], reviews: [], messages: [], publications: [] };
  }
  private async state(): Promise<CheatState> {
    const filename = await this.checkedPath('.cheat-state.json');
    try { return JSON.parse(await fs.readFile(filename, 'utf8')) as CheatState; }
    catch (error) {
      const wrapped = new Error(`无法读取 .cheat-state.json，请保留文件并检查 JSON：${error instanceof Error ? error.message : '未知错误'}`) as NodeJS.ErrnoException;
      wrapped.code = (error as NodeJS.ErrnoException).code;
      throw wrapped;
    }
  }
  private metadata(state: CheatState): Metadata {
    return { ...this.defaultMetadata(), ...state.metadata?.workbench };
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(operation, operation);
    this.mutations = next.catch(() => undefined);
    return next;
  }
  private async writeState(state: CheatState): Promise<void> { await this.atomicWrite('.cheat-state.json', `${JSON.stringify(state, null, 2)}\n`); }
  private async updateMetadata(change: (metadata: Metadata, state: CheatState) => void): Promise<void> {
    const state = await this.state();
    const metadata = this.metadata(state);
    change(metadata, state);
    state.metadata = { ...state.metadata, workbench: metadata };
    await this.writeState(state);
  }

  /** Restore the upstream path[] contract; retain old objects verbatim for recovery. */
  private async migratePendingRetros(): Promise<void> {
    return this.serial(async () => {
      const state = await this.state();
      if (!Array.isArray(state.pending_retros) || !state.pending_retros.some(item => typeof item !== 'string')) return;
      const metadata = this.metadata(state);
      const paths: string[] = [];
      const legacy = [...(metadata.legacyPendingRetros || [])];
      const schedule = { ...metadata.retroSchedule };
      for (const item of state.pending_retros) {
        if (typeof item === 'string') { if (!paths.includes(item)) paths.push(item); continue; }
        legacy.push(item);
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const record = item as Record<string, unknown>;
          if (typeof record.file === 'string') {
            if (!paths.includes(record.file)) paths.push(record.file);
            schedule[record.file] = { ...record, ...schedule[record.file], ...(typeof record.prediction_id === 'string' ? { predictionId: record.prediction_id } : {}), ...(typeof record.draft_id === 'string' ? { draftId: record.draft_id } : {}), ...(typeof record.due_at === 'string' || record.due_at === null ? { dueAt: record.due_at } : {}) };
          }
        }
      }
      state.pending_retros = paths;
      metadata.legacyPendingRetros = legacy; metadata.retroSchedule = schedule;
      state.metadata = { ...state.metadata, workbench: metadata };
      await this.writeState(state);
    });
  }

  private publicationFor(prediction: Pick<Prediction, 'id' | 'draftId'>, state: CheatState, body: string): Publication | undefined {
    const stored = this.metadata(state).publications.find(item => item.predictionId === prediction.id);
    if (stored && Number.isFinite(Date.parse(stored.publishedAt))) return stored;
    const publishedAt = markdownField(body.split(/^## /m)[0], 'Published at');
    if (!publishedAt || !Number.isFinite(Date.parse(publishedAt))) return undefined;
    return { draftId: prediction.draftId, predictionId: prediction.id, publishedAt, url: markdownField(body, 'URL'), platform: markdownField(body, 'Platform'), platformId: markdownField(body, 'Aweme ID'), videoFolder: markdownField(body, 'Video Folder') };
  }

  /** Checks both lexical containment and every existing parent, including junctions. */
  private async checkedPath(relative: string): Promise<string> {
    if (!relative || path.isAbsolute(relative) || relative.includes('\0') || relative.includes(':')) throw new Error('无效的工作空间路径');
    const normalized = relative.replace(/\\/g, '/');
    if (normalized.split('/').some(part => part === '..' || part === '.' || !part)) throw new Error('不允许路径穿越');
    const target = path.resolve(this.root, normalized);
    const rootReal = await fs.realpath(this.root);
    const relativeRoot = path.relative(this.root, target);
    if (relativeRoot.startsWith('..') || path.isAbsolute(relativeRoot)) throw new Error('路径不在工作空间内');
    let current = this.root;
    for (const part of normalized.split('/')) {
      current = path.join(current, part);
      try {
        const actual = await fs.realpath(current);
        const fromRoot = path.relative(rootReal, actual);
        if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) throw new Error('禁止通过链接访问工作空间外文件');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
    }
    return target;
  }
  private async atomicWrite(relative: string, content: string, exclusive = false): Promise<void> {
    const target = await this.checkedPath(relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await this.checkedPath(relative);
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, content, { encoding: 'utf8', flag: 'wx' });
      // link provides atomic no-clobber creation; rename is atomic for mutable files.
      if (exclusive) await fs.link(temp, target);
      else await fs.rename(temp, target);
    }
    finally { await fs.unlink(temp).catch(() => undefined); }
  }

  async initializeProject(input: InitInput): Promise<InitReport> {
    return this.serial(async () => {
      const state = await this.state();
      const metadata = this.metadata(state);
      if (metadata.init?.completedAt && !input.confirmed) {
        throw Object.assign(new Error('这个创作空间已完成真实初始化。重新初始化会保留作品与选题，但会重写配置；请明确确认后继续。'), { status: 409, code: 'ALREADY_INITIALIZED' });
      }
      const completedAt = localIso();
      const initializedAt = metadata.init?.completedAt ? safeText(state.initialized_at, metadata.init.completedAt) : completedAt;
      const benchmark = input.benchmark.mode === 'imported'
        ? { status: 'imported' as const, name: input.benchmark.name, sampleCount: input.benchmark.samples.length }
        : input.benchmark.mode === 'pending'
          ? { status: 'pending' as const, name: input.benchmark.name || null, sampleCount: 0 }
          : { status: 'none' as const, name: null, sampleCount: 0 };
      const report: InitReport = {
        initializedAt, contentForm: input.contentForm, rubricFile: rubricFileFor(input.contentForm), confidence: confidenceFor(0),
        created: [], preserved: [], skipped: [], warnings: [], benchmark,
        history: { mode: input.historyMode, status: input.historyMode === 'import' ? 'pending' : 'skipped', platform: input.historyMode === 'import' ? 'douyin-creator-edge' : null, requested: input.historyMode === 'import' ? input.historyCount ?? null : null },
        preservedData: { works: 0, topics: metadata.topics.length, predictions: 0 }, nextSteps: [],
      };

      // Files that protect credentials come before any scaffold content.
      await this.scaffoldDirectories(report);
      await this.ensureGitignore(report);
      await this.scaffoldRubric(input.contentForm, state, report);
      for (const [template, relative] of [
        ['rubric-memo.template.md', 'rubric-memo.md'],
        ['script_patterns.template.md', 'script_patterns.md'],
        ['audience.template.md', 'audience.md'],
        ['workflow.template.md', 'WORKFLOW.md'],
        ['status.template.md', 'STATUS.md'],
      ] as const) await this.copyTemplateIfMissing(template, relative, report);
      await this.scaffoldBenchmark(input, report);
      await this.scaffoldHooks(input.hooks, report);

      // State is written last: no partial scaffold can ever look initialized.
      state.schema_version = '1.4';
      state.skill_version = '1.0.0';
      state.rubric_version = 'v0';
      state.content_form = input.contentForm;
      state.typical_duration_seconds = input.typicalDurationSeconds ?? 90;
      state.target_publish_cadence_days = input.cadenceDays ?? null;
      state.rubric_form_mismatch = input.contentForm !== 'opinion-video';
      state.benchmark_status = benchmark.status;
      state.benchmark_name = benchmark.name;
      state.benchmark_sample_count = benchmark.sampleCount;
      state.data_collection = input.dataCollection;
      state.pool_status = input.poolStatus;
      state.hooks_installed = false;
      state.enabled_trend_sources = ['manual-paste'];
      state.enabled_perf_adapters = [];
      state.initialized_at = initializedAt;
      metadata.name = input.name;
      metadata.domain = input.domain || '';
      metadata.setupCompletedAt = initializedAt;
      const previous = metadata.init;
      metadata.init = {
        completedAt,
        contentForm: input.contentForm,
        historyPlatform: input.historyMode === 'import' ? 'douyin-creator-edge' : previous?.historyPlatform,
        historyRequested: input.historyMode === 'import' ? input.historyCount ?? null : previous?.historyRequested ?? null,
        historyImportStatus: previous?.historyImportStatus === 'imported' ? 'imported' : input.historyMode === 'import' ? 'pending' : 'skipped',
        historySamples: previous?.historySamples ?? 0,
        historyBaselinePlays: previous?.historyBaselinePlays ?? metricValue(state.baseline_plays),
      };
      state.metadata = { ...state.metadata, workbench: metadata };
      await this.writeState(state);

      const [works, predictions] = await Promise.all([this.works(), this.predictions()]);
      report.preservedData = { works: works.length, topics: metadata.topics.length, predictions: predictions.length };
      report.confidence = confidenceFor(Number(state.calibration_samples) || 0);
      report.nextSteps = [
        '写一篇稿子 → 让 CodeBuddy 主 agent 改写，再做独立盲评打分',
        '评分通过 → 生成事前预测并锁定稿件快照',
        '发布后登记链接，T+3 用真实评论与数据复盘',
        ...(input.historyMode === 'import' ? ['Edge 扩展连接后执行历史对齐；baseline 会取所有作品播放中位数，导入数量不计入校准样本。'] : []),
        ...(benchmark.status === 'imported' ? [`对标样本已落盘，可运行「对标分析」生成定性观察。`] : benchmark.status === 'pending' ? ['补至少 3 条对标样本后，再运行对标分析。'] : []),
        ...(input.poolStatus === 'none' ? ['还没有候选池：可用热点任务补充选题，或手动维护 Markdown 列表。'] : []),
      ];
      return report;
    });
  }

  private async scaffoldDirectories(report: InitReport): Promise<void> {
    for (const directory of ['scripts', 'scripts/.versions', 'predictions', 'videos', 'samples']) {
      await fs.mkdir(await this.checkedPath(directory), { recursive: true });
      await this.checkedPath(directory);
    }
    for (const directory of ['scripts', 'predictions', 'videos', 'samples']) {
      const relative = `${directory}/.gitkeep`;
      try { await this.atomicWrite(relative, '', true); report.created.push(relative); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
  }

  private async ensureGitignore(report: InitReport): Promise<void> {
    const required = ['.auth/', '.auth-xhs/', '.auth-linkedin/', '.auth-wechat-channels/', '.cheat-secrets.json'];
    const target = await this.checkedPath('.gitignore');
    let current = '';
    try { current = await fs.readFile(target, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!current) {
      await this.atomicWrite('.gitignore', await fs.readFile(path.join(this.upstreamRoot, 'templates/gitignore.template'), 'utf8'), true);
      report.created.push('.gitignore（凭证保护模板）');
      return;
    }
    const lines = new Set(current.split(/\r?\n/).map(line => line.trim()));
    const missing = required.filter(line => !lines.has(line));
    if (!missing.length) { report.preserved.push('.gitignore'); return; }
    const separator = current.endsWith('\n') ? '' : '\n';
    await this.atomicWrite('.gitignore', `${current}${separator}\n# cheat-init：凭证与登录态不得提交\n${missing.join('\n')}\n`);
    report.created.push(`.gitignore（追加 ${missing.length} 条凭证规则）`);
  }

  private async scaffoldRubric(form: ContentForm, state: CheatState, report: InitReport): Promise<void> {
    const file = rubricFileFor(form);
    const starter = await fs.readFile(path.join(this.upstreamRoot, 'starter-rubrics', file), 'utf8');
    const target = await this.checkedPath('rubric_notes.md');
    let existing: string | undefined;
    try { existing = await fs.readFile(target, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (existing === undefined) {
      await this.atomicWrite('rubric_notes.md', starter, true);
      report.created.push(`rubric_notes.md（${file}）`);
      return;
    }
    if (existing === starter) { report.preserved.push('rubric_notes.md'); return; }
    const starterDirectory = path.join(this.upstreamRoot, 'starter-rubrics');
    let pristine = false;
    for (const name of (await fs.readdir(starterDirectory)).filter(name => name.endsWith('-zero.md'))) {
      if (existing === await fs.readFile(path.join(starterDirectory, name), 'utf8')) { pristine = true; break; }
    }
    if (pristine && (Number(state.calibration_samples) || 0) === 0) {
      await this.atomicWrite('rubric_notes.md', starter);
      report.created.push(`rubric_notes.md（从 starter 切换为 ${file}）`);
      report.warnings.push('原 rubric_notes.md 仍是未校准的 v0 starter，已按新的内容形态替换。');
    } else report.preserved.push('rubric_notes.md');
  }

  private async copyTemplateIfMissing(template: string, relative: string, report: InitReport): Promise<void> {
    const target = await this.checkedPath(relative);
    try { await fs.access(target); report.preserved.push(relative); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await this.atomicWrite(relative, await fs.readFile(path.join(this.upstreamRoot, 'templates', template), 'utf8'), true);
    report.created.push(relative);
  }

  private async scaffoldBenchmark(input: InitInput, report: InitReport): Promise<void> {
    if (input.benchmark.mode === 'none') {
      report.skipped.push('benchmark.md（未选择对标账号）');
      return;
    }
    const target = await this.checkedPath('benchmark.md');
    let exists = true;
    try { await fs.access(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; exists = false; }
    if (exists) { report.preserved.push('benchmark.md'); return; }
    if (input.benchmark.mode === 'pending') {
      const name = input.benchmark.name || '待补充';
      const template = (await fs.readFile(path.join(this.upstreamRoot, 'templates/benchmark.template.md'), 'utf8'))
        .split('[BENCHMARK-NAME]').join(name).split('[对标账号名]').join(name);
      await this.atomicWrite('benchmark.md', template, true);
      report.created.push('benchmark.md（待导入样本）');
      return;
    }
    const importedAt = localIso().slice(0, 10);
    await this.atomicWrite('benchmark.md', renderBenchmarkMarkdown({ name: input.benchmark.name, platform: input.benchmark.platform, style: input.benchmark.style, importedAt, samples: input.benchmark.samples }), true);
    report.created.push(`benchmark.md（原始样本表，${input.benchmark.samples.length} 条）`);
    const account = safeDirectoryName(input.benchmark.name);
    for (const [index, sample] of input.benchmark.samples.entries()) {
      const base = `samples/${account}/${sampleId(sample)}`;
      try {
        await this.atomicWrite(`${base}/meta.md`, renderSampleMeta({ account: input.benchmark.name, sample, index, importedAt }), true);
        report.created.push(`${base}/meta.md`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') report.preserved.push(`${base}/meta.md`); else throw error; }
      if (!sample.transcript.trim()) continue;
      try {
        await this.atomicWrite(`${base}/transcript.md`, `# ${sample.title} · transcript\n\n${sample.transcript.trim()}\n`, true);
        report.created.push(`${base}/transcript.md`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') report.preserved.push(`${base}/transcript.md`); else throw error; }
    }
  }

  private async scaffoldHooks(enabled: boolean, report: InitReport): Promise<void> {
    if (!enabled) {
      report.skipped.push('hooks（未写入；工作台自身仍强制预测 append-only）');
      return;
    }
    const source = path.join(this.upstreamRoot, 'hooks');
    for (const script of ['prediction-immutability.sh', 'session-start.sh', 'log-event.sh']) {
      try {
        await this.atomicWrite(`.cheat-hooks/${script}`, await fs.readFile(path.join(source, script), 'utf8'), true);
        report.created.push(`.cheat-hooks/${script}`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') report.preserved.push(`.cheat-hooks/${script}`); else throw error; }
    }
    const target = await this.checkedPath('.claude/settings.json');
    let settings: Record<string, any> = {};
    try { settings = JSON.parse(await fs.readFile(target, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        report.warnings.push('现有 .claude/settings.json 不是有效 JSON，未合并 hooks；文件保持原样。');
        report.warnings.push('hooks 文件已写入，但本工作台无法验证外部 harness 触发；state 保持 hooks_installed:false。');
        return;
      }
    }
    const hooks: Record<string, any[]> = { ...(settings.hooks || {}) };
    for (const name of ['prediction-immutability.json', 'session-start.json', 'meta-logging.json']) {
      const template = JSON.parse(await fs.readFile(path.join(source, name), 'utf8')) as { hooks?: Record<string, any[]> };
      for (const [event, matchers] of Object.entries(template.hooks || {})) {
        hooks[event] = Array.isArray(hooks[event]) ? hooks[event] : [];
        for (const matcher of matchers) {
          const existing = hooks[event].find(item => item?.matcher === matcher.matcher);
          if (!existing) hooks[event].push(structuredClone(matcher));
          else {
            existing.hooks = Array.isArray(existing.hooks) ? existing.hooks : [];
            for (const hook of matcher.hooks || []) if (!existing.hooks.some((item: any) => item?.command === hook.command)) existing.hooks.push(structuredClone(hook));
          }
        }
      }
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await this.atomicWrite('.claude/settings.json', `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`);
    report.created.push('.claude/settings.json（合并 hooks）');
    report.warnings.push('hooks 文件已写入，但本工作台无法验证外部 harness 触发；state 保持 hooks_installed:false。');
  }

  async initStatus(): Promise<InitStatus> {
    await this.mutations;
    const empty: InitStatus = { hasState: false, initialized: false, bootstrapped: false, legacy: false, initializedAt: null, hasData: false, works: 0, topics: 0, predictions: 0, contentForm: 'opinion-video', calibrationSamples: 0, benchmarkStatus: 'none', historySamples: 0, historyImportStatus: null, rubricFormMismatch: false };
    let state: CheatState;
    try { state = await this.state(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty; throw error; }
    const metadata = this.metadata(state);
    const [works, predictions] = await Promise.all([this.works(), this.predictions()]);
    const initialized = Boolean(metadata.init?.completedAt);
    const benchmarkStatus = state.benchmark_status === 'imported' || state.benchmark_status === 'pending' ? state.benchmark_status : 'none';
    return {
      hasState: true, initialized, bootstrapped: !initialized, legacy: !initialized && Boolean(state.initialized_at),
      initializedAt: metadata.init?.completedAt || (typeof state.initialized_at === 'string' ? state.initialized_at : null),
      hasData: works.length > 0 || metadata.topics.length > 0 || predictions.length > 0,
      works: works.length, topics: metadata.topics.length, predictions: predictions.length,
      contentForm: contentFormOf(state), calibrationSamples: Number(state.calibration_samples) || 0,
      benchmarkStatus, historySamples: Number(metadata.init?.historySamples) || 0,
      historyImportStatus: metadata.init?.historyImportStatus || null, rubricFormMismatch: state.rubric_form_mismatch === true,
    };
  }

  async recordHistoryImport(input: { status: 'imported' | 'failed' | 'cancelled' | 'skipped'; count: number; baselinePlays: number | null; error?: string }): Promise<void> {
    return this.serial(async () => {
      const state = await this.state();
      const metadata = this.metadata(state);
      const previous = metadata.init;
      metadata.init = {
        completedAt: previous?.completedAt || localIso(),
        contentForm: previous?.contentForm || contentFormOf(state),
        historyPlatform: 'douyin-creator-edge',
        historyRequested: previous?.historyRequested ?? null,
        historyImportStatus: input.status,
        historySamples: input.status === 'imported' ? input.count : previous?.historySamples ?? 0,
        historyBaselinePlays: input.baselinePlays ?? previous?.historyBaselinePlays ?? null,
        ...(input.error ? { historyError: input.error.slice(0, 300) } : {}),
      };
      if (input.baselinePlays !== null) state.baseline_plays = input.baselinePlays;
      state.metadata = { ...state.metadata, workbench: metadata };
      await this.writeState(state);
    });
  }

  async recordBenchmark(input: { status: 'imported' | 'pending' | 'none'; name: string | null; sampleCount: number }): Promise<void> {
    return this.serial(async () => {
      const state = await this.state();
      state.benchmark_status = input.status;
      state.benchmark_name = input.name;
      state.benchmark_sample_count = input.sampleCount;
      await this.writeState(state);
    });
  }

  async benchmarkSamples(): Promise<{ name: string; samples: { title: string; meta: string; transcript: string }[] }> {
    const state = await this.state();
    const name = typeof state.benchmark_name === 'string' ? state.benchmark_name : '';
    if (!name) return { name: '', samples: [] };
    const account = safeDirectoryName(name);
    const directory = await this.checkedPath(`samples/${account}`);
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { name, samples: [] }; throw error; }
    const samples: { title: string; meta: string; transcript: string }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const meta = await fs.readFile(await this.checkedPath(`samples/${account}/${entry.name}/meta.md`), 'utf8');
        let transcript = '';
        try { transcript = await fs.readFile(await this.checkedPath(`samples/${account}/${entry.name}/transcript.md`), 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        samples.push({ title: meta.match(/^#\s+(.+)/m)?.[1]?.trim() || entry.name, meta: meta.slice(0, 20_000), transcript: transcript.slice(0, 30_000) });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return { name, samples: samples.slice(0, 15) };
  }

  /** Benchmark analysis may only add qualitative sections; rubric_notes.md is never touched. */
  async recordBenchmarkAnalysis(input: { name: string; sampleCount: number; analyzedAt: string; benchmark: string; patterns: string; observations: string[] }): Promise<void> {
    return this.serial(async () => {
      await this.replaceManagedSection('benchmark.md', 'benchmark-analysis', input.benchmark);
      await this.replaceManagedSection('script_patterns.md', 'benchmark-patterns', input.patterns);
      await this.replaceManagedSection('rubric-memo.md', 'benchmark-observations', `### 对标观察 ${input.analyzedAt.slice(0, 10)}（未校准）\n\n${input.observations.map(item => `- ${item.replace(/\n/g, '\n  ')}`).join('\n')}`);
      const state = await this.state();
      state.benchmark_status = 'imported';
      state.benchmark_name = input.name;
      state.benchmark_sample_count = input.sampleCount;
      await this.writeState(state);
    });
  }

  private async replaceManagedSection(relative: string, label: string, body: string): Promise<void> {
    const target = await this.checkedPath(relative);
    let current = '';
    try { current = await fs.readFile(target, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; current = `# ${path.basename(relative, '.md')}\n`; }
    const start = `<!-- workbench-${label}:start -->`;
    const end = `<!-- workbench-${label}:end -->`;
    const block = `${start}\n${body.trim()}\n${end}`;
    const from = current.indexOf(start), to = current.indexOf(end);
    const next = from >= 0 && to > from ? `${current.slice(0, from)}${block}${current.slice(to + end.length)}` : `${current.trimEnd()}\n\n${block}\n`;
    await this.atomicWrite(relative, next.endsWith('\n') ? next : `${next}\n`);
  }

  async getRubric(): Promise<string> {
    const local = await this.checkedPath('rubric_notes.md');
    try { return await fs.readFile(local, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (this.mode === 'owner') {
      const state = await this.state();
      if (!this.metadata(state).init?.completedAt) throw Object.assign(new Error('请先完成 Cheat 初始化，再读取评分规则。'), { status: 409, code: 'NOT_INITIALIZED' });
    }
    return this.ensureRubric();
  }

  /** Internal reads (e.g. frozen rubric hash) may still use the starter before the wizard runs. */
  private async ensureRubric(): Promise<string> {
    const local = await this.checkedPath('rubric_notes.md');
    try { return await fs.readFile(local, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const rubric = await fs.readFile(path.join(this.upstreamRoot, 'starter-rubrics', rubricFileFor(await this.contentForm())), 'utf8');
    try { await this.atomicWrite('rubric_notes.md', rubric, true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return fs.readFile(local, 'utf8');
  }

  private async contentForm(): Promise<ContentForm> {
    try { return contentFormOf(await this.state()); }
    catch { return 'opinion-video'; }
  }

  async saveDraft(input: { id?: string; title: string; content?: string }): Promise<Draft> {
    return this.serial(async () => {
      const id = input.id || identifier('draft');
      if (!safeId(id)) throw new Error('无效的稿件 ID');
      const existing = input.id ? await this.getDraft(id).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error.message === '稿件不存在') return null;
        throw error;
      }) : null;
      const title = titleLine(input.title || existing?.title || '未命名稿件');
      const content = input.content ?? existing?.content ?? '';
      if (title.length > 300 || content.length > 200_000) throw new Error('稿件超出长度限制');
      const version = existing ? existing.version + (content !== existing.content || title !== existing.title ? 1 : 0) : 1;
      if (existing && version === existing.version) return existing;
      const updatedAt = now();
      const relative = existing?.path || `scripts/${id}.md`;
      const serialized = document({ workbench_kind: 'draft', id, title, version, updated_at: updatedAt, content_hash: draftHash(content), sample: this.mode === 'demo' }, content);
      await this.atomicWrite(`scripts/.versions/${id}/v${version}-${draftHash(content).slice(0, 12)}.md`, serialized, true);
      await this.atomicWrite(relative, serialized);
      return { id, title, content, path: relative, updatedAt, version, stage: 'draft' };
    });
  }

  private async drafts(): Promise<Draft[]> {
    const entries = await fs.readdir(await this.checkedPath('scripts'), { withFileTypes: true });
    const drafts: Draft[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const relative = `scripts/${entry.name}`;
      const file = await this.checkedPath(relative);
      const parsed = parseDocument(await fs.readFile(file, 'utf8'));
      const stat = await fs.stat(file);
      const id = safeText(parsed.attributes.id, path.basename(entry.name, '.md'));
      drafts.push({ id, title: safeText(parsed.attributes.title, parsed.body.match(/^#\s+(.+)/m)?.[1] || id),
        content: parsed.body, path: relative, version: Number(parsed.attributes.version) || 1,
        updatedAt: safeText(parsed.attributes.updated_at, stat.mtime.toISOString()), stage: 'draft' });
    }
    return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getDraft(id: string): Promise<Draft> {
    if (!safeId(id)) throw new Error('无效的稿件 ID');
    const draft = (await this.drafts()).find(item => item.id === id);
    if (!draft) throw new Error('稿件不存在');
    return draft;
  }

  async setTopics(topics: Topic[]): Promise<void> {
    return this.serial(async () => this.updateMetadata((metadata, state) => {
      metadata.topics = topics.map(topic => ({ ...topic }));
      state.last_trends_run_at = now(); state.last_trends_added_count = topics.length;
    }));
  }

  async saveReview(review: Review): Promise<Review> {
    return this.serial(async () => {
      const draft = await this.getDraft(review.draftId);
      if (draft.version !== review.version || draftHash(draft.content) !== review.hash) throw new Error('稿件已变化，请对当前版本重新评审');
      if (!review.id || !review.blind) throw new Error('正式评审必须来自独立盲评请求');
      if (!Array.isArray(review.dimensions) || !review.dimensions.length || review.dimensions.some(item => !Number.isFinite(item.score) || !Number.isFinite(item.max) || item.max <= 0 || item.score < 0 || item.score > item.max || (item.quote && !draft.content.includes(item.quote)))) throw new Error('评审分数或原文引用无效');
      await this.updateMetadata(metadata => {
        if (metadata.reviews.some(item => item.id === review.id)) throw new Error('已有评审不可覆盖');
        metadata.reviews.push(review);
      });
      return review;
    });
  }

  async createPrediction(draftId: string, review: Review, forecast: string, rationale: string, inputDetails?: PredictionDetails): Promise<Prediction> {
    return this.serial(async () => {
      const draft = await this.getDraft(draftId);
      const hash = draftHash(draft.content);
      const state = await this.state();
      if (this.metadata(state).publications.some(item => item.draftId === draftId)) throw new Error('稿件已登记发布，不能再写事前盲预测；请使用复盘或创建新稿件');
      const storedReview = this.metadata(state).reviews.find(item => item.id === review.id);
      if (!storedReview || !storedReview.blind || storedReview.draftId !== draftId || storedReview.version !== draft.version || storedReview.hash !== hash) throw new Error('请先完成当前稿件版本的独立评审');
      const details = inputDetails ? checkedPredictionDetails(inputDetails) : undefined;
      const all = await this.predictions();
      const version = all.filter(item => item.draftId === draftId).reduce((max, item) => Math.max(max, item.version), 0) + 1;
      const id = identifier('prediction');
      const createdAt = now();
      const relative = `predictions/${createdAt.slice(0, 10)}_${id}.md`;
      const frozenPath = `scripts/.versions/${draftId}/prediction-${id}.md`;
      await this.atomicWrite(frozenPath, document({ id: draftId, title: draft.title, version: draft.version, content_hash: hash, frozen_for_prediction: id }, draft.content), true);
      const prediction: Prediction = { id, draftId, title: draft.title, createdAt, hash, version, path: relative, forecast, rationale, status: 'pending', reviewId: storedReview.id, ...(details ? { details } : {}) };
      const dimensions = storedReview.dimensions.map(item => `| ${tableCell(item.name)} | ${item.score}/${item.max} | ${tableCell(item.reason)} |`).join('\n');
      const disagreements = storedReview.dimensions.map(item => ({ dim: item.name.match(/^[A-Z]+/)?.[0] || item.name, blind: item.score, self: null, delta: null, decided_as: item.score }));
      const calibrationSamples = details?.calibrationSamples ?? (Number(state.calibration_samples) || 0);
      const composite = details?.composite ?? storedReview.dimensions.reduce((sum, item) => sum + item.score / item.max, 0) / storedReview.dimensions.length * 10;
      const confidence = details?.confidence || (calibrationSamples < 5 ? '极低；冷启动，仅记录判断，不代表可靠流量预测' : '待个人样本持续校准');
      const headline = details?.buckets.find(bucket => bucket.id === details.headlineBucketId);
      const bucketSection = details && headline
        ? `**Bucket**: \`${headline.label}\`\n\n**中枢**: ${details.centralEstimate} 播放\n**历史基线**: ${details.baselinePlays ?? '暂无'}\n\n**内心概率分布**（五桶合计 100%）:\n${details.buckets.map(bucket => `- ${bucket.id === headline.id ? '**' : ''}\`${bucket.label}\` → ${probabilityPercent(bucket.probability)}%${bucket.id === headline.id ? '**（主预测桶）' : ''}；范围 ${bucket.min} 至 ${bucket.max === null ? '无上限' : bucket.max} 播放`).join('\n')}`
        : '**结构化预测**: 兼容记录，未提供五桶概率与中枢；不将缺失值补成预测结果。';
      const direction = { positive: '+ 正向', negative: '- 负向', uncertain: '? 不确定' };
      const confidenceLabel = { high: '高', medium: '中', low: '低' };
      const factorSection = details
        ? `| 因素 | 方向 | 置信度 | 说明 |\n|---|---|---|---|\n${details.factors.map(item => `| ${tableCell(item.factor)} | ${direction[item.direction]} | ${confidenceLabel[item.confidence]} | ${tableCell(item.reason)} |`).join('\n')}`
        : `${storedReview.summary}\n\n（兼容记录未提供结构化因素表。）`;
      const works = details?.anchors.length ? await this.works() : [];
      const anchorSection = details?.anchors.length
        ? `| 对照样本 | 作品 ID | 预测时取得的实绩播放 | 异同 |\n|---|---|---|---|\n${details.anchors.map(anchor => { const work = works.find(item => item.id === anchor.workId); return `| ${tableCell(anchor.title)} | ${tableCell(anchor.workId)} | ${work?.metrics.plays ?? '未获取'} | ${tableCell(anchor.comparison)} |`; }).join('\n')}${details.anchorNote ? `\n\n${details.anchorNote}` : ''}`
        : details?.anchorNote || `锚点对比 N/A：个人校准样本 ${calibrationSamples} 个，兼容记录未提供可核对的锚点列表。`;
      const counterfactualSection = details
        ? details.buckets.map(bucket => `### 如果落在 ${titleLine(bucket.label)}（${probabilityPercent(bucket.probability)}% 预期）\n\n${details.counterfactuals.find(item => item.bucketId === bucket.id)!.analysis}`).join('\n\n')
        : '兼容记录未提供逐桶反事实场景，不补写未经确认的假设。';
      const assumptionsSection = details ? details.assumptions.map((assumption, index) => `${index + 1}. ${assumption}`).join('\n') : rationale;
      const body = [
        `# ${titleLine(draft.title)} — 预测日志${this.mode === 'demo' ? '（虚构演示样例）' : ''}`,
        `**Article ID**: \`${draftId}\`\n**Title**: ${titleLine(draft.title)}\n**Rubric Version**: \`${state.rubric_version || 'v0'}\`\n**预测时间**: ${createdAt}\n**Script Path**: \`${frozenPath}\`\n**Script Hash**: \`sha256:${hash}\`\n**Target Duration (s)**: ${state.typical_duration_seconds || 90}\n**Actual Script Length**: ${draft.content.length}\n**Calibration Samples (at predict time)**: ${calibrationSamples}\n**Confidence**: ${titleLine(confidence)}\n**Prediction Basis**: pre_shoot\n**Scored By**: independent-review:${storedReview.provider}（维度分来源；主对话未自评分）\n**BlindScored By**: independent-request:${storedReview.provider}\n**BlindScore Disagreement**: ${JSON.stringify(disagreements)}\n**User Override**: none（未覆盖盲评分；确认锁定不等于自评分）\n**预测时数据状态**: blind（新稿未发布）`,
        `## 输入快照\n\n稿件版本：${draft.version}；冻结稿：\`${frozenPath}\`。\n\n**分数**: ${storedReview.dimensions.map(item => `${titleLine(item.name)}=${item.score}`).join(' / ')} → composite=**${composite.toFixed(2)}**\n\n主对话未另行自评分，self/delta 为 null，不表示差异为零。\n\n| 维度 | 分数 | 依据 |\n|---|---|---|\n${dimensions}`,
        `## 预测 v${version}\n\n> 本段锁定，不可覆盖；重新预测将创建新文件。\n\n${bucketSection}\n\n${forecast}\n\n**一句话 reason**: ${rationale}`,
        `## 推理因素\n\n${factorSection}`,
        `## 锚点对比\n\n${anchorSection}`,
        `## 反事实场景（复盘用）\n\n${counterfactualSection}`,
        `## 关键校准假设\n\n${assumptionsSection}`,
        '## 复盘\n\n（待发布并取得实际数据后追加；以下允许追加，前文不可改。）\n',
      ].join('\n\n');
      await this.atomicWrite(relative, document({ workbench_kind: 'prediction', ...prediction, draft_version: draft.version, snapshot_path: frozenPath, rubric_hash: draftHash(await this.ensureRubric()), sample: this.mode === 'demo' }, body), true);
      await this.updateMetadata((metadata, updated) => {
        updated.last_prediction_self_scored = false;
        updated.in_progress_session = null;
        // Upstream pending_retros contains published work only. An unconfirmed
        // publication is not due for retrospective merely because it was predicted.
      });
      return prediction;
    });
  }

  private async predictions(): Promise<Prediction[]> {
    const state = await this.state();
    const entries = await fs.readdir(await this.checkedPath('predictions'), { withFileTypes: true });
    const results: Prediction[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const relative = `predictions/${entry.name}`;
      const file = await this.checkedPath(relative);
      const parsed = parseDocument(await fs.readFile(file, 'utf8'));
      const attributes = parsed.attributes;
      const stat = await fs.stat(file);
      const id = safeText(attributes.id, path.basename(entry.name, '.md'));
      const legacyPath = markdownField(parsed.body, 'Script Path');
      const actualRecords = comments<RetroRecord>(parsed.body, 'retro');
      const actual = [...actualRecords].reverse().find(record => record.actual)?.actual;
      const hasLegacyRetro = /(?:actual_plays|实际播放|\*\*复盘时间\*\*)/.test(parsed.body.split(/^## 复盘\s*$/m)[1] || '');
      const predicted = parsed.body.match(/^## 预测[^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]?.trim() || '';
      const draftId = safeText(attributes.draftId, markdownField(parsed.body, 'Article ID') || path.basename(legacyPath, '.md'));
      const publication = this.publicationFor({ id, draftId }, state, parsed.body);
      const dueAt = publication ? new Date(Date.parse(publication.publishedAt) + RETRO_WINDOW_MS).toISOString() : undefined;
      const matureRetro = actualRecords.some(record => record.early_retro !== true && dueAt && Date.parse(record.measuredAt || record.createdAt) >= Date.parse(dueAt) && metricValue(record.actual?.plays) !== null);
      results.push({ id, draftId,
        title: safeText(attributes.title, markdownField(parsed.body, 'Title') || parsed.body.match(/^#\s+(.+?)(?: —|$)/m)?.[1] || id),
        createdAt: safeText(attributes.createdAt, markdownField(parsed.body, '预测时间') || stat.birthtime.toISOString()),
        hash: safeText(attributes.hash, markdownField(parsed.body, 'Script Hash').replace(/^sha256:/, '')),
        version: Number(attributes.version) || 1, path: relative,
        forecast: safeText(attributes.forecast, predicted), rationale: safeText(attributes.rationale, markdownField(parsed.body, '一句话 reason')),
        status: matureRetro || (!actualRecords.length && hasLegacyRetro) ? 'retrospected' : publication ? 'published' : 'pending',
        ...(publication ? { publishedAt: publication.publishedAt, dueAt } : {}),
        ...(actualRecords.length ? { earlyRetro: actualRecords[actualRecords.length - 1].early_retro === true } : {}),
        ...(actual ? { actual: metrics(actual) } : {}), ...(typeof attributes.reviewId === 'string' ? { reviewId: attributes.reviewId } : {}),
        ...(attributes.details && typeof attributes.details === 'object' ? { details: attributes.details as PredictionDetails } : {}) });
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.version - a.version);
  }

  async publish(draftId: string, url: string, publishedAt = now()): Promise<Prediction> {
    return this.serial(async () => {
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new Error('请填写有效的作品链接'); }
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('只支持公开 HTTP(S) 作品链接');
      if (Number.isNaN(Date.parse(publishedAt))) throw new Error('发布时间无效');
      if (Date.parse(publishedAt) > Date.now()) throw new Error('发布时间不能晚于当前时间');
      publishedAt = new Date(Date.parse(publishedAt)).toISOString();
      const draft = await this.getDraft(draftId);
      const prediction = (await this.predictions()).find(item => item.draftId === draftId && item.hash === draftHash(draft.content));
      if (!prediction) throw new Error('请先为当前稿件版本生成正式预测，再登记发布');
      if (!Number.isFinite(Date.parse(prediction.createdAt)) || Date.parse(publishedAt) < Date.parse(prediction.createdAt)) throw new Error('发布时间早于事前预测，不能把已发布旧文登记为新稿预测');
      const filename = await this.checkedPath(prediction.path);
      const original = await fs.readFile(filename, 'utf8');
      const state = await this.state();
      if (this.publicationFor(prediction, state, parseDocument(original).body)) throw new Error('该预测已登记发布，请保留原发布记录');
      const boundary = /^## /m.exec(original)?.index;
      if (boundary === undefined) throw new Error('预测文件缺少章节边界，未登记发布');
      const attributes = parseDocument(original).attributes;
      const frozenPath = safeText(attributes.snapshot_path, markdownField(parseDocument(original).body, 'Script Path'));
      if (!frozenPath) throw new Error('预测缺少冻结稿路径，未登记发布');
      const frozen = await fs.readFile(await this.checkedPath(frozenPath), 'utf8');
      if (draftHash(parseDocument(frozen).body) !== prediction.hash) throw new Error('冻结稿与预测指纹不符，未登记发布');
      const videoFolder = `videos/${prediction.id}/`;
      const platform = /(^|\.)douyin\.com$/i.test(parsed.hostname) ? 'douyin' : /(^|\.)bilibili\.com$/i.test(parsed.hostname) ? 'bilibili' : 'unknown';
      const platformId = platform === 'douyin' ? parsed.pathname.match(/\/video\/(\d+)/)?.[1] || parsed.searchParams.get('modal_id') || parsed.searchParams.get('item_id') || 'pending' : platform === 'bilibili' ? parsed.pathname.match(/\/(BV[\w]+)/)?.[1] || 'pending' : 'pending';
      await this.atomicWrite(`${videoFolder}script.md`, frozen, true);
      await this.atomicWrite(`${videoFolder}publish.md`, `# 发布登记\n\n**Published at**: ${publishedAt}\n**Platform**: ${platform}\n**URL**: ${parsed.href}\n**Aweme ID**: ${platformId}\n**ad_hoc_publish**: true\n\n未经过 cheat-shoot；保存的是此次预测绑定的冻结稿。\n`, true);
      const fields = `**Published at**: ${publishedAt}\n**Platform**: ${platform}\n**URL**: ${parsed.href}\n**Video Folder**: ${videoFolder}\n**Aweme ID**: ${platformId}\n**ad_hoc_publish**: true\n\n`;
      const registered = original.slice(0, boundary) + fields + original.slice(boundary);
      if (registered.slice(boundary + fields.length) !== original.slice(boundary)) throw new Error('发布登记改变了预测章节，未写入');
      await this.atomicWrite(prediction.path, registered);
      const dueAt = new Date(Date.parse(publishedAt) + RETRO_WINDOW_MS).toISOString();
      await this.updateMetadata((metadata, state) => {
        const existing = metadata.publications.find(item => item.predictionId === prediction.id);
        if (existing) throw new Error('该预测已登记发布，请保留原发布记录');
        metadata.publications.push({ draftId, predictionId: prediction.id, url: parsed.href, publishedAt, platform, platformId, videoFolder, adHocPublish: true });
        metadata.retroSchedule = { ...metadata.retroSchedule, [prediction.path]: { draftId, predictionId: prediction.id, dueAt } };
        state.last_published_at = publishedAt; state.last_published_file = prediction.path;
        state.last_published_video_folder = videoFolder; state.last_published_platform_id = platformId;
        state.pending_retros = [...new Set([...(Array.isArray(state.pending_retros) ? state.pending_retros : []), prediction.path])];
      });
      return { ...prediction, status: prediction.status === 'retrospected' ? 'retrospected' : 'published', publishedAt, dueAt };
    });
  }

  async getRetroEligibility(predictionId: string): Promise<RetroEligibility> {
    await this.mutations;
    const prediction = (await this.predictions()).find(item => item.id === predictionId);
    if (!prediction) throw new Error('预测不存在');
    const body = parseDocument(await fs.readFile(await this.checkedPath(prediction.path), 'utf8')).body;
    const publication = this.publicationFor(prediction, await this.state(), body);
    const publishedAt = publication?.publishedAt || null;
    const dueAt = publishedAt ? new Date(Date.parse(publishedAt) + RETRO_WINDOW_MS).toISOString() : null;
    return { published: Boolean(publication), publishedAt, dueAt, early: Boolean(dueAt && Date.now() < Date.parse(dueAt)) };
  }

  async retrospective(predictionId: string, actual?: Partial<Metrics>, note = '', options: RetrospectiveOptions = {}): Promise<Prediction> {
    return this.serial(async () => {
      const prediction = (await this.predictions()).find(item => item.id === predictionId);
      if (!prediction) throw new Error('预测不存在');
      const state = await this.state();
      const normalizedActual = actual ? metrics(actual) : undefined;
      const createdAt = now();
      const filename = await this.checkedPath(prediction.path);
      const original = await fs.readFile(filename, 'utf8');
      const publication = this.publicationFor(prediction, state, parseDocument(original).body);
      if (!publication) throw Object.assign(new Error('请先登记发布，再填写实际结果或复盘。'), { status: 409 });
      const measuredAt = options.measuredAt || createdAt;
      const measureTime = Date.parse(measuredAt), publishTime = Date.parse(publication.publishedAt);
      if (!Number.isFinite(measureTime) || measureTime > Date.parse(createdAt) + 60_000 || measureTime < publishTime) throw new Error('采集时间必须有效，且位于发布之后、当前时间之前。');
      const early = measureTime < publishTime + RETRO_WINDOW_MS;
      if (early && options.earlyConfirmed !== true) throw Object.assign(new Error('尚未到发布 T+3 复盘窗口；请明确确认早期复盘后再继续。'), { status: 409, earlyRetro: true, dueAt: new Date(publishTime + RETRO_WINDOW_MS).toISOString() });
      const observations = (options.observations || (note.trim() ? [note] : [])).map(item => item.trim()).filter(Boolean);
      const record: RetroRecord = { id: identifier('retro'), createdAt, measuredAt, ...(normalizedActual ? { actual: normalizedActual } : {}), note, early_retro: early, observations,
        calibrationEligible: !early && normalizedActual?.plays !== null && normalizedActual?.plays !== undefined && this.isCalibrationPrediction(prediction, state, measuredAt) };
      if (!actual && !note.trim()) throw new Error('请提供实际指标或复盘记录');
      if (!/^## 复盘\s*$/m.test(original)) throw new Error('预测文件缺少复盘边界，未修改原文');
      const suffix = `\n\n### 复盘记录 ${record.createdAt}\n\n- 数据采集时间：${measuredAt}\n- 数据来源：manual paste（用户填写）\n- early_retro: ${early}\n${early ? '- 早期快照：已明确确认；不计成熟校准样本，T+3 待办继续保留。\n' : ''}\n${actual ? `- 实际播放：${record.actual?.plays ?? '未获取'}\n- 点赞：${record.actual?.likes ?? '未获取'}\n- 评论：${record.actual?.comments ?? '未获取'}\n- 分享：${record.actual?.shares ?? '未获取'}\n- 收藏：${record.actual?.collects ?? '未获取'}\n\n` : ''}${note}\n\n${jsonComment('retro', record)}\n`;
      await fs.appendFile(filename, suffix, 'utf8');
      if (observations.length) await this.appendObservations(prediction, record, observations);
      // Append-only preserves every byte of the original prediction, including old retrospectives.
      const calibrationCount = await this.calibrationCount(state);
      await this.updateMetadata((metadata, state) => {
        state.last_retro_at = record.createdAt;
        state.early_retro = early;
        const matureActual = !early && normalizedActual?.plays !== undefined && normalizedActual.plays !== null;
        if (matureActual) state.pending_retros = (Array.isArray(state.pending_retros) ? state.pending_retros : []).filter(item => item !== prediction.path);
        if (record.calibrationEligible && (state.baseline_plays === null || state.baseline_plays === undefined)) state.baseline_plays = normalizedActual!.plays;
        if (record.calibrationEligible && prediction.details && !(metadata.directionRecorded || []).includes(prediction.id)) {
          const center = prediction.details.centralEstimate, plays = normalizedActual!.plays!;
          const direction = plays < center * .75 ? 'high' : plays > center * 1.25 ? 'low' : undefined;
          if (direction) state.consecutive_directional_errors = [...(Array.isArray(state.consecutive_directional_errors) ? state.consecutive_directional_errors : []), direction];
          metadata.directionRecorded = [...(metadata.directionRecorded || []), prediction.id];
        }
        state.calibration_samples = calibrationCount;
      });
      return { ...prediction, status: !early && normalizedActual?.plays !== undefined && normalizedActual.plays !== null ? 'retrospected' : prediction.status, earlyRetro: early, ...(actual ? { actual: metrics(actual) } : {}) };
    });
  }

  private async appendObservations(prediction: Prediction, record: RetroRecord, observations: string[]): Promise<void> {
    const file = await this.checkedPath('rubric-memo.md');
    let memo: string;
    try { memo = await fs.readFile(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; memo = '# Rubric Memo\n\n实绩证据与观察；本文件不进入独立盲评分输入。\n\n## 观察记录\n\n'; }
    const entry = `\n### ${record.createdAt} · ${titleLine(prediction.title)}${record.early_retro ? '（早期观察，待 T+3 验证）' : ''}\n\n- 预测：${prediction.path}\n- 数据采集时间：${record.measuredAt}\n- early_retro: ${record.early_retro === true}\n- 实际播放：${record.actual?.plays ?? '未获取'}\n\n${observations.map(item => `- ${item.replace(/\n/g, '\n  ')}`).join('\n')}\n\n${jsonComment('memo-observation', { predictionId: prediction.id, retroId: record.id, measuredAt: record.measuredAt, early_retro: record.early_retro === true, observations })}\n`;
    const heading = /^## 观察记录\s*$/m.exec(memo);
    if (!heading) memo += `\n\n## 观察记录\n${entry}`;
    else {
      const start = heading.index + heading[0].length;
      const next = /^## /m.exec(memo.slice(start));
      const insertion = next ? start + next.index : memo.length;
      memo = memo.slice(0, insertion) + entry + '\n' + memo.slice(insertion);
    }
    await this.atomicWrite('rubric-memo.md', memo);
  }

  /** A calibration sample needs a real pre-publish blind prediction, not just a retro note. */
  private isCalibrationPrediction(prediction: Prediction, state: CheatState, measuredAt: string): boolean {
    if (this.mode !== 'owner' || !prediction.reviewId) return false;
    const metadata = this.metadata(state);
    const publication = metadata.publications.find(item => item.predictionId === prediction.id && item.draftId === prediction.draftId);
    const review = metadata.reviews.find(item => item.id === prediction.reviewId && item.draftId === prediction.draftId && item.hash === prediction.hash && item.blind === true);
    if (!publication || !review) return false;
    const reviewTime = Date.parse(review.createdAt), predictionTime = Date.parse(prediction.createdAt);
    const publishTime = Date.parse(publication.publishedAt), measureTime = Date.parse(measuredAt);
    return [reviewTime, predictionTime, publishTime, measureTime].every(Number.isFinite)
      && reviewTime <= predictionTime && predictionTime <= publishTime && publishTime + RETRO_WINDOW_MS <= measureTime;
  }

  private async calibrationCount(state: CheatState): Promise<number> {
    if (this.mode !== 'owner') return 0;
    const predictions = await this.predictions();
    let count = 0;
    for (const prediction of predictions) {
      const parsed = parseDocument(await fs.readFile(await this.checkedPath(prediction.path), 'utf8'));
      if (parsed.attributes.sample === true) continue;
      const records = comments<RetroRecord>(parsed.body, 'retro');
      if (records.some(record => record.calibrationEligible === true && record.early_retro !== true && metricValue(record.actual?.plays) !== null && this.isCalibrationPrediction(prediction, state, record.measuredAt || record.createdAt))) count++;
    }
    return count;
  }

  async addMessage(role: ChatMessage['role'], content: string): Promise<ChatMessage> {
    if (!['user', 'assistant'].includes(role) || !content.trim()) throw new Error('消息不能为空');
    return this.serial(async () => {
      const message: ChatMessage = { id: identifier('message'), role, content, createdAt: now() };
      await this.updateMetadata(metadata => { metadata.messages.push(message); });
      return message;
    });
  }

  async importWorks(works: Work[]): Promise<Work[]> {
    return this.serial(async () => {
      const saved: Work[] = [];
      for (const input of works) {
        if (!safeId(input.id)) throw new Error('作品 ID 无效');
        const work: Work = { ...input, title: titleLine(input.title), metrics: metrics(input.metrics), capturedAt: input.capturedAt || now() };
        const relative = `videos/${work.id}/report.md`;
        let previous: Work | undefined;
        try { previous = (await this.works()).find(item => item.id === work.id); } catch { /* first import */ }
        if (previous && previous.capturedAt > work.capturedAt) { saved.push(previous); continue; }
        const body = `# ${work.title}${this.mode === 'demo' && !work.title.includes('示例') ? '（虚构示例）' : ''}\n\n- 视频 ID：\`${work.id}\`\n- 发布时间：${work.publishedAt || '未知'}\n- 链接：${work.url}\n- 抓取时间：${work.capturedAt}\n- 数据来源：${work.source}\n\n## 播放数据\n\n- 播放：${work.metrics.plays ?? '未获取'}\n- 点赞：${work.metrics.likes ?? '未获取'}\n- 评论：${work.metrics.comments ?? '未获取'}\n- 收藏：${work.metrics.collects ?? '未获取'}\n- 分享：${work.metrics.shares ?? '未获取'}\n\n## 原始稿子\n\n${work.description || '（未提供完整口播稿；标题与发布文案不能替代完整原稿。）'}\n`;
        const previousFile = await this.checkedPath(relative);
        try {
          const existing = await fs.readFile(previousFile, 'utf8');
          if (existing !== document({ workbench_kind: 'work', ...work, sample: this.mode === 'demo' }, body)) await this.atomicWrite(`videos/${work.id}/snapshots/${identifier('capture')}.md`, existing, true);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await this.atomicWrite(relative, document({ workbench_kind: 'work', ...work, sample: this.mode === 'demo' }, body));
        saved.push(work);
      }
      const actualWorks = await this.works();
      const plays = actualWorks.map(item => item.metrics.plays).filter((value): value is number => value !== null).sort((a, b) => a - b);
      await this.updateMetadata((_metadata, state) => {
        state.baseline_plays = plays.length ? plays.length % 2 ? plays[Math.floor(plays.length / 2)] : (plays[plays.length / 2 - 1] + plays[plays.length / 2]) / 2 : null;
      });
      return saved;
    });
  }

  private async works(): Promise<Work[]> {
    const entries = await fs.readdir(await this.checkedPath('videos'), { withFileTypes: true });
    const works: Work[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const relative = `videos/${entry.name}/report.md`;
      try {
        const parsed = parseDocument(await fs.readFile(await this.checkedPath(relative), 'utf8'));
        const attrs = parsed.attributes;
        const stat = await fs.stat(await this.checkedPath(relative));
        const legacy = parsed.body;
        const id = safeText(attrs.id, markdownField(legacy, '视频 ID') || entry.name);
        const metricBlock = legacy.split(/^## 播放数据\s*$/m)[1]?.split(/^## /m)[0] || legacy;
        works.push({ id, title: safeText(attrs.title, legacy.match(/^#\s+(.+)/m)?.[1] || id),
          url: safeText(attrs.url, markdownField(legacy, '链接')), publishedAt: safeText(attrs.publishedAt, markdownField(legacy, '发布时间')),
          capturedAt: safeText(attrs.capturedAt, markdownField(legacy, '抓取时间') || stat.mtime.toISOString()),
          metrics: attrs.metrics ? metrics(attrs.metrics) : { plays: markdownNumber(markdownField(metricBlock, '播放')), likes: markdownNumber(markdownField(metricBlock, '点赞')), comments: markdownNumber(markdownField(metricBlock, '评论')), shares: markdownNumber(markdownField(metricBlock, '分享')), collects: markdownNumber(markdownField(metricBlock, '收藏')) },
          source: safeText(attrs.source, 'Cheat report.md'), ...(typeof attrs.description === 'string' ? { description: attrs.description } : {}), ...(typeof attrs.scriptPath === 'string' ? { scriptPath: attrs.scriptPath } : {}) });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return works.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  }

  async getSnapshotData(): Promise<SnapshotData> {
    await this.mutations;
    const [state, works, drafts, predictions] = await Promise.all([this.state(), this.works(), this.drafts(), this.predictions()]);
    const metadata = this.metadata(state);
    for (const draft of drafts) {
      const published = metadata.publications.some(item => item.draftId === draft.id && predictions.some(prediction => prediction.id === item.predictionId && prediction.hash === draftHash(draft.content)));
      const predicted = predictions.some(item => item.draftId === draft.id && item.hash === draftHash(draft.content));
      const reviewed = metadata.reviews.some(item => item.draftId === draft.id && item.version === draft.version && item.hash === draftHash(draft.content));
      draft.stage = published ? 'published' : predicted ? 'predicted' : reviewed ? 'reviewed' : 'draft';
    }
    const calibrationSamples = Number(state.calibration_samples) || 0;
    const benchmarkStatus = state.benchmark_status === 'imported' || state.benchmark_status === 'pending' ? state.benchmark_status : 'none';
    return { project: { name: metadata.name, platform: '抖音', initialized: Boolean(metadata.init?.completedAt), configured: Boolean(metadata.setupCompletedAt),
      legacyInit: !metadata.init?.completedAt && Boolean(state.initialized_at),
      domain: metadata.domain || '', initializedAt: metadata.init?.completedAt || (typeof state.initialized_at === 'string' ? state.initialized_at : ''),
      contentForm: contentFormOf(state),
      baselinePlays: metricValue(state.baseline_plays), calibrationSamples,
      benchmarkStatus, benchmarkName: typeof state.benchmark_name === 'string' ? state.benchmark_name : null,
      benchmarkSampleCount: Number(state.benchmark_sample_count) || 0,
      dataCollection: typeof state.data_collection === 'string' ? state.data_collection : 'manual',
      poolStatus: typeof state.pool_status === 'string' ? state.pool_status : 'none',
      hooksInstalled: state.hooks_installed === true,
      typicalDurationSeconds: Number(state.typical_duration_seconds) || 90,
      cadenceDays: typeof state.target_publish_cadence_days === 'number' ? state.target_publish_cadence_days : null,
      confidence: confidenceFor(calibrationSamples).label,
      historyImportStatus: metadata.init?.historyImportStatus || null,
      historySamples: Number(metadata.init?.historySamples) || 0,
      historyRequested: typeof metadata.init?.historyRequested === 'number' ? metadata.init.historyRequested : null,
      historyBaselinePlays: metricValue(metadata.init?.historyBaselinePlays) ?? metricValue(state.baseline_plays),
      rubricFormMismatch: state.rubric_form_mismatch === true,
      rootLabel: this.mode === 'demo' ? '独立演示目录 · 虚构样例' : '本地独立创作目录', upstreamCommit: UPSTREAM_COMMIT },
      works, drafts, topics: metadata.topics, reviews: metadata.reviews, predictions, messages: metadata.messages };
  }

  async getContext(input: { draftId?: string; workIds?: string[] } = {}): Promise<string> {
    const snapshot = await this.getSnapshotData();
    const draft = input.draftId ? snapshot.drafts.find(item => item.id === input.draftId) : null;
    // An explicit empty selection means the user removed all reference works.
    // Only omitted workIds enables the default history used for topic research.
    const works = (input.workIds !== undefined ? snapshot.works.filter(item => input.workIds!.includes(item.id)) : snapshot.works.slice(0, 6));
    return JSON.stringify({ project: snapshot.project.name, domain: this.metadata(await this.state()).domain,
      draft: draft ? { title: draft.title, content: draft.content, version: draft.version } : null,
      works: works.slice(0, 10).map(item => ({ title: item.title, url: item.url, metrics: item.metrics, publishedAt: item.publishedAt, description: item.description })),
      topics: snapshot.topics.slice(0, 3), dataNotice: this.mode === 'demo' ? '所有历史为虚构示例，不代表真实账号。' : '标题和指标不等于完整口播稿，未提供的经历不可编造。' }, null, 2);
  }

  async readFile(relative: string): Promise<string> {
    const normalized = relative.replace(/\\/g, '/');
    const allowed = /^(?:scripts\/(?:[^/.][^/]*\.md|\.versions\/[^/.][^/]*\/[^/.][^/]*\.md)|predictions\/[^/.][^/]*\.md|videos\/[^/.][^/]*\/(?:report\.md|snapshots\/[^/.][^/]*\.md)|samples\/[^/.][^/]*\/[^/.][^/]*\/(?:meta|transcript)\.md|(?:rubric_notes|rubric-memo|benchmark|audience|script_patterns|STATUS|WORKFLOW|candidates)\.md|\.cheat-state\.json)$/.test(normalized);
    if (!allowed) throw new Error('只允许读取创作项目公开文件');
    const target = await this.checkedPath(normalized);
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > 2_000_000) throw new Error('文件类型或大小不支持预览');
    return fs.readFile(target, 'utf8');
  }

  private async seedDemo(): Promise<void> {
    const titles = ['示例 · 工具越多，为什么效率越低', '示例 · 我把一天的重复工作交给 AI', '示例 · 不要让孩子只会点生成', '示例 · 第一次做自动化踩了什么坑', '示例 · 一个普通人的 AI 工作桌', '示例 · 我删掉了三款效率工具'];
    await this.importWorks(titles.map((title, index) => ({ id: `sample-work-${index + 1}`, title,
      url: `https://example.com/demo/works/${index + 1}`, publishedAt: new Date(Date.UTC(2026, 9, 10 + index, 2)).toISOString(),
      capturedAt: '2026-10-22T02:00:00.000Z', metrics: { plays: [1800, 4200, 7600, 2900, 5300, 11200][index], likes: [36, 120, 248, 75, 159, 438][index], comments: [4, 12, 28, 9, 18, 47][index], shares: [7, 21, 62, 17, 35, 91][index], collects: [10, 45, 83, 28, 52, 137][index] }, source: '虚构示例数据 · 非真实账号', description: '仅供展示界面与数据流。没有真实用户经历或平台实绩。' })));
    await this.saveDraft({ id: 'sample-draft-1', title: '示例 · AI 工具越多，为什么效率越低', content: '【虚构演示稿】\n\n你收藏了二十个 AI 工具，真正每天打开的有几个？\n\n我给自己的工作桌做了一次减法：先找到每天重复的一件事，再选一个工具。\n\n这篇稿件只用于展示编辑器与版本管理，不代表真实创作者经历。' });
    await this.saveDraft({ id: 'sample-draft-2', title: '示例 · 让孩子讲清楚自己改了什么', content: '【虚构演示稿】\n\n一张漂亮的 AI 海报，能证明孩子学会了吗？\n\n如果孩子能讲清楚初稿哪里不合适、自己为什么修改，我们才看见了选择和判断。\n\n这是虚构的展示文本，请用自己的真实材料替换。' });
    // Seeded reports are explicitly simulated, not an agent-generated blind score.
    const draft = await this.getDraft('sample-draft-1');
    const createdAt = '2026-10-18T02:00:00.000Z';
    const id = 'sample-prediction-1';
    const hash = draftHash(draft.content);
    const prediction: Prediction = { id, draftId: draft.id, title: draft.title, createdAt, hash, version: 1, path: 'predictions/2026-10-18_sample-prediction-1.md', forecast: '【虚构样例】预期与近期基线持平；冷启动，不作可靠流量判断。', rationale: '【虚构样例】测试具体问题开头能否带来更清楚的表达。', status: 'pending' };
    const body = `# ${draft.title} — 虚构示例预测日志\n\n> 所有记录均为虚构，仅演示工作台。未进行真实评分或发布。\n\n**Script Hash**: \`sha256:${hash}\`\n\n## 输入快照\n\n虚构示例，非独立评分结果。\n\n## 预测 v1\n\n${prediction.forecast}\n\n## 推理因素\n\n${prediction.rationale}\n\n## 锚点对比\n\n虚构样例，不作为预测能力证据。\n\n## 反事实场景（复盘用）\n\n仅演示，不构成真实假设验证。\n\n## 关键校准假设\n\n替换为用户真实新稿后才开始采集。\n\n## 复盘\n\n`;
    if (!(await this.predictions()).some(item => item.id === id)) {
      const frozenPath = `scripts/.versions/${draft.id}/prediction-${id}.md`;
      await this.atomicWrite(frozenPath, document({ id: draft.id, title: draft.title, version: draft.version, content_hash: hash, sample: true }, draft.content), true);
      await this.atomicWrite(prediction.path, document({ workbench_kind: 'prediction', ...prediction, draft_version: draft.version, snapshot_path: frozenPath, sample: true }, body), true);
      await this.publish(draft.id, 'https://example.com/demo/published/1', '2026-10-19T02:00:00.000Z');
      await this.retrospective(id, { plays: 4800, likes: 115, comments: 14, shares: 23, collects: 38 }, '【虚构复盘】用于展示预测与实际对照，不代表真实命中率或账号表现。');
    }
    await this.serial(async () => this.updateMetadata((metadata, state) => { metadata.demoSeeded = true; state.calibration_samples = 0; }));
  }
}
