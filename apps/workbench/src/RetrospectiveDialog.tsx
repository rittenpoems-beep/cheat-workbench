import { useEffect, useState } from 'react';
import { Activity, Clock3, LoaderCircle, X } from 'lucide-react';
import type { Metrics, Prediction } from '../shared/types';

const metrics: Record<keyof Metrics, string> = { plays: '播放', likes: '点赞', comments: '评论', collects: '收藏', shares: '分享' };
const timestamp = (value?: string) => value ? Date.parse(value) : Number.NaN;
export const hasPublishedRecord = (prediction: Prediction) => Number.isFinite(timestamp(prediction.publishedAt));
const dateTime = (value: number) => Number.isFinite(value) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未登记';
const remainingTime = (milliseconds: number) => {
  const minutes = Math.max(1, Math.ceil(milliseconds / 60000));
  const days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60);
  return `${days ? `${days} 天 ` : ''}${hours ? `${hours} 小时 ` : ''}${minutes % 60 ? `${minutes % 60} 分钟` : ''}`.trim();
};

export default function RetrospectiveDialog({ prediction, onClose, onSubmit }: { prediction: Prediction; onClose: () => void; onSubmit: (actual: Metrics, earlyConfirmed: boolean) => Promise<boolean> }) {
  const [inputs, setInputs] = useState<Record<string, string>>(() => Object.fromEntries(Object.keys(metrics).map(key => [key, String(prediction.actual?.[key as keyof Metrics] ?? '')])));
  const [earlyConfirmed, setEarlyConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30000); return () => window.clearInterval(timer); }, []);
  const published = hasPublishedRecord(prediction);
  const publishedAt = timestamp(prediction.publishedAt);
  const dueAt = Number.isFinite(timestamp(prediction.dueAt)) ? timestamp(prediction.dueAt) : publishedAt + 3 * 86400000;
  const early = published && now < dueAt;
  const values = Object.values(inputs);
  const validMetrics = values.some(value => value !== '') && values.every(value => value === '' || (Number.isFinite(Number(value)) && Number(value) >= 0));
  const submit = async () => {
    if (!published || !validMetrics || (early && !earlyConfirmed)) return;
    setSubmitting(true); setError('');
    try {
      const actual = Object.fromEntries(Object.keys(metrics).map(key => [key, inputs[key] === '' ? null : Number(inputs[key])])) as unknown as Metrics;
      await onSubmit(actual, early && earlyConfirmed);
    } catch (caught) { setError((caught as Error).message); }
    finally { setSubmitting(false); }
  };
  return <div className="modal-backdrop" onClick={() => { if (!submitting) onClose(); }}><div className="modal metrics-modal retrospective-modal" role="dialog" aria-modal="true" aria-labelledby="actual-title" onClick={event => event.stopPropagation()}>
    <button className="modal-close icon-button" aria-label="关闭复盘录入" disabled={submitting} onClick={onClose}><X size={18} /></button>
    <h2 id="actual-title">用真实结果，回应事前判断</h2><p>{prediction.title} · 未取得的数据请留空。</p>
    <div className={`retro-timing ${early ? 'early' : ''}`}><Clock3 size={17} /><div><strong>{!published ? '请先登记发布记录' : early ? `距 T+3 还有 ${remainingTime(dueAt - now)}` : '已满 T+3，可录入成熟实绩'}</strong><span>已发布：{dateTime(publishedAt)}</span>{published && <span>T+3 复盘时间：{dateTime(dueAt)}</span>}</div></div>
    <div className="actual-input-grid">{Object.entries(metrics).map(([key, label]) => <label key={key}>{label}<input type="number" min="0" disabled={submitting || !published} value={inputs[key] || ''} onChange={event => setInputs(values => ({ ...values, [key]: event.target.value }))} placeholder="未获取" /></label>)}</div>
    {early && <label className="early-retro-confirm"><input type="checkbox" checked={earlyConfirmed} disabled={submitting} onChange={event => setEarlyConfirmed(event.target.checked)} /><span>我了解尚未满3天，仍记录早期快照（不计成熟校准样本）</span></label>}
    {prediction.earlyRetro && <p className="retro-previous-snapshot">已有早期快照会保留；满 T+3 后可再次补录成熟实绩。</p>}
    {error && <p className="retro-submit-error" role="alert">{error}</p>}
    <button className="button primary full" disabled={submitting || !published || !validMetrics || (early && !earlyConfirmed)} onClick={() => void submit()}>{submitting ? <LoaderCircle className="spin" size={15} /> : <Activity size={15} />}{early ? '提交早期快照复盘任务' : '提交成熟实绩复盘任务'}</button>
    <p className="retro-submit-note">提交后进入任务中心；任务完成后才会更新复盘记录。</p>
  </div></div>;
}
