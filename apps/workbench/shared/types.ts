export type Space = 'owner' | 'demo';
export type ChannelId = 'codebuddy' | 'model-api' | 'claude' | 'codex' | 'qoder';
export type PrimaryChannel = 'auto' | ChannelId;
export type ChannelCode = 'ready' | 'needs-key' | 'needs-login' | 'not-installed' | 'experimental' | 'planned';
export interface ChannelStatus {
  id: ChannelId;
  label: string;
  kind: 'agent' | 'api';
  code: ChannelCode;
  detail: string;
  version?: string;
  models?: string[];
  active?: boolean;
}
export interface BlindStatus { mode: 'codebuddy-subagent'; subagent: string; ready: boolean; detail: string; }
export type TaskStatus = 'queued' | 'running' | 'waiting' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface Metrics { plays: number | null; likes: number | null; comments: number | null; shares: number | null; collects: number | null }
export interface Work { id: string; title: string; url: string; publishedAt: string; capturedAt: string; metrics: Metrics; description?: string; scriptPath?: string; source: string; }
export interface Draft { id: string; title: string; content: string; path: string; updatedAt: string; version: number; stage: 'draft' | 'reviewed' | 'predicted' | 'published'; }
export interface Topic { id: string; title: string; category?: string; angle: string; reason: string; sourceUrl: string; sourceTitle: string; capturedAt: string; personalInput?: string; }
export interface Dimension { name: string; score: number; max: number; reason: string; quote: string; }
export interface ReviewIsolation { freshConfig: boolean; toolsDisabledExceptAgent: boolean; subagent?: string; toolCallVerified?: boolean; }
export interface ReviewContamination { warning: boolean; note: string; }
export interface Review { id: string; draftId: string; version: number; hash: string; createdAt: string; dimensions: Dimension[]; summary: string; suggestions: string[]; provider: string; blind: boolean; channel?: ChannelId; model?: string; mode?: string; isolation?: ReviewIsolation; contamination?: ReviewContamination; }
export interface PredictionBucket { id: string; label: string; min: number; max: number | null; probability: number; }
export interface PredictionDetails {
  buckets: PredictionBucket[]; headlineBucketId: string; centralEstimate: number;
  confidence: string; composite: number; baselinePlays: number | null; calibrationSamples: number;
  factors: { factor: string; direction: 'positive' | 'negative' | 'uncertain'; confidence: 'high' | 'medium' | 'low'; reason: string }[];
  anchors: { workId: string; title: string; comparison: string }[]; anchorNote: string;
  counterfactuals: { bucketId: string; analysis: string }[]; assumptions: string[];
}
export interface PredictionProposal { draftId: string; draftVersion: number; draftHash: string; reviewId: string; forecast: string; rationale: string; details: PredictionDetails; }
export interface Prediction { id: string; draftId: string; title: string; createdAt: string; hash: string; version: number; path: string; forecast: string; rationale: string; status: 'pending' | 'published' | 'retrospected'; actual?: Metrics; reviewId?: string; details?: PredictionDetails; publishedAt?: string; dueAt?: string; earlyRetro?: boolean; }
export interface TaskEvent { at: string; message: string; level?: 'info' | 'warning' | 'error'; }
export interface Task { id: string; kind: string; label: string; status: TaskStatus; createdAt: string; updatedAt: string; events: TaskEvent[]; error?: string; errorCode?: string; result?: unknown; }
export interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; createdAt: string; }
export interface ContextTruncated {
  audience: boolean; rubric: boolean; scriptPatterns: boolean; benchmark: boolean; rubricMemo: boolean; draft: boolean;
}
export interface ContextSummary {
  audience: number; rubric: number; scriptPatterns: number; benchmark: number; rubricMemo: number;
  works: number; worksTotal: number; topics: number; topicsTotal: number; trends: number; trendsTotal: number;
  draft: boolean; draftChars: number; truncated: ContextTruncated;
}
export interface SkillInfo { id: string; name: string; description: string; path: string; }
export interface Settings {
  provider: PrimaryChannel;
  codebuddyAuth: 'auto' | 'account' | 'model-api';
  modelApi: 'deepseek' | 'openai-compatible';
  baseUrl: string;
  model: string;
  budget: number;
  deepseekConfigured: boolean;
  codebuddyAvailable: boolean;
  codexAvailable: boolean;
  claudeAvailable: boolean;
  channels: ChannelStatus[];
  activeProvider: string;
  activeModel: string;
  blind: BlindStatus;
  providerIssue?: string;
}
export interface Snapshot {
  browser?: import('./browser.js').BrowserStatus;
  mode: Space;
  project: {
    name: string; platform: string; initialized: boolean; configured: boolean; legacyInit: boolean; domain: string; initializedAt: string;
    contentForm: string; baselinePlays: number | null; calibrationSamples: number; rootLabel: string; upstreamCommit: string;
    benchmarkStatus: 'imported' | 'pending' | 'none'; benchmarkName: string | null; benchmarkSampleCount: number;
    dataCollection: string; poolStatus: string; hooksInstalled: boolean; typicalDurationSeconds: number; cadenceDays: number | null;
    confidence: string; historyImportStatus: string | null; historySamples: number; historyRequested: number | null; historyBaselinePlays: number | null; rubricFormMismatch: boolean;
  };
  works: Work[]; drafts: Draft[]; topics: Topic[]; trends: Topic[]; reviews: Review[]; predictions: Prediction[]; tasks: Task[]; messages: ChatMessage[]; skills: SkillInfo[]; settings: Settings;
}

// HTTP contract: GET /api/snapshot -> Snapshot
// POST /api/drafts { title, content?, id? } -> Draft
// POST /api/jobs { kind, input } -> Task (202)
// kinds: topics { query }, draft { topicId?, brief, title? }, revise { draftId, instruction },
// review { draftId }, predict { draftId }, retro { predictionId, actual?, note? },
// chat { message, draftId?, workIds? }, sync { limit? }, trends { query? },
// skill { skillId, instruction? }, initialize { name?, domain? }
// POST /api/jobs/:id/cancel -> Task; GET /api/tasks/:id -> Task
// POST /api/publish { draftId, url, publishedAt? } -> Prediction
// GET /api/files?path=... -> { path, content }; GET /api/export?draftId=... -> markdown
// POST /api/settings { provider?, codebuddyAuth?, modelApi?, baseUrl?, model?, budget?, deepseekKey? } -> Settings (never returns a key)
// POST /api/settings/test -> { ok, channel, auth, model, latencyMs, detail } (owner only, rate limited)
