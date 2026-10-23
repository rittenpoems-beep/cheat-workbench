import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Workspace } from './workspace.js';
import { InitInputSchema, confidenceFor, localIso, rubricFileFor, safeDirectoryName, sampleId, type InitInput, type InitSample } from '../shared/initialization.js';
import type { Topic } from '../shared/types.js';

const upstreamRoot = fileURLToPath(new URL('../../../', import.meta.url));
async function temporary() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cheat-init-test-'));
  const workspace = new Workspace(root, 'owner', upstreamRoot);
  await workspace.init();
  return { root, workspace, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
function initInput(overrides: Partial<InitInput> = {}): InitInput {
  return {
    confirmed: false, name: '测试工作室', domain: '测试领域', contentForm: 'opinion-video', typicalDurationSeconds: 90, cadenceDays: 2,
    historyMode: 'skip', dataCollection: 'manual', poolStatus: 'none', hooks: false, benchmark: benchmarkInput(),
    ...overrides,
  };
}
function benchmarkInput(overrides: Partial<InitInput['benchmark']> = {}): InitInput['benchmark'] {
  return { mode: 'none', name: '', style: '', platform: '抖音', samples: [], ...overrides };
}
let sampleIndex = 0;
function sample(title: string, extra: Partial<InitSample> = {}): InitSample {
  sampleIndex += 1;
  return { title, plays: 1000 + sampleIndex, likes: 20, comments: 3, shares: 1, impression: 'medium', url: `https://example.com/sample/${sampleIndex}`, transcript: '', ...extra };
}
const topic: Topic = { id: 'topic-1', title: '保留的选题', angle: '具体角度', reason: '测试', sourceUrl: 'https://example.com/topic', sourceTitle: '来源', capturedAt: '2026-10-22T00:00:00Z' };

test('initialization contract follows upstream mappings and rejects incomplete answers', () => {
  assert.equal(confidenceFor(0).label, '🔴 极低');
  assert.equal(confidenceFor(2).label, '🟠 低');
  assert.equal(confidenceFor(3).label, '🟡 偏低');
  assert.equal(confidenceFor(6).label, '🟢 中');
  assert.equal(confidenceFor(11).label, '🟢 较高');
  assert.equal(confidenceFor(21).label, '🔵 高');
  assert.equal(rubricFileFor('mixed'), 'opinion-video-zero.md');
  assert.equal(rubricFileFor('long-essay'), 'long-essay-zero.md');
  assert.equal(localIso(new Date('2026-10-23T10:00:00Z')), '2026-10-23T18:00:00+08:00');
  assert.equal(safeDirectoryName('对标 账号/一'), '对标-账号-一');
  assert.equal(sampleId({ title: '同样标题', url: 'https://example.com/1' }), sampleId({ title: '同样标题', url: 'https://example.com/1' }));
  assert.notEqual(sampleId({ title: '同样标题', url: 'https://example.com/1' }), sampleId({ title: '同样标题', url: 'https://example.com/2' }));

  assert.equal(InitInputSchema.safeParse(initInput({ historyMode: 'import', historyCount: null })).success, false);
  assert.equal(InitInputSchema.safeParse(initInput({ benchmark: benchmarkInput({ mode: 'imported', name: '对标', samples: [sample('只有一条')] }) })).success, false);
  assert.equal(InitInputSchema.safeParse(initInput({ benchmark: benchmarkInput({ mode: 'imported', name: '', samples: [sample('一'), sample('二'), sample('三')] }) })).success, false);
  assert.equal(InitInputSchema.safeParse(initInput({ benchmark: benchmarkInput({ mode: 'imported', name: '对标', samples: [sample('一'), sample('二'), { ...sample('三'), url: 'ftp://example.com/x' }] }) })).success, false);
  assert.equal(InitInputSchema.safeParse(initInput({ contentForm: 'mixed' })).success, true);
});

test('fresh owner initialization writes state last, creates upstream scaffold and keeps raw benchmark samples readable', async () => {
  const { root, workspace, cleanup } = await temporary();
  try {
    const before = await workspace.initStatus();
    assert.equal(before.hasState, true); assert.equal(before.initialized, false); assert.equal(before.bootstrapped, true);
    assert.equal(before.legacy, false); assert.equal(before.hasData, false);

    const samples = [sample('第一条样本', { transcript: '第一条的逐字稿。' }), sample('第二条样本'), sample('第三条样本', { impression: 'high' })];
    const input = InitInputSchema.parse(initInput({
      name: '初始化测试', domain: '教育', contentForm: 'long-essay', typicalDurationSeconds: 240, cadenceDays: 7,
      historyMode: 'import', historyCount: 10, dataCollection: 'adapter', poolStatus: 'markdown',
      benchmark: benchmarkInput({ mode: 'imported', name: '对标 账号/一', style: '冷静', platform: '抖音', samples }),
    }));
    const report = await workspace.initializeProject(input);
    assert.equal(report.rubricFile, 'long-essay-zero.md');
    assert.match(report.initializedAt, /\+08:00$/);
    assert.equal(report.benchmark.status, 'imported'); assert.equal(report.benchmark.sampleCount, 3);
    assert.equal(report.history.status, 'pending'); assert.equal(report.history.requested, 10);
    assert.equal(report.history.platform, 'douyin-creator-edge');
    assert.ok(report.created.some(item => item.startsWith('rubric_notes.md')));

    const state = JSON.parse(await fs.readFile(path.join(root, '.cheat-state.json'), 'utf8'));
    assert.equal(state.content_form, 'long-essay'); assert.equal(state.typical_duration_seconds, 240);
    assert.equal(state.target_publish_cadence_days, 7); assert.equal(state.rubric_form_mismatch, true);
    assert.equal(state.benchmark_status, 'imported'); assert.equal(state.benchmark_name, '对标 账号/一'); assert.equal(state.benchmark_sample_count, 3);
    assert.equal(state.data_collection, 'adapter'); assert.equal(state.pool_status, 'markdown');
    assert.equal(state.hooks_installed, false); assert.deepEqual(state.enabled_perf_adapters, []);
    assert.equal(state.initialized_at, report.initializedAt);
    assert.equal(state.metadata.workbench.init.completedAt, report.initializedAt);
    assert.equal(state.metadata.workbench.init.historyImportStatus, 'pending');
    assert.equal(state.metadata.workbench.init.historySamples, 0);
    assert.equal(state.metadata.workbench.init.historyPlatform, 'douyin-creator-edge');

    assert.equal(await workspace.getRubric(), await fs.readFile(path.join(upstreamRoot, 'starter-rubrics/long-essay-zero.md'), 'utf8'));
    for (const file of ['rubric-memo.md', 'script_patterns.md', 'audience.md', 'WORKFLOW.md', 'STATUS.md', 'benchmark.md']) await workspace.readFile(file);
    const account = safeDirectoryName('对标 账号/一');
    const first = samples[0];
    assert.ok((await workspace.readFile(`samples/${account}/${sampleId(first)}/meta.md`)).includes('第一条样本'));
    assert.ok((await workspace.readFile(`samples/${account}/${sampleId(first)}/transcript.md`)).includes('第一条的逐字稿'));
    await assert.rejects(workspace.readFile('.workbench/settings.json'));
    await assert.rejects(workspace.readFile('.env'));
    await assert.rejects(workspace.readFile('samples/../.cheat-state.json'));

    await assert.rejects(workspace.initializeProject(input), (error: any) => error.code === 'ALREADY_INITIALIZED');
    const after = await workspace.initStatus();
    assert.equal(after.initialized, true); assert.equal(after.benchmarkStatus, 'imported');
    assert.equal(after.contentForm, 'long-essay'); assert.equal(after.rubricFormMismatch, true);
  } finally { await cleanup(); }
});

test('re-initialization preserves works, topics, mature calibration and a measured baseline; history import never becomes calibration', async () => {
  const { root, workspace, cleanup } = await temporary();
  try {
    await workspace.importWorks([
      { id: 'w1', title: '低播放', url: 'https://example.com/w1', publishedAt: '2026-10-01T00:00:00Z', capturedAt: '2026-10-02T00:00:00Z', metrics: { plays: 100, likes: 1, comments: 0, shares: 0, collects: 0 }, source: 'fixture' },
      { id: 'w2', title: '中播放', url: 'https://example.com/w2', publishedAt: '2026-10-03T00:00:00Z', capturedAt: '2026-10-04T00:00:00Z', metrics: { plays: 200, likes: 2, comments: 1, shares: 0, collects: 1 }, source: 'fixture' },
      { id: 'w3', title: '高播放', url: 'https://example.com/w3', publishedAt: '2026-10-05T00:00:00Z', capturedAt: '2026-10-06T00:00:00Z', metrics: { plays: 900, likes: 9, comments: 3, shares: 2, collects: 4 }, source: 'fixture' },
    ]);
    await workspace.setTopics([topic]);
    assert.equal((await workspace.getSnapshotData()).project.baselinePlays, 200);
    const stateFile = path.join(root, '.cheat-state.json');
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    state.calibration_samples = 4; state.calibration_samples_at_last_bump = 0;
    await fs.writeFile(stateFile, JSON.stringify(state, null, 2));

    const report = await workspace.initializeProject(initInput({ name: '保留既有数据' }));
    assert.equal(report.preservedData.works, 3); assert.equal(report.preservedData.topics, 1);
    assert.equal(report.confidence.label, '🟡 偏低');
    const after = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.equal(after.calibration_samples, 4); assert.equal(after.baseline_plays, 200);
    assert.equal(after.data_collection, 'manual');
    assert.deepEqual(after.metadata.workbench.topics.map((item: Topic) => item.id), ['topic-1']);

    await workspace.recordHistoryImport({ status: 'imported', count: 3, baselinePlays: 200 });
    const imported = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.equal(imported.calibration_samples, 4, 'history import must never raise the calibrated sample count');
    assert.equal(imported.data_collection, 'manual', 'history import must not overwrite the chosen data collection mode');
    assert.equal(imported.metadata.workbench.init.historySamples, 3);
    assert.equal(imported.metadata.workbench.init.historyImportStatus, 'imported');
    assert.equal(imported.metadata.workbench.init.historyPlatform, 'douyin-creator-edge');
    const snapshot = await workspace.getSnapshotData();
    assert.equal(snapshot.project.historySamples, 3); assert.equal(snapshot.project.calibrationSamples, 4);
    assert.equal(snapshot.project.baselinePlays, 200);
  } finally { await cleanup(); }
});

test('legacy auto-initialized state is detected as incomplete and completed without losing its data', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cheat-init-legacy-'));
  try {
    const legacy = {
      schema_version: '1.4', initialized_at: '2026-10-01T10:00:00+08:00', calibration_samples: 0, baseline_plays: 2523,
      pending_retros: [], metadata: { workbench: { name: '旧创作空间', topics: [topic], reviews: [], messages: [], publications: [] } },
    };
    await fs.writeFile(path.join(root, '.cheat-state.json'), JSON.stringify(legacy, null, 2));
    const workspace = new Workspace(root, 'owner', upstreamRoot);
    await workspace.init();
    const status = await workspace.initStatus();
    assert.equal(status.hasState, true); assert.equal(status.initialized, false); assert.equal(status.legacy, true);
    assert.equal(status.initializedAt, legacy.initialized_at); assert.equal(status.topics, 1);
    assert.equal(status.hasData, true);
    await assert.rejects(workspace.getRubric(), (error: any) => error.code === 'NOT_INITIALIZED');
    const report = await workspace.initializeProject(initInput({ name: '旧创作空间' }));
    assert.equal(report.preservedData.topics, 1);
    const completed = await workspace.initStatus();
    assert.equal(completed.initialized, true); assert.equal(completed.legacy, false);
    const state = JSON.parse(await fs.readFile(path.join(root, '.cheat-state.json'), 'utf8'));
    assert.equal(state.baseline_plays, 2523); assert.equal(state.metadata.workbench.topics.length, 1);
    assert.match(state.initialized_at, /\+08:00$/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('benchmark analysis replaces only managed qualitative sections and never rewrites rubric_notes.md', async () => {
  const { root, workspace, cleanup } = await temporary();
  try {
    const samples = [sample('第一条样本'), sample('第二条样本'), sample('第三条样本')];
    await workspace.initializeProject(initInput({ benchmark: benchmarkInput({ mode: 'imported', name: '对标号', samples }) }));
    const loaded = await workspace.benchmarkSamples();
    assert.equal(loaded.name, '对标号'); assert.equal(loaded.samples.length, 3);
    assert.ok(loaded.samples.every(item => item.title.endsWith('样本')));
    assert.ok(loaded.samples.every(item => item.meta.includes('对标账号：对标号')));
    const rubric = await workspace.readFile('rubric_notes.md');
    await workspace.recordBenchmarkAnalysis({
      name: '对标号', sampleCount: 3, analyzedAt: '2026-10-23T18:00:00+08:00',
      benchmark: '### 对标账号：对标号 · 2026-10-23（未在本账号验证）\n\n开头直接提出问题。',
      patterns: '### 对标借鉴模式 · 对标号（Imported, untested on my channel）\n\n- 先给问题再给经历。',
      observations: ['问题开头与观看反馈的联系仍待本账号验证。'],
    });
    const benchmark = await workspace.readFile('benchmark.md');
    assert.ok(benchmark.includes('<!-- workbench-benchmark-analysis:start -->'));
    assert.ok(benchmark.includes('开头直接提出问题。'));
    assert.ok(benchmark.includes('| 1 | 第一条样本 |'), 'raw sample table stays intact');
    assert.ok((await workspace.readFile('script_patterns.md')).includes('先给问题再给经历。'));
    const memo = await workspace.readFile('rubric-memo.md');
    assert.ok(memo.includes('### 对标观察 2026-10-23（未校准）'));
    assert.ok(memo.includes('问题开头与观看反馈的联系仍待本账号验证。'));
    assert.equal(await workspace.readFile('rubric_notes.md'), rubric);
    assert.equal((await workspace.getSnapshotData()).project.benchmarkSampleCount, 3);

    await workspace.recordBenchmarkAnalysis({
      name: '对标号', sampleCount: 3, analyzedAt: '2026-10-24T18:00:00+08:00',
      benchmark: '第二次分析。', patterns: '第二次模式。', observations: ['第二次观察。'],
    });
    const replaced = await workspace.readFile('benchmark.md');
    assert.equal(replaced.match(/workbench-benchmark-analysis:start/g)?.length, 1);
    assert.ok(!replaced.includes('开头直接提出问题。')); assert.ok(replaced.includes('第二次分析。'));
    assert.equal(await workspace.readFile('rubric_notes.md'), rubric);
  } finally { await cleanup(); }
});
