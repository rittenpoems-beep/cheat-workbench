import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Workspace } from './workspace.js';
import type { Topic, Work } from '../shared/types.js';

const upstreamRoot = fileURLToPath(new URL('../../../', import.meta.url));
const WORK_LIMIT = 12;
const TOPIC_LIMIT = 3;
const TREND_LIMIT = 12;
const DRAFT_LIMIT = 24_000;

type Loaded = { audience: number; rubric: number; scriptPatterns: number; benchmark: number; rubricMemo: number;
  works: number; worksTotal: number; topics: number; topicsTotal: number; trends: number; trendsTotal: number;
  draft: boolean; draftChars: number; truncated: Record<string, boolean> };
type Context = { account: { name: string }; draft: { title: string; content: string } | null; works: Work[];
  topics: Topic[]; rawTrends: Topic[]; loaded: Loaded; audience: string; rubric: string; scriptPatterns: string;
  benchmark: string; rubricMemo: string; recentReviews: unknown[]; recentPredictions: unknown[] };

async function temporary() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cheat-context-stress-'));
  const workspace = new Workspace(root, 'owner', upstreamRoot);
  await workspace.init();
  return { root, workspace, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
const topic = (index: number, kind: 'topic' | 'trend'): Topic => ({
  id: `${kind}-${index}`, title: `${kind === 'topic' ? '候选' : '原始'}选题 ${index}`,
  category: kind === 'topic' ? `类型-${index % 3}` : '抖音热榜', angle: kind === 'topic' ? `角度 ${index}` : '原始线索，未筛选',
  reason: `理由 ${index}`, sourceUrl: `https://example.com/${kind}/${index}`, sourceTitle: `来源 ${index}`,
  capturedAt: new Date(2026, 9, 25, 10, index).toISOString(),
});
const work = (index: number): Work => ({
  id: `stress-work-${index}`, title: `压力作品 ${index}`, url: `https://www.douyin.com/video/${1000 + index}`,
  publishedAt: new Date(2026, 9, 20, index).toISOString(), capturedAt: new Date(2026, 9, 24, index).toISOString(),
  source: 'stress-fixture', description: `作品说明 ${index} ` + '述'.repeat(500),
  metrics: { plays: 100 + index, likes: index, comments: 0, shares: null, collects: index },
});
const oneLine = (char: string, length: number) => char.repeat(length);
const wellFormed = (text: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

test('context manifest never claims materials that were not attached, and stays bounded with a huge workspace', async () => {
  const { root, workspace, cleanup } = await temporary();
  try {
    // Unicode straddles every clipping limit: a naive slice would emit a lone surrogate.
    await fs.writeFile(path.join(root, 'audience.md'), '字'.repeat(3_999) + '😀' + '字'.repeat(6_000));
    await fs.writeFile(path.join(root, 'rubric_notes.md'), '规'.repeat(11_999) + '😀' + '规'.repeat(18_000));
    await fs.writeFile(path.join(root, 'script_patterns.md'), '结'.repeat(9_999) + '😀' + '结'.repeat(15_000));
    await fs.writeFile(path.join(root, 'rubric-memo.md'), '记'.repeat(7_999) + '😀' + '记'.repeat(12_000));
    // benchmark.md intentionally absent.
    await workspace.setTopics(Array.from({ length: 7 }, (_, index) => topic(index, 'topic')));
    await workspace.setTrends(Array.from({ length: 20 }, (_, index) => topic(index, 'trend')));
    await workspace.importWorks(Array.from({ length: 15 }, (_, index) => work(index)));
    const draftContent = '稿'.repeat(23_999) + '😀' + '稿'.repeat(6_000);
    const draft = await workspace.saveDraft({ title: '压力长稿', content: draftContent });

    const started = Date.now();
    const context: Context = JSON.parse(await workspace.getContext({ draftId: draft.id }));
    const elapsed = Date.now() - started;
    const text = JSON.stringify(context);

    assert.equal(context.topics.length, TOPIC_LIMIT, 'topic candidates must be capped');
    assert.equal(context.loaded.topics, context.topics.length, 'loaded.topics must count attached candidates');
    assert.equal(context.loaded.topicsTotal, 7, 'totals stay available separately');
    assert.equal(context.rawTrends.length, TREND_LIMIT, 'raw trends must be capped');
    assert.equal(context.loaded.trends, context.rawTrends.length, 'loaded.trends must count attached trends');
    assert.equal(context.loaded.trendsTotal, 20);
    assert.equal(context.works.length, WORK_LIMIT);
    assert.equal(context.loaded.works, WORK_LIMIT);
    assert.equal(context.loaded.worksTotal, 15);
    assert.ok(context.works.every(item => (item.description || '').length <= 400));
    assert.ok(context.works.every(item => wellFormed(item.description || '')), 'work description must not split unicode');

    assert.equal(context.draft?.content.length, context.loaded.draftChars);
    assert.ok(context.draft!.content.length <= DRAFT_LIMIT + 40, 'draft context must be capped');
    assert.match(context.draft!.content, /上下文长度限制/);
    assert.ok(wellFormed(context.draft!.content), 'draft clip must not split unicode');
    assert.equal(context.loaded.truncated.draft, true);
    assert.equal(context.benchmark, '');
    assert.equal(context.loaded.benchmark, 0);
    assert.equal(context.loaded.truncated.benchmark, false);

    for (const key of ['audience', 'rubric', 'scriptPatterns', 'rubricMemo'] as const) {
      assert.ok(context[key].length > 0, `${key} should be loaded`);
      assert.ok(context[key].length <= (key === 'audience' ? 4_000 : key === 'rubric' ? 12_000 : key === 'scriptPatterns' ? 10_000 : 8_000) + 40);
      assert.match(context[key], /上下文长度限制/);
      assert.ok(wellFormed(context[key]), `${key} must not split unicode`);
      assert.equal(context.loaded[key], context[key].length);
      assert.equal(context.loaded.truncated[key], true);
    }

    assert.ok(text.length < 120_000, `context must stay bounded, got ${text.length}`);
    assert.ok(elapsed < 2_000, `context assembly too slow: ${elapsed}ms`);

    const summary = await workspace.getContextSummary(draft.id);
    assert.equal(summary.topics, context.loaded.topics);
    assert.equal(summary.topicsTotal, context.loaded.topicsTotal);
    assert.equal(summary.trends, context.loaded.trends);
    assert.equal(summary.trendsTotal, context.loaded.trendsTotal);
    assert.equal(summary.works, context.loaded.works);
    assert.equal(summary.worksTotal, context.loaded.worksTotal);
    assert.equal(summary.draftChars, context.loaded.draftChars);
    assert.deepEqual(summary.truncated, context.loaded.truncated);

    const invalid: Context = JSON.parse(await workspace.getContext({ draftId: 'missing-draft', workIds: [] }));
    assert.equal(invalid.draft, null);
    assert.equal(invalid.loaded.draft, false);
    assert.equal(invalid.works.length, 0);
    assert.equal(invalid.loaded.works, 0);
    assert.equal(invalid.loaded.worksTotal, 15);

    const chosen: Context = JSON.parse(await workspace.getContext({ workIds: ['stress-work-3'] }));
    assert.equal(chosen.works.length, 1);
    assert.equal(chosen.works[0].id, 'stress-work-3');
    assert.equal(chosen.loaded.works, 1);
    assert.equal(chosen.loaded.worksTotal, 15);
    assert.equal(chosen.draft, null);
  } finally { await cleanup(); }
});

test('concurrent context reads and metadata writes stay parseable and self-consistent', async () => {
  const { root, workspace, cleanup } = await temporary();
  try {
    await fs.writeFile(path.join(root, 'audience.md'), oneLine('众', 2_000));
    await fs.writeFile(path.join(root, 'rubric_notes.md'), oneLine('规', 3_000));
    const draft = await workspace.saveDraft({ title: '并发稿', content: oneLine('稿', 5_000) });
    await workspace.importWorks(Array.from({ length: 6 }, (_, index) => work(index)));
    await workspace.setTopics([topic(0, 'topic')]);
    await workspace.setTrends([topic(0, 'trend')]);

    const reads = Array.from({ length: 24 }, (_, index) => index % 2
      ? workspace.getContext({ draftId: draft.id, workIds: index % 4 === 0 ? [] : ['stress-work-2'] })
      : workspace.getContext());
    const summaries = Array.from({ length: 12 }, (_, index) => workspace.getContextSummary(index % 3 === 0 ? draft.id : undefined));
    const writes = Array.from({ length: 10 }, (_, index) => (index % 2
      ? workspace.setTopics(Array.from({ length: index + 1 }, (_, item) => topic(item, 'topic')))
      : workspace.setTrends(Array.from({ length: index + 1 }, (_, item) => topic(item, 'trend')))));
    const results = await Promise.all([...reads, ...summaries, ...writes]);

    for (const raw of results.slice(0, reads.length) as string[]) {
      const parsed: Context = JSON.parse(raw);
      assert.equal(parsed.loaded.topics, parsed.topics.length);
      assert.equal(parsed.loaded.trends, parsed.rawTrends.length);
      assert.equal(parsed.loaded.works, parsed.works.length);
      assert.equal(parsed.loaded.truncated.draft, false);
      assert.ok(wellFormed(raw));
    }
    const snapshot = await workspace.getSnapshotData();
    assert.ok(snapshot.topics.length >= 1);
    assert.ok(snapshot.trends.length >= 1);
    assert.ok(snapshot.messages.length === 0);
  } finally { await cleanup(); }
});
