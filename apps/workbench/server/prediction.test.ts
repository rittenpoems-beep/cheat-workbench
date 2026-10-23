import test from 'node:test';
import assert from 'node:assert/strict';
import { makePredictionProposal, predictionBuckets } from './prediction.js';
import type { Draft, Review, Snapshot } from '../shared/types.js';
const draft = { id: 'draft-test', version: 2 } as Draft;
const review = { id: 'review-test', hash: 'frozen-hash', dimensions: Array.from({ length: 7 }, () => ({ score: 3 })) } as Review;
const context = { project: { baselinePlays: 500, calibrationSamples: 0 }, works: [{ id: 'work-1', title: '真实存在的参考作品' }] } as Pick<Snapshot, 'project' | 'works'>;
const fixture = () => ({ headlineBucketId: 'bucket-2', centralEstimate: 300, rationale: '检验清晰的方法是否得到更多保存。',
  probabilities: [.2, .4, .25, .1, .05].map((probability, i) => ({ bucketId: `bucket-${i + 1}`, probability })),
  factors: [{ factor: '具体方法', direction: 'positive', confidence: 'medium', reason: '正文给出三个可操作步骤。' }],
  anchors: [{ workId: 'work-1', comparison: '题材相近；没有原稿，不比较评分。' }], anchorNote: '仅作历史表现参考，不冒充已校准样本。',
  counterfactuals: Array.from({ length: 5 }, (_, i) => ({ bucketId: `bucket-${i + 1}`, analysis: '根据对应结果复核假设。' })), assumptions: ['具体方法可带来保存意愿，待验证。'] });
test('buckets use upstream starter ratios, with explicit platform defaults when baseline is absent or zero', () => {
  assert.deepEqual(predictionBuckets(500).map(({ min, max }) => [min, max]), [[0,150],[150,500],[500,1500],[1500,5000],[5000,null]]);
  assert.deepEqual(predictionBuckets(null).map(bucket => bucket.min), [0,100,1000,10000,100000]);
  assert.deepEqual(predictionBuckets(0), predictionBuckets(null));
});
test('proposal preserves real anchors, frozen version, complete evidence and independently computed v0 composite', () => {
  const proposal = makePredictionProposal(draft, review, context, fixture());
  assert.equal(proposal.details.composite, 6); assert.equal(proposal.draftVersion, 2);
  assert.equal(proposal.details.anchors[0].title, '真实存在的参考作品');
  assert.match(proposal.details.confidence, /冷启动/); assert.equal(proposal.details.counterfactuals.length, 5);
});
test('malformed distributions, invented anchors and out-of-bucket estimates fail before any lock', () => {
  const duplicate = fixture(); duplicate.probabilities[0].bucketId = 'bucket-2';
  assert.throws(() => makePredictionProposal(draft, review, context, duplicate), /五档概率/);
  const badTotal = fixture(); badTotal.probabilities[0].probability = .1;
  assert.throws(() => makePredictionProposal(draft, review, context, badTotal), /五档概率/);
  const invented = fixture(); invented.anchors[0].workId = 'invented';
  assert.throws(() => makePredictionProposal(draft, review, context, invented), /不存在的锚点/);
  const wrongPoint = fixture(); wrongPoint.centralEstimate = 500;
  assert.throws(() => makePredictionProposal(draft, review, context, wrongPoint), /中枢/);
  const missingScenario = fixture(); missingScenario.counterfactuals[0].bucketId = 'bucket-2';
  assert.throws(() => makePredictionProposal(draft, review, context, missingScenario), /反事实/);
});
