import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Workspace } from './workspace.js';
import { analyzeBenchmark } from './benchmark.js';
import type { InitInput, InitSample } from '../shared/initialization.js';
import type { Task } from '../shared/types.js';
import type { Jobs } from './jobs.js';
import type { Runtime } from './runtime.js';

const upstreamRoot = fileURLToPath(new URL('../../../', import.meta.url));
async function temporary() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cheat-benchmark-test-'));
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
let seed = 0;
function sample(title: string): InitSample {
  seed += 1;
  return { title, plays: null, likes: null, comments: null, shares: null, impression: 'medium', url: `https://example.com/benchmark/${seed}`, transcript: '' };
}
const analysis = {
  summary: '开头先提出一个具体问题，再给个人经历。',
  rubricSignals: ['开头先提出一个与观众利益相关的问题。'],
  patterns: ['先给问题，再讲自己的经历。'],
  observations: ['问题开头是否被目标观众识别，仍待本账号复盘验证。'],
  evidence: ['第一条'],
};
function harness(data: unknown, calls: { count: number; prompt?: string; skill?: string } = { count: 0 }) {
  const runtime = {
    invoke: async (request: { skill: string; prompt: string }) => {
      calls.count += 1; calls.prompt = request.prompt; calls.skill = request.skill;
      return { text: JSON.stringify(data), data, provider: 'test-channel' };
    },
  } as unknown as Runtime;
  const jobs = {
    event: () => undefined,
    commit: async (_task: Task, _signal: AbortSignal, operation: () => Promise<unknown>) => operation(),
  } as unknown as Jobs;
  const task = { id: 'benchmark-task' } as Task;
  return { runtime, jobs, task, signal: new AbortController().signal };
}

test('benchmark requires at least three imported samples before calling the model', async () => {
  const { workspace, cleanup } = await temporary();
  try {
    await workspace.initializeProject(initInput());
    const calls = { count: 0 };
    const { runtime, jobs, task, signal } = harness(analysis, calls);
    await assert.rejects(analyzeBenchmark(workspace, runtime, task, jobs, signal), (error: any) => error.code === 'BENCHMARK_SAMPLES_REQUIRED');
    assert.equal(calls.count, 0);
  } finally { await cleanup(); }
});

test('benchmark rejects invented evidence and numeric metric leakage without writing anything', async () => {
  const { root, workspace, cleanup } = await temporary();
  try {
    await workspace.initializeProject(initInput({ benchmark: benchmarkInput({ mode: 'imported', name: '对标号', samples: [sample('第一条样本标题'), sample('第二条样本标题'), sample('第三条样本标题')] }) }));
    const original = await fs.readFile(path.join(root, 'benchmark.md'), 'utf8');
    const invented = harness({ ...analysis, evidence: ['不存在的标题'] });
    await assert.rejects(analyzeBenchmark(workspace, invented.runtime, invented.task, invented.jobs, invented.signal), (error: any) => error.code === 'BENCHMARK_EVIDENCE_NOT_FOUND');
    assert.equal(await fs.readFile(path.join(root, 'benchmark.md'), 'utf8'), original);
    assert.ok(!(await fs.readFile(path.join(root, 'rubric-memo.md'), 'utf8')).includes('workbench-benchmark-observations'));

    const numeric = harness({ ...analysis, rubricSignals: ['前 3 秒必须出现一个问题。'] });
    await assert.rejects(analyzeBenchmark(workspace, numeric.runtime, numeric.task, numeric.jobs, numeric.signal), (error: any) => error.code === 'BENCHMARK_NUMERIC_LEAK');
    assert.equal(await fs.readFile(path.join(root, 'benchmark.md'), 'utf8'), original);

    const percentage = harness({ ...analysis, observations: ['命中率提升 20%。'] });
    await assert.rejects(analyzeBenchmark(workspace, percentage.runtime, percentage.task, percentage.jobs, percentage.signal), (error: any) => error.code === 'BENCHMARK_NUMERIC_LEAK');
    assert.equal(await fs.readFile(path.join(root, 'benchmark.md'), 'utf8'), original);
  } finally { await cleanup(); }
});

test('valid qualitative benchmark analysis is written to the three allowed sections only', async () => {
  const { root, workspace, cleanup } = await temporary();
  try {
    await workspace.initializeProject(initInput({ benchmark: benchmarkInput({ mode: 'imported', name: '对标号', samples: [sample('第一条样本标题'), sample('第二条样本标题'), sample('第三条样本标题')] }) }));
    const rubric = await fs.readFile(path.join(root, 'rubric_notes.md'), 'utf8');
    const calls: { count: number; prompt?: string; skill?: string } = { count: 0 };
    const { runtime, jobs, task, signal } = harness(analysis, calls);
    const result = await analyzeBenchmark(workspace, runtime, task, jobs, signal);
    assert.equal(calls.count, 1); assert.equal(calls.skill, 'cheat-learn-from');
    assert.ok(calls.prompt?.includes('第一条样本标题'));
    assert.ok(calls.prompt?.includes('不预测本账号表现'));
    assert.equal(result.benchmark.sampleCount, 3);
    assert.equal(result.benchmark.signalCount, 1);
    assert.ok((await fs.readFile(path.join(root, 'benchmark.md'), 'utf8')).includes('开头先提出一个具体问题'));
    assert.ok((await fs.readFile(path.join(root, 'script_patterns.md'), 'utf8')).includes('先给问题，再讲自己的经历。'));
    const memo = await fs.readFile(path.join(root, 'rubric-memo.md'), 'utf8');
    assert.ok(memo.includes('未在本账号验证'));
    assert.equal(await fs.readFile(path.join(root, 'rubric_notes.md'), 'utf8'), rubric);
    const state = JSON.parse(await fs.readFile(path.join(root, '.cheat-state.json'), 'utf8'));
    assert.equal(state.benchmark_status, 'imported'); assert.equal(state.benchmark_sample_count, 3);
  } finally { await cleanup(); }
});

test('malformed model output fails before any file is touched', async () => {
  const { root, workspace, cleanup } = await temporary();
  try {
    await workspace.initializeProject(initInput({ benchmark: benchmarkInput({ mode: 'imported', name: '对标号', samples: [sample('第一条样本标题'), sample('第二条样本标题'), sample('第三条样本标题')] }) }));
    const original = await fs.readFile(path.join(root, 'benchmark.md'), 'utf8');
    const broken = harness({ summary: '缺少其余字段' });
    await assert.rejects(analyzeBenchmark(workspace, broken.runtime, broken.task, broken.jobs, broken.signal));
    assert.equal(await fs.readFile(path.join(root, 'benchmark.md'), 'utf8'), original);
    assert.ok(!(await fs.readFile(path.join(root, 'rubric-memo.md'), 'utf8')).includes('workbench-benchmark-observations'));
  } finally { await cleanup(); }
});
