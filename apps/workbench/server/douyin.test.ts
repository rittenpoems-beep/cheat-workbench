import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DouyinImportError, accountFromPayload, mergeWorks, normalizeWork, numeric,
  timestamp, validateImportedWorks, videoCandidates,
} from '../shared/douyin.js';

const fixtures = JSON.parse(await readFile(new URL('../shared/fixtures/douyin-normalization.json', import.meta.url), 'utf8'));
const AT = fixtures.capturedAt;

test('missing metrics stay null, genuine zero survives, and strings are parsed', () => {
  const items = videoCandidates(fixtures.workList);
  assert.equal(items.length, 2);
  const work = normalizeWork(items[0], AT);
  assert.ok(work);
  assert.deepEqual(work.metrics, { plays: 0, likes: 15, comments: 3, shares: null, collects: null });
  assert.equal(work.publishedAt, '2023-11-14T22:13:20Z');
  assert.equal(work.title, '真实作品标题');
  assert.equal(work.url, 'https://www.douyin.com/video/7412345678901234567');
  assert.equal(work.source, 'douyin-creator-edge');
  assert.equal(normalizeWork(items[1], AT), null);
});

test('approximate, negative and non-finite counts remain unknown', () => {
  for (const value of [true, '1.2万', '', -1, Number.NaN, Number.POSITIVE_INFINITY, {}, null, undefined]) {
    assert.equal(numeric(value), null);
  }
  assert.equal(numeric('0'), 0);
  assert.equal(numeric('10.5'), 10.5);
});

test('timestamps accept seconds, milliseconds and zoned ISO; unzoned strings stay empty', () => {
  assert.equal(timestamp(1700000000000), '2023-11-14T22:13:20Z');
  assert.equal(timestamp('2026-10-22T09:00:00+08:00'), '2026-10-22T01:00:00Z');
  assert.equal(timestamp('2026-10-22T09:00:00'), '');
  assert.equal(timestamp(0), '');
  assert.equal(timestamp('not-a-date'), '');
});

test('nested wrappers are discovered without inventing metrics', () => {
  const items = videoCandidates(fixtures.nestedPayload);
  assert.equal(items.length, 2);
  const work = normalizeWork(items[0], AT);
  assert.ok(work);
  assert.equal(work.id, '456');
  assert.equal(work.title, '嵌套标题');
  assert.equal(work.metrics.plays, 12);
  assert.equal(work.metrics.likes, null);
  assert.equal(normalizeWork(items[1], AT), null);
  assert.deepEqual(videoCandidates({ message: 'ok', data: null }), []);
});

test('merge fills missing metrics without erasing valid counts', () => {
  const first = normalizeWork(fixtures.mergeFirst, AT);
  const next = normalizeWork(fixtures.mergeSecond, AT);
  const second = normalizeWork({ aweme_id: '456' }, AT);
  assert.ok(first && next && second);
  const merged = mergeWorks([first], [next, second], 10);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].metrics.plays, 7);
  assert.equal(merged[0].metrics.likes, 0);
  assert.equal(mergeWorks([], [first, second], 1).length, 1);
});

test('metric aliases and millisecond timestamps follow the collector rules', () => {
  const work = normalizeWork(fixtures.metricVariants, AT);
  assert.ok(work);
  assert.deepEqual(work.metrics, { plays: 0, likes: null, comments: null, shares: null, collects: 4 });
  assert.equal(work.publishedAt, '2023-11-14T22:13:20Z');
});

test('an account needs an explicit name and never guesses from a title', () => {
  assert.deepEqual(accountFromPayload(fixtures.accountPayload), { name: '创作者', id: '123' });
  assert.equal(accountFromPayload({ title: '不能当作账号', uid: '123' }), null);
  assert.equal(accountFromPayload(null), null);
});

test('import validation rejects empty, invalid and metric-less lists with codes', () => {
  assert.throws(() => validateImportedWorks([], { limit: 10, capturedAt: AT }), (error: unknown) => error instanceof DouyinImportError && error.code === 'NO_WORKS');
  assert.throws(() => validateImportedWorks([{ aweme_id: 'bad' }], { limit: 10, capturedAt: AT }), (error: unknown) => error instanceof DouyinImportError && error.code === 'INVALID_ITEMS');
  assert.throws(() => validateImportedWorks([{ aweme_id: '123', desc: '没有指标' }], { limit: 10, capturedAt: AT }), (error: unknown) => error instanceof DouyinImportError && error.code === 'NO_METRICS');
});

test('import validation rebuilds URLs, deduplicates and respects the limit', () => {
  const items = [
    { aweme_id: '123', desc: '第一条', url: 'https://evil.example/123', statistics: { play_count: 5 } },
    { aweme_id: '123', desc: '第一条', statistics: { digg_count: 2 } },
    { aweme_id: '456', desc: '第二条', statistics: { play_count: 0 } },
    { aweme_id: '789', desc: '第三条', statistics: { play_count: 7 } },
  ];
  const result = validateImportedWorks(items, { limit: 2, capturedAt: AT });
  assert.equal(result.rejected, 0);
  assert.equal(result.works.length, 2);
  assert.equal(result.works[0].id, '123');
  assert.equal(result.works[0].url, 'https://www.douyin.com/video/123');
  assert.equal(result.works[0].metrics.plays, 5);
  assert.equal(result.works[0].metrics.likes, 2);
  assert.equal(result.works[1].metrics.plays, 0);
});

test('a genuine zero metric makes the import usable', () => {
  const result = validateImportedWorks([{ aweme_id: '123', statistics: { play_count: 0 } }], { limit: 10, capturedAt: AT });
  assert.equal(result.works.length, 1);
  assert.equal(result.works[0].metrics.plays, 0);
});
