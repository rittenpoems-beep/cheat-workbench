import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Workspace, draftHash } from './workspace.js';
import type { InitInput } from '../shared/initialization.js';
import type { Draft, Prediction, PredictionDetails, Review, Work } from '../shared/types.js';

const upstreamRoot = fileURLToPath(new URL('../../../', import.meta.url));
function initInput(overrides: Partial<InitInput> = {}): InitInput {
  return {
    confirmed: false, name: '测试工作室', domain: '测试领域', contentForm: 'opinion-video', typicalDurationSeconds: 90, cadenceDays: 2,
    historyMode: 'skip', dataCollection: 'manual', poolStatus: 'none', hooks: false,
    benchmark: { mode: 'none', name: '', style: '', platform: '抖音', samples: [] },
    ...overrides,
  };
}
async function temporary(mode: 'owner' | 'demo' = 'owner') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cheat-workspace-test-'));
  const workspace = new Workspace(root, mode, upstreamRoot);
  await workspace.init();
  return { root, workspace, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
function fixtureReview(draft: Draft, id = 'fixture-review'): Review {
  return { id, draftId: draft.id, version: draft.version, hash: draftHash(draft.content), createdAt: new Date().toISOString(),
    dimensions: [{ name: 'HP', score: 3, max: 5, reason: '静态单元测试 fixture，未执行实际评分', quote: draft.content.slice(0, 4) }],
    summary: '静态测试 fixture', suggestions: ['测试记录'], provider: 'unit-test-fixture', blind: true };
}
/** Advance a controlled test clock after legitimate predict -> publish, without editing history. */
async function maturePublication(t: TestContext, workspace: Workspace, prediction: Prediction, url = 'https://www.douyin.com/video/123') {
  const result = await workspace.publish(prediction.draftId, url);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 4 * 86400_000 });
  return result;
}
function fixtureDetails(): PredictionDetails {
  return { buckets: [
    { id: 'retreat', label: '退步', min: 0, max: 30, probability: 0.3 },
    { id: 'flat', label: '持平', min: 30, max: 100, probability: 0.3 },
    { id: 'hit', label: '命中', min: 100, max: 300, probability: 0.2 },
    { id: 'small', label: '小爆', min: 300, max: 1000, probability: 0.15 },
    { id: 'big', label: '大爆', min: 1000, max: null, probability: 0.05 },
  ], headlineBucketId: 'hit', centralEstimate: 180, confidence: '极低：冷启动，概率为探索性记录', composite: 6,
    baselinePlays: 100, calibrationSamples: 0,
    factors: [{ factor: 'HP 开头问题', direction: 'positive', confidence: 'low', reason: '测试原文提供了问题 | 受众反馈尚待验证' }],
    anchors: [], anchorNote: '锚点对比 N/A：没有同类已校准样本，不能用旧作品冒充事前命中。',
    counterfactuals: [
      { bucketId: 'retreat', analysis: '若退步，先检查问题开头是否让目标观众难以识别自己。' },
      { bucketId: 'flat', analysis: '若持平，题材可能只覆盖已有受众，不能推断开头已提升传播。' },
      { bucketId: 'hit', analysis: '若命中，结合完播与评论核对具体问题是否产生共鸣。' },
      { bucketId: 'small', analysis: '若小爆，记录新增分享来源，并检验题材时机的共同影响。' },
      { bucketId: 'big', analysis: '若大爆，当前小样本先验可能遗漏分发事件，需检查外部因素。' },
    ], assumptions: ['相同发布窗口下，具体问题开头与观看反馈存在可继续验证的联系。'] };
}

test('owner begins empty; state and clean rubric use upstream formats', async () => {
  const { root, workspace, cleanup } = await temporary();
  try {
    const snapshot = await workspace.getSnapshotData();
    assert.equal(snapshot.works.length, 0); assert.equal(snapshot.drafts.length, 0); assert.equal(snapshot.predictions.length, 0);
    assert.equal(snapshot.project.baselinePlays, null);
    const state = JSON.parse(await fs.readFile(path.join(root, '.cheat-state.json'), 'utf8'));
    assert.equal(state.schema_version, '1.4'); assert.equal(state.data_layer, 'markdown'); assert.equal(state.initialized_at, null);
    await assert.rejects(workspace.getRubric(), (error: any) => error.code === 'NOT_INITIALIZED');
    const report = await workspace.initializeProject(initInput({ name: '测试工作室', domain: '教育' }));
    assert.equal(report.rubricFile, 'opinion-video-zero.md');
    assert.match(report.initializedAt, /\+08:00$/);
    assert.equal(await workspace.getRubric(), await fs.readFile(path.join(upstreamRoot, 'starter-rubrics/opinion-video-zero.md'), 'utf8'));
    await assert.rejects(workspace.initializeProject(initInput()), (error: any) => error.code === 'ALREADY_INITIALIZED');
    const initialized = JSON.parse(await fs.readFile(path.join(root, '.cheat-state.json'), 'utf8'));
    assert.match(initialized.initialized_at, /\+08:00$/);
    assert.equal(initialized.hooks_installed, false); assert.deepEqual(initialized.enabled_perf_adapters, []);
    assert.equal(initialized.metadata.workbench.init.completedAt, initialized.initialized_at);
    assert.equal((await workspace.getSnapshotData()).project.name, '测试工作室');
    assert.equal((await workspace.getSnapshotData()).project.domain, '教育');
    assert.equal((await workspace.getSnapshotData()).project.configured, true);
    assert.equal((await workspace.getSnapshotData()).project.initialized, true);
  } finally { await cleanup(); }
});

test('draft content roundtrips frontmatter-like input and preserves immutable version snapshots', async () => {
  const { root, workspace, cleanup } = await temporary();
  try {
    const content = '---\ntitle: 用户正文里的 frontmatter\n---\n# 一句话\n\n保留最后换行。\n';
    const first = await workspace.saveDraft({ title: '标题："引号"与换行\n处理', content });
    assert.equal((await workspace.getDraft(first.id)).content, content);
    const original = await workspace.readFile(first.path);
    const second = await workspace.saveDraft({ id: first.id, title: first.title, content: `${content}修改` });
    assert.equal(second.version, 2);
    const snapshots = await fs.readdir(path.join(root, 'scripts/.versions', first.id));
    assert.equal(snapshots.length, 2);
    const v1 = snapshots.find(name => name.startsWith('v1-'))!;
    assert.equal(await fs.readFile(path.join(root, 'scripts/.versions', first.id, v1), 'utf8'), original);
    const unchanged = await workspace.saveDraft({ id: first.id, title: second.title });
    assert.equal(unchanged.version, 2);
    assert.equal((await workspace.getDraft(first.id)).content, second.content);
  } finally { await cleanup(); }
});

test('prediction freezes the scored version; repeated predictions keep original files; retro is append-only', async t => {
  const { root, workspace, cleanup } = await temporary();
  try {
    const draft = await workspace.saveDraft({ title: '独立评审测试', content: '这是冻结稿件的测试内容。' });
    const review = fixtureReview(draft);
    await workspace.saveReview(review);
    const first = await workspace.createPrediction(draft.id, review, '相对基线持平', '需实绩验证');
    const original = await workspace.readFile(first.path);
    const second = await workspace.createPrediction(draft.id, review, '第二次独立记录', '不得覆盖');
    assert.notEqual(first.path, second.path); assert.equal(second.version, 2);
    assert.equal(await workspace.readFile(first.path), original);
    const frozen = (await fs.readdir(path.join(root, 'scripts/.versions', draft.id))).find(name => name.includes(first.id))!;
    const frozenText = await fs.readFile(path.join(root, 'scripts/.versions', draft.id, frozen), 'utf8');
    assert.ok(frozenText.includes(draft.content));
    assert.deepEqual(JSON.parse(await workspace.readFile('.cheat-state.json')).pending_retros, [], 'prediction alone never creates a published retrospective todo');
    await assert.rejects(workspace.retrospective(first.id, { plays: 120 }, '未发布的兄弟预测'), /先登记发布/);
    const published = await maturePublication(t, workspace, second);
    assert.equal((await workspace.getSnapshotData()).drafts[0].stage, 'published');
    await assert.rejects(workspace.createPrediction(draft.id, review, '事后预测', '拒绝'), /不能再写事前盲预测/);
    const registered = await workspace.readFile(published.path);
    await workspace.retrospective(second.id, { plays: 120, likes: null }, '第一轮实际数据');
    const withRetro = await workspace.readFile(second.path);
    assert.ok(withRetro.startsWith(registered));
    await workspace.retrospective(second.id, undefined, '补充观察');
    assert.ok((await workspace.readFile(second.path)).startsWith(withRetro));
    assert.equal(await workspace.readFile(first.path), original, 'unpublished sibling remains untouched');
    const result = (await workspace.getSnapshotData()).predictions.find(item => item.id === second.id)!;
    assert.equal(result.actual?.plays, 120); assert.equal(result.actual?.comments, null);
    assert.equal((await workspace.getSnapshotData()).project.calibrationSamples, 1);
    await workspace.saveDraft({ id: draft.id, title: draft.title, content: '后续改变的稿件。' });
    assert.equal(await fs.readFile(path.join(root, 'scripts/.versions', draft.id, frozen), 'utf8'), frozenText);
    await assert.rejects(workspace.createPrediction(draft.id, review, '旧评分', '拒绝'), /不能再写事前盲预测/);
    assert.equal((await workspace.getSnapshotData()).drafts[0].stage, 'draft');
  } finally { await cleanup(); }
});

test('stale, nonblind or invented-quote reviews are rejected', async () => {
  const { workspace, cleanup } = await temporary();
  try {
    const draft = await workspace.saveDraft({ title: '验证', content: '真实原文。' });
    const review = fixtureReview(draft);
    await assert.rejects(workspace.saveReview({ ...review, blind: false }), /独立盲评/);
    await assert.rejects(workspace.saveReview({ ...review, dimensions: [{ ...review.dimensions[0], quote: '不存在的原文' }] }), /引用无效/);
    await workspace.saveDraft({ id: draft.id, title: draft.title, content: '已改变。' });
    await assert.rejects(workspace.saveReview(review), /稿件已变化/);
    await assert.rejects(workspace.publish(draft.id, 'https://example.com/1'), /正式预测/);
  } finally { await cleanup(); }
});

test('structured prediction details survive restart, render every anatomy component and remain frozen after retro', async t => {
  const { root, workspace, cleanup } = await temporary();
  try {
    const draft = await workspace.saveDraft({ title: '结构化预测', content: '测试原文先提出一个具体问题，再说明自己的观察。' });
    const review = await workspace.saveReview(fixtureReview(draft, 'structured-review'));
    await workspace.importWorks([{ id: 'anchor-work', title: '真实格式的静态测试作品', url: 'https://example.com/fixture/anchor', publishedAt: '2026-10-10T00:00:00Z', capturedAt: '2026-10-22T00:00:00Z', metrics: { plays: 1250, likes: 20, comments: 3, shares: 4, collects: 6 }, source: '静态单元测试 fixture' }]);
    const details = fixtureDetails();
    details.anchors = [{ workId: 'anchor-work', title: '真实格式的静态测试作品', comparison: '同样采用问题开头，但题材不同，仅作为历史参考。' }];
    const expected = structuredClone(details);
    const prediction = await workspace.createPrediction(draft.id, review, '探索性命中桶', '先记录假设，再用实绩核对', details);
    details.buckets[0].probability = 0.01;
    assert.deepEqual(prediction.details, expected, 'caller mutations must not change the frozen proposal');
    const original = await workspace.readFile(prediction.path);
    assert.ok(original.includes('details: {"buckets":'));
    for (const heading of ['输入快照', '预测 v1', '推理因素', '锚点对比', '反事实场景（复盘用）', '关键校准假设', '复盘']) assert.ok(original.includes(`\n## ${heading}\n`), `${heading} is required`);
    assert.ok(original.includes('**Bucket**: `命中`'));
    assert.ok(original.includes('**中枢**: 180 播放'));
    assert.ok(original.includes('composite=**6.00**'));
    for (const bucket of expected.buckets) assert.ok(original.includes(`\`${bucket.label}\` → ${bucket.probability * 100}%`));
    for (const scenario of expected.counterfactuals) assert.ok(original.includes(scenario.analysis));
    assert.ok(original.includes(expected.assumptions[0]));
    assert.ok(original.includes('1250 | 同样采用问题开头'));
    assert.ok(original.includes('问题 \\| 受众反馈'));
    assert.ok(original.includes('**Scored By**: independent-review:unit-test-fixture'));
    assert.ok(original.includes('**User Override**: none'));
    const disagreement = JSON.parse(original.match(/^\*\*BlindScore Disagreement\*\*: (.+)$/m)![1]);
    assert.deepEqual(disagreement, [{ dim: 'HP', blind: 3, self: null, delta: null, decided_as: 3 }]);
    assert.ok(original.includes('主对话未另行自评分'));
    const restarted = new Workspace(root, 'owner', upstreamRoot); await restarted.init();
    assert.deepEqual((await restarted.getSnapshotData()).predictions.find(item => item.id === prediction.id)?.details, expected);
    await maturePublication(t, restarted, prediction, 'https://example.com/fixture/new-work');
    const registered = await restarted.readFile(prediction.path);
    const chapters = (text: string) => text.slice(text.search(/^## /m));
    assert.equal(chapters(registered), chapters(original), 'publication only adds metadata ahead of the first chapter');
    await restarted.retrospective(prediction.id, { plays: 240 }, '回填一份静态测试指标，不更改事前判断。');
    const appended = await restarted.readFile(prediction.path);
    assert.ok(appended.startsWith(registered));
    assert.equal(chapters(appended).split('\n## 复盘\n')[0], chapters(original).split('\n## 复盘\n')[0]);
    assert.deepEqual((await restarted.getSnapshotData()).predictions.find(item => item.id === prediction.id)?.details, expected);
  } finally { await cleanup(); }
});

test('structured predictions with insufficient anchors keep the specific N/A note; invalid probability plans are not frozen', async () => {
  const { root, workspace, cleanup } = await temporary();
  try {
    const draft = await workspace.saveDraft({ title: '缺锚点记录', content: '测试原文有稿件，但没有足够同类已校准作品。' });
    const review = await workspace.saveReview(fixtureReview(draft, 'no-anchor-review'));
    const invalid = fixtureDetails(); invalid.buckets[0].probability = 0.29;
    await assert.rejects(workspace.createPrediction(draft.id, review, '不应落盘', '概率缺失', invalid), /合计必须为 100%/);
    assert.equal((await workspace.getSnapshotData()).predictions.length, 0);
    assert.equal((await fs.readdir(path.join(root, 'scripts/.versions', draft.id))).length, 1, 'bad plans must not create a frozen prediction snapshot');
    const missingScenario = fixtureDetails(); missingScenario.counterfactuals.pop();
    await assert.rejects(workspace.createPrediction(draft.id, review, '不应落盘', '缺逐桶场景', missingScenario), /五个概率桶/);
    const valid = fixtureDetails();
    const saved = await workspace.createPrediction(draft.id, review, '冷启动探索', '无可比样本', valid);
    assert.ok((await workspace.readFile(saved.path)).includes(`## 锚点对比\n\n${valid.anchorNote}`));
  } finally { await cleanup(); }
});

test('legacy predictions without details remain readable and are never rewritten on initialization', async () => {
  const { root, workspace, cleanup } = await temporary();
  try {
    const legacy = '# 原始旧记录 — 预测日志\n\n**Article ID**: legacy-draft\n**Title**: 原始旧记录\n**预测时间**: 2026-10-10\n**Script Hash**: sha256:legacyhash\n\n## 预测\n\n**Bucket**: 100-1000\n\n旧格式预测保留原样。\n\n## 复盘\n\n（待填）\n';
    const legacyPath = 'predictions/2026-10-10_legacy.md';
    await fs.writeFile(path.join(root, legacyPath), legacy);
    const restarted = new Workspace(root, 'owner', upstreamRoot); await restarted.init();
    const old = (await restarted.getSnapshotData()).predictions.find(item => item.path === legacyPath)!;
    assert.equal(old.details, undefined); assert.equal(old.title, '原始旧记录'); assert.ok(old.forecast.includes('旧格式预测保留原样'));
    assert.equal(await restarted.readFile(legacyPath), legacy);
    const draft = await workspace.saveDraft({ title: '旧四参数调用', content: '测试原文保持旧调用接口兼容。' });
    const review = await workspace.saveReview(fixtureReview(draft, 'four-argument-review'));
    const compatible = await workspace.createPrediction(draft.id, review, '兼容预测', '未提供details');
    assert.equal(compatible.details, undefined);
    assert.equal((await restarted.getSnapshotData()).predictions.find(item => item.id === compatible.id)?.details, undefined);
    assert.equal(await restarted.readFile(legacyPath), legacy);
  } finally { await cleanup(); }
});

test('calibration requires valid plays and a real pre-publish blind prediction; duplicate retros count once', async t => {
  const { root, workspace, cleanup } = await temporary();
  try {
    const draft = await workspace.saveDraft({ title: '校准资格', content: '校准必须有真实播放数据，缺失不能填成零。' });
    const review = await workspace.saveReview(fixtureReview(draft, 'calibration-review'));
    const prediction = await workspace.createPrediction(draft.id, review, '探索性记录', '等待真实发布和实绩');
    await maturePublication(t, workspace, prediction, 'https://www.douyin.com/video/calibration');
    const original = await workspace.readFile(prediction.path);
    await workspace.retrospective(prediction.id, { plays: null, likes: 4 }, '只有点赞，不足以校准播放预测');
    assert.equal((await workspace.getSnapshotData()).project.calibrationSamples, 0);
    await workspace.retrospective(prediction.id, undefined, '只是文字观察');
    assert.equal((await workspace.getSnapshotData()).project.calibrationSamples, 0);
    await workspace.retrospective(prediction.id, { plays: 0 }, '实际取得零播放，零是有效值');
    assert.equal((await workspace.getSnapshotData()).project.calibrationSamples, 1);
    const afterValid = await workspace.readFile(prediction.path);
    assert.ok(afterValid.startsWith(original));
    await workspace.retrospective(prediction.id, { plays: 250, likes: 11 }, '下一次采集更新指标，不是第二份独立样本');
    assert.equal((await workspace.getSnapshotData()).project.calibrationSamples, 1);
    await workspace.retrospective(prediction.id, { plays: null, comments: 8 }, '只补评论，不清除先前有效实绩');
    assert.equal((await workspace.getSnapshotData()).project.calibrationSamples, 1);
    assert.ok((await workspace.readFile(prediction.path)).startsWith(afterValid));
    const restarted = new Workspace(root, 'owner', upstreamRoot); await restarted.init();
    assert.equal((await restarted.getSnapshotData()).project.calibrationSamples, 1);

    const late = await workspace.saveDraft({ title: '事后补登记', content: '已经发布的旧文即使有数据也不能当事前预测。' });
    const lateReview = await workspace.saveReview(fixtureReview(late, 'late-review'));
    const latePrediction = await workspace.createPrediction(late.id, lateReview, '不计校准', '发布日期早于预测');
    await assert.rejects(workspace.publish(late.id, 'https://www.douyin.com/video/late', new Date(Date.now() - 4 * 86400_000).toISOString()), /早于事前预测/);
    await assert.rejects(workspace.retrospective(latePrediction.id, { plays: 999 }, '不把未发布的预测伪装成校准样本'), /先登记发布/);
    assert.equal((await workspace.getSnapshotData()).project.calibrationSamples, 1);
  } finally { await cleanup(); }
});

test('publish preserves every prediction chapter and registers upstream metadata, a frozen fallback video and path todos', async () => {
  const { root, workspace, cleanup } = await temporary();
  try {
    const draft = await workspace.saveDraft({ title: '发布契约', content: '这份测试原文必须和发布时保存的冻结稿完全相同。' });
    const review = await workspace.saveReview(fixtureReview(draft, 'publish-contract-review'));
    const prediction = await workspace.createPrediction(draft.id, review, '测试预测', '只测试文件契约');
    const original = await workspace.readFile(prediction.path);
    await assert.rejects(workspace.publish(draft.id, 'https://www.douyin.com/video/123456', new Date(Date.now() + 10000).toISOString()), /晚于当前时间/);
    const published = await workspace.publish(draft.id, 'https://www.douyin.com/video/123456');
    const registered = await workspace.readFile(prediction.path);
    assert.equal(registered.slice(registered.search(/^## /m)), original.slice(original.search(/^## /m)));
    const header = registered.slice(0, registered.search(/^## /m));
    for (const field of ['Published at', 'Platform', 'URL', 'Video Folder', 'Aweme ID', 'ad_hoc_publish']) assert.ok(header.includes(`**${field}**:`));
    assert.match(header, /\*\*Aweme ID\*\*: 123456/);
    const state = JSON.parse(await workspace.readFile('.cheat-state.json'));
    assert.deepEqual(state.pending_retros, [prediction.path]);
    assert.equal(state.last_published_platform_id, '123456');
    assert.equal(state.last_published_video_folder, `videos/${prediction.id}/`);
    assert.equal(state.metadata.workbench.retroSchedule[prediction.path].predictionId, prediction.id);
    assert.equal(state.metadata.workbench.retroSchedule[prediction.path].dueAt, published.dueAt);
    const fallback = await fs.readFile(path.join(root, `videos/${prediction.id}/script.md`), 'utf8');
    assert.equal(fallback, await fs.readFile(path.join(root, `scripts/.versions/${draft.id}/prediction-${prediction.id}.md`), 'utf8'));
    assert.match(await fs.readFile(path.join(root, `videos/${prediction.id}/publish.md`), 'utf8'), /ad_hoc_publish\*\*: true/);
    await assert.rejects(workspace.publish(draft.id, 'https://www.douyin.com/video/999'), /已登记发布/);
    const restarted = new Workspace(root, 'owner', upstreamRoot); await restarted.init();
    assert.equal((await restarted.getRetroEligibility(prediction.id)).published, true);
    assert.equal((await restarted.getSnapshotData()).predictions.find(item => item.id === prediction.id)?.publishedAt, published.publishedAt);
  } finally { await cleanup(); }
});

test('old object todos migrate once to upstream paths while every original field remains recoverable', async () => {
  const { root, workspace, cleanup } = await temporary();
  try {
    const filename = path.join(root, '.cheat-state.json');
    const state = JSON.parse(await fs.readFile(filename, 'utf8'));
    const old = { file: 'predictions/old.md', prediction_id: 'old-id', draft_id: 'old-draft', due_at: null, unknown_extra: { preserve: true } };
    const unknown = { future_shape: ['preserve', 7] };
    state.pending_retros = ['predictions/original-upstream.md', old, unknown];
    state.unrelated = { untouched: [1, 2] }; state.metadata.external = 'keep';
    await fs.writeFile(filename, JSON.stringify(state));
    const restarted = new Workspace(root, 'owner', upstreamRoot); await restarted.init();
    const migrated = JSON.parse(await restarted.readFile('.cheat-state.json'));
    assert.deepEqual(migrated.pending_retros, ['predictions/original-upstream.md', 'predictions/old.md']);
    assert.deepEqual(migrated.metadata.workbench.legacyPendingRetros, [old, unknown]);
    assert.deepEqual(migrated.metadata.workbench.retroSchedule['predictions/old.md'].unknown_extra, old.unknown_extra);
    assert.deepEqual(migrated.unrelated, state.unrelated); assert.equal(migrated.metadata.external, 'keep');
    const second = new Workspace(root, 'owner', upstreamRoot); await second.init();
    assert.deepEqual(JSON.parse(await second.readFile('.cheat-state.json')), migrated);
  } finally { await cleanup(); }
});

test('unpublished and unconfirmed early retros fail; approved early observations preserve the mature todo and cannot calibrate', async t => {
  const { root, workspace, cleanup } = await temporary();
  try {
    await workspace.initializeProject(initInput());
    const draft = await workspace.saveDraft({ title: '早期观察', content: '早期快照也保留证据，但不冒充成熟的复盘样本。' });
    const review = await workspace.saveReview(fixtureReview(draft, 'early-review'));
    const prediction = await workspace.createPrediction(draft.id, review, '探索性判断', '等待 T+3', fixtureDetails());
    assert.deepEqual(await workspace.getRetroEligibility(prediction.id), { published: false, publishedAt: null, dueAt: null, early: false });
    await assert.rejects(workspace.retrospective(prediction.id, { plays: 12 }, '不能复盘未发布稿', { earlyConfirmed: true }), /先登记发布/);
    await workspace.publish(draft.id, 'https://v.douyin.com/fixture/');
    const registered = await workspace.readFile(prediction.path);
    const rubric = await workspace.getRubric();
    const eligibility = await workspace.getRetroEligibility(prediction.id);
    assert.equal(eligibility.early, true); assert.equal(eligibility.published, true);
    await assert.rejects(workspace.retrospective(prediction.id, { plays: 12 }, '没有明确确认'), /明确确认早期复盘/);
    assert.equal(await workspace.readFile(prediction.path), registered);
    await assert.rejects(workspace.retrospective(prediction.id, { plays: 12 }, '伪造未来快照', { earlyConfirmed: true, measuredAt: new Date(Date.now() + 86400_000).toISOString() }), /采集时间必须有效/);
    await workspace.retrospective(prediction.id, { plays: 12 }, '头两小时的观察', { earlyConfirmed: true, observations: ['开头问题是否被识别，仍待成熟数据检验。'] });
    let snapshot = await workspace.getSnapshotData();
    assert.equal(snapshot.project.calibrationSamples, 0); assert.equal(snapshot.project.baselinePlays, null);
    assert.equal(snapshot.predictions.find(item => item.id === prediction.id)?.status, 'published');
    assert.equal(snapshot.predictions.find(item => item.id === prediction.id)?.earlyRetro, true);
    let state = JSON.parse(await workspace.readFile('.cheat-state.json'));
    assert.equal(state.early_retro, true); assert.deepEqual(state.pending_retros, [prediction.path]);
    assert.match(await workspace.readFile('rubric-memo.md'), /早期观察，待 T\+3 验证/);
    assert.equal(await workspace.getRubric(), rubric, 'actual evidence never contaminates blind scoring rules');
    const early = await workspace.readFile(prediction.path);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 4 * 86400_000 });
    assert.equal((await workspace.getRetroEligibility(prediction.id)).early, false);
    await workspace.retrospective(prediction.id, { plays: 700 }, '成熟快照', { observations: ['实际高于原预测中枢，原因仍需进一步验证。'] });
    snapshot = await workspace.getSnapshotData(); state = JSON.parse(await workspace.readFile('.cheat-state.json'));
    assert.equal(snapshot.project.calibrationSamples, 1); assert.equal(snapshot.project.baselinePlays, 700);
    assert.deepEqual(state.pending_retros, []); assert.equal(state.early_retro, false);
    assert.deepEqual(state.consecutive_directional_errors, ['low']);
    assert.ok((await workspace.readFile(prediction.path)).startsWith(early));
    assert.ok((await workspace.readFile('rubric-memo.md')).includes('实际高于原预测中枢'));
    await workspace.retrospective(prediction.id, { plays: 750 }, '追加同一作品的后续快照');
    assert.deepEqual(JSON.parse(await workspace.readFile('.cheat-state.json')).consecutive_directional_errors, ['low'], 'a repeated capture cannot create a second independent directional error');
    assert.equal(await workspace.getRubric(), rubric);
  } finally { await cleanup(); }
});

test('legacy published headers are recognized without workbench publication metadata and memo insertion preserves later sections', async () => {
  const { root, workspace, cleanup } = await temporary();
  try {
    const filename = 'predictions/legacy-published.md';
    await fs.writeFile(path.join(root, filename), '# 原上游发布记录\n\n**Article ID**: legacy\n**Published at**: 2026-10-01T00:00:00Z\n**Platform**: douyin\n**URL**: https://www.douyin.com/video/1\n\n## 预测\n\n原样保留。\n\n## 复盘\n\n');
    await fs.writeFile(path.join(root, 'rubric-memo.md'), '# 证据\n\n## 观察记录\n\n旧观察。\n\n## 规律沉淀区\n\n保留后续所有内容。\n');
    const eligibility = await workspace.getRetroEligibility('legacy-published');
    assert.equal(eligibility.published, true); assert.equal(eligibility.early, false);
    await workspace.retrospective('legacy-published', { plays: 200 }, '旧格式的新观察', { observations: ['不能伪造旧记录没有的独立评分。'] });
    const memo = await workspace.readFile('rubric-memo.md');
    assert.ok(memo.indexOf('不能伪造旧记录') < memo.indexOf('## 规律沉淀区'));
    assert.ok(memo.endsWith('## 规律沉淀区\n\n保留后续所有内容。\n'));
    assert.equal((await workspace.getSnapshotData()).project.calibrationSamples, 0, 'legacy evidence without a verified blind review never becomes a calibration sample');
  } finally { await cleanup(); }
});

test('file reader blocks traversal, secrets and symlink escape, permits actual Chinese Cheat paths', async () => {
  const { root, workspace, cleanup } = await temporary();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cheat-outside-test-'));
  try {
    await fs.writeFile(path.join(root, '.env'), 'SECRET=test-never-disclose');
    await fs.writeFile(path.join(root, 'scripts', '2026-10-22_abc_中文稿.md'), '# 中文稿\n\n直接来自上游文件');
    assert.ok((await workspace.readFile('scripts/2026-10-22_abc_中文稿.md')).includes('直接来自'));
    for (const input of ['.env', '../.env', 'scripts/../../.env', 'C:\\Windows\\win.ini', 'scripts/..\\.env', '.auth/cookies.json', 'scripts/secret.json']) {
      await assert.rejects(workspace.readFile(input));
    }
    await fs.writeFile(path.join(outside, 'report.md'), 'outside-secret');
    await fs.symlink(outside, path.join(root, 'videos', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(workspace.readFile('videos/escape/report.md'), /工作空间外/);
  } finally { await cleanup(); await fs.rm(outside, { recursive: true, force: true }); }
});

test('works persist as upstream report.md, retain missing values and previous captures, rebuild from disk', async () => {
  const { root, workspace, cleanup } = await temporary();
  try {
    const work: Work = { id: '12345', title: '真实格式测试', url: 'https://www.douyin.com/video/12345', publishedAt: '2026-10-21T01:00:00Z',
      capturedAt: '2026-10-22T01:00:00Z', source: 'test-fixture', metrics: { plays: null, likes: 0, comments: 1, shares: null, collects: 2 } };
    await workspace.importWorks([work]);
    assert.ok((await workspace.readFile('videos/12345/report.md')).includes('- 播放：未获取'));
    const restarted = new Workspace(root, 'owner', upstreamRoot); await restarted.init();
    assert.deepEqual((await restarted.getSnapshotData()).works[0].metrics, work.metrics);
    await restarted.importWorks([{ ...work, capturedAt: '2026-10-22T02:00:00Z', metrics: { ...work.metrics, plays: 800 } }]);
    assert.equal((await restarted.getSnapshotData()).works.length, 1);
    assert.equal((await fs.readdir(path.join(root, 'videos/12345/snapshots'))).length, 1);
    assert.equal((await restarted.getSnapshotData()).project.baselinePlays, 800);
    await fs.mkdir(path.join(root, 'videos/legacy'));
    await fs.writeFile(path.join(root, 'videos/legacy/report.md'), '# 上游原始报告\n\n- 视频 ID：`98765`\n- 发布时间：2026-10-20 11:20\n- 链接：https://www.douyin.com/video/98765\n\n## 播放数据\n\n- 播放：1.2w\n- 点赞：0\n- 评论：-\n- 分享：5\n- 收藏：12\n');
    const legacy = (await restarted.getSnapshotData()).works.find(item => item.id === '98765')!;
    assert.equal(legacy.metrics.plays, 12000); assert.equal(legacy.metrics.likes, 0); assert.equal(legacy.metrics.comments, null);
  } finally { await cleanup(); }
});

test('concurrent additive operations do not drop messages or versions', async () => {
  const { workspace, cleanup } = await temporary();
  try {
    await Promise.all(Array.from({ length: 8 }, (_, index) => workspace.addMessage('user', `消息 ${index}`)));
    assert.equal((await workspace.getSnapshotData()).messages.length, 8);
    const draft = await workspace.saveDraft({ title: '并发稿件', content: '版本一' });
    await Promise.all([workspace.saveDraft({ id: draft.id, title: draft.title, content: '版本二' }), workspace.saveDraft({ id: draft.id, title: draft.title, content: '版本三' })]);
    assert.equal((await workspace.getDraft(draft.id)).version, 3);
  } finally { await cleanup(); }
});

test('demo is isolated, marked simulated and restart-safe', async () => {
  const { root, workspace, cleanup } = await temporary('demo');
  const owner = await temporary('owner');
  try {
    const demo = await workspace.getSnapshotData();
    assert.equal(demo.works.length, 6); assert.equal(demo.drafts.length, 2); assert.equal(demo.predictions.length, 1);
    assert.ok(demo.works.every(item => item.source.includes('虚构')));
    assert.ok(demo.drafts.every(item => item.content.includes('虚构')));
    assert.equal(demo.project.calibrationSamples, 0);
    assert.equal(JSON.parse(await workspace.getContext()).works.length, 6);
    assert.equal(JSON.parse(await workspace.getContext({ workIds: [] })).works.length, 0);
    const selectedContext = JSON.parse(await workspace.getContext({ workIds: [demo.works[0].id] }));
    assert.equal(selectedContext.works.length, 1);
    assert.equal(selectedContext.works[0].title, demo.works[0].title);
    const restarted = new Workspace(root, 'demo', upstreamRoot); await restarted.init();
    assert.equal((await restarted.getSnapshotData()).works.length, 6);
    assert.equal((await owner.workspace.getSnapshotData()).works.length, 0);
    assert.equal((await owner.workspace.getSnapshotData()).drafts.length, 0);
  } finally { await cleanup(); await owner.cleanup(); }
});
