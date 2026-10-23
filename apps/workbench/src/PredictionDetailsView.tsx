import { ArrowLeft, ArrowRight, Check, CircleHelp, GitBranch, Link2, ShieldCheck, Target, TrendingDown, TrendingUp } from 'lucide-react';
import type { PredictionDetails } from '../shared/types';

interface Props {
  title: string;
  version: number;
  forecast: string;
  rationale: string;
  details: PredictionDetails;
  proposal: boolean;
  confirmed: boolean;
  stale: boolean;
  busy: boolean;
  onConfirm?: () => void;
  onBack?: () => void;
}

const number = (value: number | null) => value === null ? 'N/A' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
const confidence = (value: string) => ({ high: '高', medium: '中', low: '低' }[value] || value);
const confidenceParts = (value: string) => {
  const [headline, ...rest] = confidence(value).split('·').map(part => part.trim()).filter(Boolean);
  return { headline, note: rest.join(' · ') };
};
const directionNames = { positive: '正向', negative: '负向', uncertain: '待验证' };

export default function PredictionDetailsView({ title, version, forecast, rationale, details, proposal, confirmed, stale, busy, onConfirm, onBack }: Props) {
  const headline = details.buckets.find(bucket => bucket.id === details.headlineBucketId);
  const confidenceValue = confidenceParts(details.confidence);
  return <div className="page prediction-detail-page">
    <div className="prediction-detail-topline">
      <span className="eyebrow">CHEAT ON CONTENT · BEFORE PUBLISH</span>
      {onBack && <button className="text-button" onClick={onBack}><ArrowLeft size={13} />返回稿件</button>}
    </div>
    <div className="prediction-detail-title"><div><h1>{proposal ? '检查你的事前预测' : '已锁定的事前预测'}</h1><p>{title} <span>·</span> 稿件 v{version}</p></div><span className={`badge ${confirmed || !proposal ? 'green' : 'amber'}`}><ShieldCheck size={12} />{confirmed || !proposal ? '已锁定留档' : '提案 · 尚未锁定'}</span></div>
    <div className="prediction-method-note"><CircleHelp size={15} /><p>以下是发布前的<strong>主观概率判断</strong>，用于记录不确定性与事后校准，不代表经过验证的实际爆款率。</p></div>
    <div className="prediction-key-numbers">
      <div><span>主判断桶</span><strong className="headline-bucket">{headline?.label || details.headlineBucketId}</strong><small>本次预测采用的主要区间</small></div>
      <div><span>播放中枢估计</span><strong>{number(details.centralEstimate)}</strong><small>主观估计，非流量承诺</small></div>
      <div><span>预测信心</span><strong>{confidenceValue.headline}</strong><small>{confidenceValue.note || `校准样本 ${details.calibrationSamples} 个`}</small>{confidenceValue.note && <small className="key-stat-foot">校准样本 {details.calibrationSamples} 个</small>}</div>
      <div><span>稿件综合分</span><strong>{number(details.composite)}</strong><small>历史基线 {number(details.baselinePlays)}</small></div>
    </div>
    <section className="card prediction-buckets">
      <div className="card-heading"><div><h2>五桶主观概率</h2><p>把所有可能性摊开，避免只看一个乐观数字。</p></div><span className="badge">合计 {Math.round(details.buckets.reduce((sum, bucket) => sum + bucket.probability, 0) * 100)}%</span></div>
      <div className="bucket-distribution">{details.buckets.map(bucket => <div key={bucket.id} className={`bucket-row ${bucket.id === details.headlineBucketId ? 'headline' : ''}`}><div className="bucket-label"><strong>{bucket.label}</strong><small>{number(bucket.min)}—{bucket.max === null ? '∞' : number(bucket.max)} 播放</small></div><div className="bucket-bar-track"><i style={{ width: `${bucket.probability * 100}%` }} /></div><span className="bucket-probability">{Number((bucket.probability * 100).toFixed(1))}<small>%</small></span>{bucket.id === details.headlineBucketId && <span className="bucket-headline-dot" title="主判断桶" />}</div>)}</div>
      <div className="forecast-statement"><Target size={15} /><p>{forecast}</p></div>
    </section>
    <section className="card prediction-factors"><div className="card-heading"><h2>影响这次判断的因素</h2><GitBranch size={16} /></div><div className="factor-list">{details.factors.map((factor, index) => <div key={index} className={`factor-row ${factor.direction}`}><span className="factor-direction-icon">{factor.direction === 'positive' ? <TrendingUp size={15} /> : factor.direction === 'negative' ? <TrendingDown size={15} /> : <CircleHelp size={15} />}</span><div><strong>{factor.factor}</strong><p>{factor.reason}</p></div><span className={`badge ${factor.direction === 'positive' ? 'green' : factor.direction === 'negative' ? 'amber' : ''}`}>{directionNames[factor.direction]} · {confidence(factor.confidence)}信心</span></div>)}</div></section>
    <div className="prediction-detail-columns">
      <section className="card prediction-anchors"><div className="card-heading"><h2>历史锚点</h2><Link2 size={16} /></div>{details.anchors.length > 0 ? details.anchors.map((anchor, index) => <div className="anchor-item" key={`${anchor.workId}-${index}`}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{anchor.title}</strong><p>{anchor.comparison}</p></div></div>) : <div className="anchor-na"><span>N/A</span><p>没有足够可比的历史锚点。</p></div>}{details.anchorNote && <p className="anchor-note">{details.anchorNote}</p>}</section>
      <section className="card prediction-counterfactuals"><div className="card-heading"><h2>反事实检查</h2><Target size={16} /></div>{details.counterfactuals.map((counterfactual, index) => <div className="counterfactual-item" key={index}><span className="badge">若落入 {details.buckets.find(bucket => bucket.id === counterfactual.bucketId)?.label || counterfactual.bucketId}</span><p>{counterfactual.analysis}</p></div>)}</section>
    </div>
    <section className="card prediction-assumptions"><div className="card-heading"><h2>这份预测成立的假设</h2><CircleHelp size={16} /></div><ol>{details.assumptions.map((assumption, index) => <li key={index}><span>{String(index + 1).padStart(2, '0')}</span>{assumption}</li>)}</ol></section>
    <section className="card prediction-rationale"><div className="card-heading"><h2>综合判断依据</h2></div><p>{rationale}</p></section>
    {proposal && <div className={`prediction-confirmation ${confirmed ? 'confirmed' : ''}`}><div><ShieldCheck size={20} /><p>{confirmed ? '这份预测已经锁定，后续修改稿件不会覆盖原记录。' : stale ? '当前稿件已变化。请回到稿件，针对最终版本重新生成预测提案。' : '确认后将锁定当前提案与稿件版本，保留为事前预测。请先核对以上判断。'}</p></div>{!confirmed && <button className="button primary" disabled={busy || stale} onClick={onConfirm}><Check size={15} />确认这是未发布最终稿并锁定预测<ArrowRight size={14} /></button>}</div>}
  </div>;
}
