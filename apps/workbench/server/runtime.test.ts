import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Runtime, extractJson, runAgentProcess } from './runtime.js';

const upstreamRoot = fileURLToPath(new URL('../../../', import.meta.url));
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cheat-runtime-test-'));
  const runtime = new Runtime(upstreamRoot, directory);
  await runtime.configure({ provider: 'deepseek', deepseekKey: 'sk-unit-test-key-never-send-to-network', budget: 50 });
  return { directory, runtime, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}

test('structured model responses accept fenced JSON and reject invalid prose', () => {
  assert.deepEqual(extractJson('```json\n{"ok":true}\n```'), { ok: true });
  assert.deepEqual(extractJson('Here is the result:\n{"title":"标题"}'), { title: '标题' });
  assert.throws(() => extractJson('模型未提供任何对象'), /结构化结果/);
});

test('runtime configuration responses and persisted settings do not disclose API key', async () => {
  const { directory, runtime, cleanup } = await fixture();
  try {
    assert.equal(runtime.getSettings().deepseekConfigured, true);
    assert.ok(!JSON.stringify(runtime.getSettings()).includes('sk-unit-test'));
    const persisted = await fs.readFile(path.join(directory, 'settings.json'), 'utf8');
    assert.ok(!persisted.includes('sk-unit-test')); assert.ok(!persisted.includes('deepseekKey'));
    assert.equal(JSON.parse(persisted).provider, 'model-api');
  } finally { await cleanup(); }
});

test('blind review fails closed instead of falling back to the model API or the CodeBuddy login', async () => {
  const { runtime, cleanup } = await fixture();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    await runtime.configure({ codebuddyAuth: 'account' });
    globalThis.fetch = async () => { calls++; throw new Error('盲评不得偷偷调用模型 API'); };
    await assert.rejects(runtime.invoke({ skill: 'cheat-score-blind', blind: true, prompt: '当前稿件：测试输入。\n纯评分规则：仅测试规则。', progress: () => undefined }), error => {
      assert.equal((error as any).code, 'BLIND_CHANNEL_UNAVAILABLE');
      assert.ok((error as Error).message.includes('模型 API'));
      return true;
    });
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; await cleanup(); }
});

test('model API request has a fresh two-message input, no history and no tool definitions', async () => {
  const { ModelApiChannel } = await import('./channels/model-api.js');
  const originalFetch = globalThis.fetch;
  let sent: Record<string, any> = {};
  try {
    globalThis.fetch = async (_url, options) => {
      sent = JSON.parse(String(options?.body));
      return new Response(JSON.stringify({ model: 'fixture-model', choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { status: 200 });
    };
    const channel = new ModelApiChannel({ apiKey: 'sk-unit-test-key-never-send-to-network', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', kind: 'deepseek' });
    const result = await channel.run({ skill: 'cheat-score-blind', system: '独立盲评系统指令', prompt: '当前稿件：测试输入。\n纯评分规则：仅测试规则。', blind: false, json: true, progress: () => undefined });
    assert.deepEqual(JSON.parse(result.text), { ok: true });
    assert.equal(sent.messages.length, 2);
    assert.equal(sent.messages[0].role, 'system'); assert.equal(sent.messages[1].role, 'user');
    assert.equal(sent.messages[1].content, '当前稿件：测试输入。\n纯评分规则：仅测试规则。');
    assert.equal(sent.tools, undefined);
    assert.equal(sent.messages.some((item: { role: string }) => item.role === 'assistant'), false);
    assert.deepEqual(sent.thinking, { type: 'disabled' });
    assert.deepEqual(sent.response_format, { type: 'json_object' });
    assert.equal(result.evidence.mode, 'api');
  } finally { globalThis.fetch = originalFetch; }
});

test('upstream API errors redact the configured key before returning to task log', async () => {
  const { runtime, cleanup } = await fixture();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('invalid token sk-unit-test-key-never-send-to-network', { status: 401 });
    await assert.rejects(runtime.invoke({ skill: 'cheat-seed', prompt: '无模型网络请求测试', progress: () => undefined }), error => {
      assert.ok(error instanceof Error); assert.ok(error.message.includes('401'));
      assert.ok(!error.message.includes('sk-unit-test')); assert.ok(error.message.includes('[REDACTED]'));
      return true;
    });
  } finally { globalThis.fetch = originalFetch; await cleanup(); }
});

test('already-cancelled tasks never issue a model request', async () => {
  const { runtime, cleanup } = await fixture();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; throw new Error('不应进入 fetch'); };
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runtime.invoke({ skill: 'cheat-seed', prompt: '取消任务测试', signal: controller.signal, progress: () => undefined }), /取消/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; await cleanup(); }
});

test('API spending blocks subsequent requests when the configured process budget is exceeded', async () => {
  const { runtime, cleanup } = await fixture();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    await runtime.configure({ budget: 1 });
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }), { status: 200 });
    };
    await runtime.invoke({ skill: 'cheat-seed', prompt: '仅模拟计费', progress: () => undefined });
    await assert.rejects(runtime.invoke({ skill: 'cheat-seed', prompt: '应在网络请求前拒绝', progress: () => undefined }), /预算上限/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; await cleanup(); }
});

test('owner and demo share one budget and serialize charges; only owner can change the shared cap', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cheat-billing-shared-test-'));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    const billing = path.join(root, 'billing');
    const owner = new Runtime(upstreamRoot, path.join(root, 'owner'), false, billing);
    const demo = new Runtime(upstreamRoot, path.join(root, 'demo'), true, billing);
    await owner.configure({ provider: 'deepseek', deepseekKey: 'sk-fake-owner-key', budget: 1 });
    await demo.configure({ provider: 'deepseek', deepseekKey: 'sk-fake-demo-key' });
    assert.equal(demo.getSettings().budget, 1);
    await assert.rejects(demo.configure({ budget: 500 }), /演示空间不能修改/);
    globalThis.fetch = async () => {
      calls++; await new Promise(done => setTimeout(done, 15));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1_000_000 } }), { status: 200 });
    };
    const results = await Promise.allSettled([owner.invoke({ skill: 'cheat-seed', prompt: 'owner fake', progress: () => undefined }), demo.invoke({ skill: 'cheat-seed', prompt: 'demo fake', progress: () => undefined })]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal(calls, 1, 'second space must check the charge from the first space before making a request');
    const ledger = (await fs.readFile(path.join(billing, 'usage.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(ledger.length, 1); assert.equal(ledger[0].estimatedCny, 2);
    assert.ok(!JSON.stringify(ledger).includes('sk-fake'));
    await owner.configure({ budget: 5 });
    assert.equal(demo.getSettings().budget, 5, 'existing demo Runtime sees owner updates immediately');
  } finally { globalThis.fetch = originalFetch; await fs.rm(root, { recursive: true, force: true }); }
});

test('a fresh Node process restores usage and the global budget before issuing requests', async () => {
  const { directory, runtime, cleanup } = await fixture();
  const originalFetch = globalThis.fetch;
  try {
    await runtime.configure({ budget: 1 });
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1_000_000 } }), { status: 200 });
    await runtime.invoke({ skill: 'cheat-seed', prompt: '模拟历史消耗', progress: () => undefined });
    const code = `import { Runtime } from ${JSON.stringify(new URL('./runtime.ts', import.meta.url).href)};
      const runtime = new Runtime(${JSON.stringify(upstreamRoot)}, ${JSON.stringify(directory)});
      await runtime.init(); await runtime.configure({provider:'deepseek',deepseekKey:'sk-restart-fake-key'});
      let calls=0; globalThis.fetch=async()=>{calls++;throw new Error('network must not run')};
      let blocked=false; try {await runtime.invoke({skill:'cheat-seed',prompt:'restart',progress:()=>{}})} catch(error) {blocked=error.message.includes('预算上限')}
      process.stdout.write(JSON.stringify({blocked,calls,budget:runtime.getSettings().budget}));`;
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: process.cwd(), windowsHide: true });
    assert.deepEqual(JSON.parse(result.stdout), { blocked: true, calls: 0, budget: 1 });
  } finally { globalThis.fetch = originalFetch; await cleanup(); }
});

test('legacy owner and demo usage migrates once into the shared ledger and demo cannot restore its old cap', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cheat-billing-migration-test-'));
  try {
    for (const space of ['owner', 'demo']) {
      await fs.mkdir(path.join(root, space));
      await fs.writeFile(path.join(root, space, 'usage.jsonl'), JSON.stringify({ at: '2026-10-22T00:00:00Z', usage: { prompt_tokens: 100_000 }, estimatedCnyAtPeak: 999 }) + '\n');
      await fs.writeFile(path.join(root, space, 'settings.json'), JSON.stringify({ provider: 'deepseek', budget: space === 'owner' ? 3 : 500 }));
    }
    const billing = path.join(root, 'billing');
    const owner = new Runtime(upstreamRoot, path.join(root, 'owner'), false, billing);
    const demo = new Runtime(upstreamRoot, path.join(root, 'demo'), true, billing);
    await owner.init(); await demo.init(); await owner.init(); await demo.init();
    assert.equal(owner.getSettings().budget, 3); assert.equal(demo.getSettings().budget, 3);
    const records = (await fs.readFile(path.join(billing, 'usage.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.length, 2); assert.equal(records.reduce((sum, record) => sum + record.estimatedCny, 0), 0.4);
    assert.deepEqual(new Set(records.map(record => record.space)), new Set(['owner', 'demo']));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('usage returned after cancellation is still charged while the cancelled result is discarded', async () => {
  const { directory, runtime, cleanup } = await fixture();
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  try {
    globalThis.fetch = async () => {
      controller.abort();
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"mustNotReturn":true}' } }], usage: { prompt_tokens: 100_000 } }), { status: 200 });
    };
    await assert.rejects(runtime.invoke({ skill: 'cheat-seed', prompt: '取消发生在服务端完成以后', signal: controller.signal, progress: () => undefined }), /已取消/);
    const records = (await fs.readFile(path.join(directory, 'usage.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.length, 1); assert.equal(records[0].estimatedCny, 0.2);
  } finally { globalThis.fetch = originalFetch; await cleanup(); }
});

test('a cancelled request queued behind another space never spends another API call', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cheat-billing-cancel-test-'));
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let started!: () => void, release!: () => void;
  const firstStarted = new Promise<void>(done => { started = done; });
  const firstReleased = new Promise<void>(done => { release = done; });
  let calls = 0;
  try {
    const owner = new Runtime(upstreamRoot, path.join(root, 'owner'), false, path.join(root, 'billing'));
    const demo = new Runtime(upstreamRoot, path.join(root, 'demo'), true, path.join(root, 'billing'));
    await owner.configure({ provider: 'deepseek', deepseekKey: 'sk-fake-owner', budget: 5 });
    await demo.configure({ provider: 'deepseek', deepseekKey: 'sk-fake-demo' });
    globalThis.fetch = async () => {
      calls++; started(); await firstReleased;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 100 } }), { status: 200 });
    };
    const first = owner.invoke({ skill: 'cheat-seed', prompt: 'first', progress: () => undefined });
    await firstStarted;
    const second = demo.invoke({ skill: 'cheat-seed', prompt: 'second', signal: controller.signal, progress: () => undefined });
    const cancelled = assert.rejects(second, /已取消/);
    controller.abort(); release();
    await first; await cancelled;
    assert.equal(calls, 1);
  } finally { release(); globalThis.fetch = originalFetch; await fs.rm(root, { recursive: true, force: true }); }
});

test('corrupt persisted accounting fails closed instead of resetting paid usage to zero', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cheat-billing-corrupt-test-'));
  try {
    await fs.writeFile(path.join(directory, 'usage.jsonl'), '{"usage": incomplete\n');
    const runtime = new Runtime(upstreamRoot, directory);
    await assert.rejects(runtime.init(), /用量记录无法恢复/);
    assert.equal(await fs.readFile(path.join(directory, 'usage.jsonl'), 'utf8'), '{"usage": incomplete\n');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('CLI event without a final newline is recognized', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cheat-agent-process-test-'));
  try {
    const output = await runAgentProcess(process.execPath, ['-e', "process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'fixture result'}}))"], { provider: 'codex', cwd: directory, environment: process.env, input: '', progress: () => undefined, timeoutMs: 3000 });
    assert.equal(output, 'fixture result');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('cancelled CLI process has exited before rejection allows its working directory to be removed', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cheat-agent-cancel-test-'));
  const controller = new AbortController();
  let pid: number | undefined, descendant: number | undefined;
  try {
    const script = `const fs=require('fs');fs.writeFileSync('pid.txt',String(process.pid));
      require('child_process').spawn(process.execPath,['-e',"require('fs').writeFileSync('descendant-pid.txt',String(process.pid));setInterval(()=>{},1000)"],{stdio:'inherit'});
      const ready=setInterval(()=>{if(fs.existsSync('descendant-pid.txt')){clearInterval(ready);console.log(JSON.stringify({type:'thread.started'}));}},10);
      setInterval(()=>{},1000);`;
    const execution = runAgentProcess(process.execPath, ['-e', script], { provider: 'codex', cwd: directory, environment: process.env, input: '', signal: controller.signal, progress: () => controller.abort(), timeoutMs: 5000 });
    await assert.rejects(execution, /已取消/);
    pid = Number(await fs.readFile(path.join(directory, 'pid.txt'), 'utf8'));
    descendant = Number(await fs.readFile(path.join(directory, 'descendant-pid.txt'), 'utf8'));
    assert.throws(() => process.kill(pid!, 0), 'process must be gone when the caller starts cleaning cwd');
    assert.throws(() => process.kill(descendant!, 0), 'CLI descendants must be gone as well');
    await fs.rm(directory, { recursive: true, force: true });
  } finally { for (const processId of [pid, descendant]) if (processId) { try { process.kill(processId, 'SIGKILL'); } catch {} } await fs.rm(directory, { recursive: true, force: true }); }
});

test('CLI timeout waits for process exit rather than rejecting while it still runs', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cheat-agent-timeout-test-'));
  let pid: number | undefined;
  try {
    const execution = runAgentProcess(process.execPath, ['-e', "require('fs').writeFileSync('pid.txt',String(process.pid));setInterval(()=>{},1000)"], { provider: 'codex', cwd: directory, environment: process.env, input: '', progress: () => undefined, timeoutMs: 350 });
    await assert.rejects(execution, /超过/);
    pid = Number(await fs.readFile(path.join(directory, 'pid.txt'), 'utf8'));
    assert.throws(() => process.kill(pid!, 0));
  } finally { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } await fs.rm(directory, { recursive: true, force: true }); }
});
