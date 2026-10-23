import { z } from 'zod';

export const contentForms = ['opinion-video', 'long-essay', 'short-text', 'podcast', 'tutorial-builder', 'other', 'mixed'] as const;
export const contentFormSchema = z.enum(contentForms);
export type ContentForm = z.infer<typeof contentFormSchema>;

export const contentFormLabels: Record<ContentForm, string> = {
  'opinion-video': '观点视频',
  'long-essay': '长文 / Essay',
  'short-text': '短文 / Thread',
  podcast: '播客 / 长视频',
  'tutorial-builder': '教程 / Builder',
  other: '其他形态',
  mixed: '混合形态',
};

export const durationOptions = [30, 90, 240, 450, 900] as const;
export const durationLabels: Record<number, string> = { 30: '30 秒–1 分钟', 90: '1–3 分钟', 240: '3–5 分钟', 450: '5–10 分钟', 900: '10 分钟以上' };
export const cadenceOptions = [1, 2, 7] as const;
export const cadenceLabels: Record<number, string> = { 1: '日更', 2: '隔日', 7: '每周' };
export const durationQuestionForms: ContentForm[] = ['opinion-video', 'podcast', 'other'];

const metricValue = z.number().int().min(0).max(1_000_000_000).nullish();

export const InitSampleSchema = z.object({
  title: z.string().trim().min(1, '请填写样本标题。').max(200),
  plays: metricValue,
  likes: metricValue,
  comments: metricValue,
  shares: metricValue,
  impression: z.enum(['high', 'medium', 'low']),
  url: z.string().trim().max(500).refine(value => !value || /^https?:\/\//i.test(value), '样本链接必须是 http(s) 地址。').optional().default(''),
  transcript: z.string().max(30_000, '单条 transcript 不能超过 30000 字。').optional().default(''),
});
export type InitSample = z.infer<typeof InitSampleSchema>;

export const InitInputSchema = z.object({
  confirmed: z.boolean().optional().default(false),
  name: z.string().trim().min(1, '请填写创作空间名称。').max(100),
  domain: z.string().trim().max(300).optional().default(''),
  contentForm: contentFormSchema,
  typicalDurationSeconds: z.union([z.literal(30), z.literal(90), z.literal(240), z.literal(450), z.literal(900)]).nullish(),
  cadenceDays: z.union([z.literal(1), z.literal(2), z.literal(7)]).nullish(),
  historyMode: z.enum(['import', 'skip']).optional().default('skip'),
  historyCount: z.number().int().min(1).max(500).nullish(),
  dataCollection: z.enum(['manual', 'adapter']).optional().default('adapter'),
  poolStatus: z.enum(['none', 'markdown', 'notion']).optional().default('none'),
  hooks: z.boolean().optional().default(false),
  benchmark: z.object({
    mode: z.enum(['imported', 'pending', 'none']).optional().default('none'),
    name: z.string().trim().max(120).optional().default(''),
    style: z.string().trim().max(300).optional().default(''),
    platform: z.string().trim().max(40).optional().default('抖音'),
    samples: z.array(InitSampleSchema).max(15, '对标样本最多 15 条。').optional().default([]),
  }).optional().default({ mode: 'none', name: '', style: '', platform: '抖音', samples: [] }),
}).superRefine((input, context) => {
  if (input.benchmark.mode === 'imported') {
    if (!input.benchmark.name) context.addIssue({ code: z.ZodIssueCode.custom, path: ['benchmark', 'name'], message: '导入对标时请填写对标账号名。' });
    if (input.benchmark.samples.length < 3) context.addIssue({ code: z.ZodIssueCode.custom, path: ['benchmark', 'samples'], message: '对标分析至少需要 3 条样本。' });
  }
  if (input.historyMode === 'import' && input.historyCount == null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['historyCount'], message: '请填写计划对齐的历史作品数量。' });
  }
});
export type InitInput = z.infer<typeof InitInputSchema>;

export interface InitStatus {
  hasState: boolean;
  initialized: boolean;
  bootstrapped: boolean;
  legacy: boolean;
  initializedAt: string | null;
  hasData: boolean;
  works: number;
  topics: number;
  predictions: number;
  contentForm: ContentForm;
  calibrationSamples: number;
  benchmarkStatus: 'imported' | 'pending' | 'none';
  historySamples: number;
  historyImportStatus: string | null;
  rubricFormMismatch: boolean;
}

export interface InitReport {
  initializedAt: string;
  contentForm: ContentForm;
  rubricFile: string;
  confidence: ConfidenceLevel;
  created: string[];
  preserved: string[];
  skipped: string[];
  warnings: string[];
  benchmark: { status: 'imported' | 'pending' | 'none'; name: string | null; sampleCount: number };
  history: { mode: 'import' | 'skip'; status: 'pending' | 'skipped'; platform: 'douyin-creator-edge' | null; requested: number | null };
  preservedData: { works: number; topics: number; predictions: number };
  nextSteps: string[];
}

export interface ConfidenceLevel { level: string; emoji: string; label: string; samples: number }

/** Upstream confidence bands, derived only from mature calibration samples. */
export function confidenceFor(samples: number): ConfidenceLevel {
  const count = Number.isFinite(samples) ? Math.max(0, Math.floor(samples)) : 0;
  if (count === 0) return { level: '极低', emoji: '🔴', label: '🔴 极低', samples: count };
  if (count <= 2) return { level: '低', emoji: '🟠', label: '🟠 低', samples: count };
  if (count <= 5) return { level: '偏低', emoji: '🟡', label: '🟡 偏低', samples: count };
  if (count <= 10) return { level: '中', emoji: '🟢', label: '🟢 中', samples: count };
  if (count <= 20) return { level: '较高', emoji: '🟢', label: '🟢 较高', samples: count };
  return { level: '高', emoji: '🔵', label: '🔵 高', samples: count };
}

export function rubricFileFor(form: ContentForm): string {
  return `${form === 'mixed' ? 'opinion-video' : form}-zero.md`;
}

/** Upstream state requires a local ISO timestamp with an explicit +08:00 offset. */
export function localIso(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || '00';
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}:${value('second')}+08:00`;
}

export function safeDirectoryName(value: string, fallback = 'benchmark'): string {
  const cleaned = value.trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
  return cleaned || fallback;
}

/** Stable sample id derived only from public sample fields; no creator data. */
export function sampleId(sample: Pick<InitSample, 'title' | 'url'>): string {
  const text = `${sample.title}\u0000${sample.url || ''}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const cell = (value: string) => value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
const metricText = (value: number | null | undefined) => value == null ? '未获取' : String(value);
const impressionText = { high: '高', medium: '中', low: '低' } as const;
export const impressionLabels = impressionText;

export function renderBenchmarkMarkdown(input: { name: string; platform?: string; style?: string; importedAt?: string; samples: InitSample[] }): string {
  const importedAt = input.importedAt || localIso().slice(0, 10);
  const account = safeDirectoryName(input.name);
  const sampleRows = input.samples.map((sample, index) => {
    const transcriptPath = sample.transcript ? `samples/${account}/${sampleId(sample)}/transcript.md` : '未提供';
    return `| ${index + 1} | ${cell(sample.title)} | ${metricText(sample.plays)} | ${metricText(sample.likes)} | ${metricText(sample.comments)} | ${metricText(sample.shares)} | ${impressionText[sample.impression]} | ${transcriptPath} |`;
  }).join('\n');
  return `# 对标账号：${input.name}

> 原始样本由 Cheat 初始化写入；定性分析由独立的「对标分析」任务补充。
> 本文件进入独立盲评的白名单之外，评分时不会把实绩或账号信息交给盲评子 agent。

## 账号信息

- **名字**: ${input.name}
- **平台**: ${input.platform || '抖音'}
- **风格 / 调性**: ${input.style || '待补充'}
- **导入时间**: ${importedAt}
- **样本数**: ${input.samples.length}

## 导入的样本

| # | 视频标题 | 播放 | 点赞 | 评论 | 转发 | 你的印象 | transcript |
|---|---|---|---|---|---|---|---|
${sampleRows}

> **印象档**：高 / 中 / 低 是导入时用户的主观判断，不是数据结论。

## 基础 rubric 派生（待分析）

尚未运行对标分析。定性观察会写在这里，且不会自动修改 rubric_notes.md。

## 基础 patterns 派生（待分析）

详见 script_patterns.md 的「对标 ${input.name} 借鉴」段。
`;
}

export function renderSampleMeta(input: { account: string; sample: InitSample; index: number; importedAt?: string }): string {
  return `# ${input.sample.title}

- 对标账号：${input.account}
- 样本序号：${input.index + 1}
- 主观印象：${impressionText[input.sample.impression]}
- 播放：${metricText(input.sample.plays)}
- 点赞：${metricText(input.sample.likes)}
- 评论：${metricText(input.sample.comments)}
- 转发：${metricText(input.sample.shares)}
- 链接：${input.sample.url || '未提供'}
- 导入时间：${input.importedAt || localIso().slice(0, 10)}
`;
}
