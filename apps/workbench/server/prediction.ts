import { z } from 'zod';
import type { Draft, PredictionBucket, PredictionProposal, Review, Snapshot } from '../shared/types.js';

type PredictionContext = Pick<Snapshot, 'project' | 'works'>;
export function predictionBuckets(baseline: number | null): Omit<PredictionBucket, 'probability'>[] {
  const relative = baseline !== null && Number.isFinite(baseline) && baseline > 0;
  const bounds = relative ? [0, baseline * .3, baseline, baseline * 3, baseline * 10] : [0, 100, 1000, 10000, 100000];
  const labels = relative ? ['退步', '持平', '命中', '小爆', '大爆'] : ['底部', '基础盘', '命中', '小爆', '大爆'];
  return bounds.map((min, index) => ({ id: `bucket-${index + 1}`, label: labels[index], min, max: bounds[index + 1] ?? null }));
}
export function predictionConfidence(samples: number) {
  return samples < 3 ? '极低 · 冷启动，主观概率尚无个人校准证据'
    : samples < 5 ? '偏低 · 少量个人样本，仅作探索判断'
    : samples < 10 ? '中等 · 仍需持续核对实际结果' : '已有个人样本 · 仍需检验校准表现';
}
const shape = z.object({
  headlineBucketId: z.string(), centralEstimate: z.number().finite().nonnegative(), rationale: z.string().min(1),
  probabilities: z.array(z.object({ bucketId: z.string(), probability: z.number().min(0).max(1) })).length(5),
  factors: z.array(z.object({ factor: z.string().min(1), direction: z.enum(['positive', 'negative', 'uncertain']), confidence: z.enum(['high', 'medium', 'low']), reason: z.string().min(1) })).min(1).max(10),
  anchors: z.array(z.object({ workId: z.string(), comparison: z.string().min(1) })).max(4), anchorNote: z.string(),
  counterfactuals: z.array(z.object({ bucketId: z.string(), analysis: z.string().min(1) })).length(5),
  assumptions: z.array(z.string().min(1)).min(1).max(8),
});

/** Reject invented anchors, duplicate/missing buckets and unnormalised probabilities. */
export function makePredictionProposal(draft: Draft, review: Review, context: PredictionContext, raw: unknown): PredictionProposal {
  const parsed = shape.parse(raw);
  const buckets = predictionBuckets(context.project.baselinePlays);
  const ids = new Set(buckets.map(bucket => bucket.id));
  const probabilityIds = parsed.probabilities.map(item => item.bucketId);
  if (new Set(probabilityIds).size !== 5 || probabilityIds.some(id => !ids.has(id)) || Math.abs(parsed.probabilities.reduce((total, item) => total + item.probability, 0) - 1) > .000001) throw new Error('五档概率必须各出现一次，且合计为100%；未生成有效提案。');
  const scenarioIds = parsed.counterfactuals.map(item => item.bucketId);
  if (new Set(scenarioIds).size !== 5 || scenarioIds.some(id => !ids.has(id))) throw new Error('每个概率档都需要对应的反事实场景。');
  const headline = buckets.find(bucket => bucket.id === parsed.headlineBucketId);
  if (!headline || parsed.centralEstimate < headline.min || (headline.max !== null && parsed.centralEstimate >= headline.max)) throw new Error('预测中枢必须位于所选区间内。');
  const chosenProbability = parsed.probabilities.find(item => item.bucketId === headline.id)!.probability;
  if (parsed.probabilities.some(item => item.probability > chosenProbability + .000001)) throw new Error('主预测档必须属于概率最高的档位。');
  const anchors = parsed.anchors.map(item => {
    const work = context.works.find(work => work.id === item.workId);
    if (!work) throw new Error('预测引用了当前材料中不存在的锚点，未保存。');
    return { workId: work.id, title: work.title, comparison: item.comparison };
  });
  if (new Set(anchors.map(item => item.workId)).size !== anchors.length) throw new Error('锚点不可重复。');
  if (!anchors.length && !parsed.anchorNote.trim()) throw new Error('缺少锚点时必须说明N/A原因。');
  const confidence = predictionConfidence(context.project.calibrationSamples);
  const composite = Number((review.dimensions.reduce((sum, dimension) => sum + dimension.score, 0) / 7 * 2).toFixed(2));
  return {
    draftId: draft.id, draftVersion: draft.version, draftHash: review.hash, reviewId: review.id,
    forecast: `${headline.label} · ${headline.min.toLocaleString('zh-CN')}—${headline.max === null ? '以上' : headline.max.toLocaleString('zh-CN')}播放；主观概率 ${(chosenProbability * 100).toFixed(0)}%，中枢 ${parsed.centralEstimate.toLocaleString('zh-CN')}。${confidence}。`,
    rationale: parsed.rationale,
    details: { buckets: buckets.map(bucket => ({ ...bucket, probability: parsed.probabilities.find(item => item.bucketId === bucket.id)!.probability })),
      headlineBucketId: headline.id, centralEstimate: parsed.centralEstimate, composite, confidence,
      baselinePlays: context.project.baselinePlays, calibrationSamples: context.project.calibrationSamples,
      factors: parsed.factors, anchors, anchorNote: parsed.anchorNote,
      counterfactuals: parsed.counterfactuals, assumptions: parsed.assumptions },
  };
}
