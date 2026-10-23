import type { Metrics, Work } from './types.js';

export const DOUYIN_SOURCE = 'douyin-creator-edge';
const ARRAY_KEYS = ['aweme_list', 'item_list', 'items', 'list', 'work_list'] as const;
const METRIC_ALIASES = {
  plays: ['play_count', 'play_cnt'],
  likes: ['digg_count', 'like_count', 'digg_cnt'],
  comments: ['comment_count', 'comment_cnt'],
  shares: ['share_count', 'share_cnt'],
  collects: ['collect_count', 'collect_cnt', 'favorite_count'],
} as const;
const METRIC_FIELDS = Object.keys(METRIC_ALIASES) as (keyof Metrics)[];
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

type UnknownRecord = Record<string, unknown>;

export type DouyinImportCode = 'NO_WORKS' | 'NO_METRICS' | 'INVALID_ITEMS';

export class DouyinImportError extends Error {
  constructor(public readonly code: DouyinImportCode, message: string) {
    super(message);
    this.name = 'DouyinImportError';
  }
}

export const isRecord = (value: unknown): value is UnknownRecord => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Preserve genuine zero; never turn a missing or approximate count into zero. */
export function numeric(value: unknown): number | null {
  if (typeof value === 'boolean' || value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const isoSeconds = (milliseconds: number) => {
  try {
    return `${new Date(milliseconds).toISOString().slice(0, 19)}Z`;
  } catch {
    return '';
  }
};

/** ISO strings without a timezone are unknown, not local platform time. */
export function timestamp(value: unknown): string {
  if (typeof value === 'string' && !/^\d+$/.test(value)) {
    const text = value.trim();
    if (!ISO_WITH_ZONE.test(text)) return '';
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? '' : isoSeconds(parsed);
  }
  let seconds = numeric(value);
  if (seconds === null || seconds <= 0) return '';
  if (seconds > 1e12) seconds /= 1000;
  const milliseconds = seconds * 1000;
  return Number.isFinite(milliseconds) ? isoSeconds(milliseconds) : '';
}

/** Adapter list shapes, extended for nested data and item wrappers. */
export function videoCandidates(payload: unknown): UnknownRecord[] {
  if (!isRecord(payload)) return [];
  let node: UnknownRecord = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    for (const key of ARRAY_KEYS) {
      const value = node[key];
      if (Array.isArray(value)) return value.filter(isRecord);
    }
    if (!isRecord(node.data)) return [];
    node = node.data;
  }
  return [];
}

export function unwrapVideo(value: UnknownRecord): UnknownRecord {
  for (const key of ['aweme_info', 'item_info', 'aweme', 'item']) {
    const inner = value[key];
    if (isRecord(inner)) return { ...value, ...inner };
  }
  return value;
}

const text = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
};

export function normalizeWork(value: unknown, capturedAt: string): Work | null {
  if (!isRecord(value)) return null;
  const raw = unwrapVideo(value);
  const rawId = raw.aweme_id || raw.item_id || raw.id;
  const id = rawId === null || rawId === undefined ? '' : String(rawId);
  if (!/^\d+$/.test(id)) return null;

  const metrics = {} as Metrics;
  const containers: unknown[] = [raw.statistics, raw.stats, raw.statistic_data, raw];
  for (const field of METRIC_FIELDS) {
    metrics[field] = null;
    for (const container of containers) {
      if (!isRecord(container)) continue;
      for (const alias of METRIC_ALIASES[field]) {
        const count = numeric(container[alias]);
        if (count !== null) { metrics[field] = count; break; }
      }
      if (metrics[field] !== null) break;
    }
  }

  const description = text(raw.desc) || text(raw.title);
  return {
    id,
    title: description || '（未提供标题）',
    description,
    url: `https://www.douyin.com/video/${id}`,
    publishedAt: timestamp(raw.create_time || raw.createTime),
    capturedAt,
    metrics,
    source: DOUYIN_SOURCE,
  };
}

/** A later response may fill a missing field but never erase a valid count. */
export function mergeWorks(existing: Work[], incoming: Work[], limit: number): Work[] {
  const byId = new Map(existing.map(work => [work.id, work]));
  for (const item of incoming) {
    const previous = byId.get(item.id);
    if (!previous) { byId.set(item.id, item); continue; }
    byId.set(item.id, {
      ...previous,
      title: item.title || previous.title,
      description: item.description || previous.description,
      url: item.url || previous.url,
      publishedAt: item.publishedAt || previous.publishedAt,
      capturedAt: item.capturedAt || previous.capturedAt,
      scriptPath: item.scriptPath || previous.scriptPath,
      source: item.source || previous.source,
      metrics: {
        plays: item.metrics.plays ?? previous.metrics.plays,
        likes: item.metrics.likes ?? previous.metrics.likes,
        comments: item.metrics.comments ?? previous.metrics.comments,
        shares: item.metrics.shares ?? previous.metrics.shares,
        collects: item.metrics.collects ?? previous.metrics.collects,
      },
    });
  }
  return [...byId.values()].slice(0, Math.max(0, limit));
}

export function accountFromPayload(payload: unknown): { name: string; id?: string } | null {
  if (!isRecord(payload)) return null;
  let candidates: UnknownRecord[] = [payload];
  for (let depth = 0; depth < 3; depth += 1) {
    const next: UnknownRecord[] = [];
    for (const node of candidates) {
      const name = node.nickname || node.user_name || node.nick_name;
      if (typeof name === 'string' && name.trim()) {
        const account: { name: string; id?: string } = { name: name.trim() };
        const id = node.unique_id || node.unique_uid || node.short_id || node.uid;
        if ((typeof id === 'string' && id.trim()) || (typeof id === 'number' && Number.isFinite(id))) account.id = String(id);
        return account;
      }
      for (const key of ['data', 'user', 'user_info', 'author', 'account']) {
        if (isRecord(node[key])) next.push(node[key] as UnknownRecord);
      }
    }
    candidates = next;
  }
  return null;
}

export interface ImportValidation {
  works: Work[];
  rejected: number;
}

/**
 * Import gate: the extension supplies raw page items, and the server rebuilds
 * IDs, URLs and metrics. A sync succeeds only with a real work and a real metric.
 */
export function validateImportedWorks(items: unknown, options: { limit: number; capturedAt: string }): ImportValidation {
  if (!Array.isArray(items) || items.length === 0) throw new DouyinImportError('NO_WORKS', '创作者中心没有返回作品列表。');
  const normalized = items.map(item => normalizeWork(item, options.capturedAt)).filter((work): work is Work => work !== null);
  if (normalized.length === 0) throw new DouyinImportError('INVALID_ITEMS', '作品数据中没有可识别的作品 ID。');
  const safeLimit = Number.isFinite(options.limit) ? Math.max(1, Math.min(50, Math.floor(options.limit))) : 10;
  const works = mergeWorks([], normalized, safeLimit);
  if (!works.some(work => METRIC_FIELDS.some(field => work.metrics[field] !== null))) {
    throw new DouyinImportError('NO_METRICS', '作品列表没有返回任何真实指标。');
  }
  return { works, rejected: items.length - normalized.length };
}
