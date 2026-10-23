import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BLIND_SUBAGENT, blindIsolationViolations, blindPayload, codeBuddyEnvironment, codeBuddyInvocation,
  findCodeBuddy, parseCodeBuddyTranscript, resetCodeBuddyDiscovery, verifyBlindDelegation, CodeBuddyChannel,
} from './channels/codebuddy.js';
import { ModelApiChannel, normalizeBaseUrl } from './channels/model-api.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test('Gate 0 transcript parses the Agent sub-agent call, its result and the combined usage', async () => {
  const transcript = parseCodeBuddyTranscript(await fs.readFile(fixture('codebuddy-blind-transcript.json'), 'utf8'));
  assert.equal(transcript.toolCalls.length, 1);
  assert.equal(transcript.toolCalls[0].name, 'Agent');
  assert.equal(transcript.toolCalls[0].args.subagent_type, BLIND_SUBAGENT);
  assert.equal(transcript.toolCalls[0].args.run_in_background, false);
  assert.equal(transcript.toolResults.length, 1);
  assert.equal(transcript.toolResults[0].status, 'completed');
  assert.ok(transcript.toolResults[0].text.includes('[Agent ID:'));
  assert.equal(transcript.result?.subtype, 'success');
  assert.ok(Number(transcript.result?.usage?.input_tokens) > 0);
  assert.ok(Number(transcript.result?.usage?.output_tokens) > 0);
  assert.equal(transcript.model, 'deepseek-flash');
});

test('transcript parser tolerates a diagnostic line before the JSON array and keeps a trailing result without newline', () => {
  const stdout = `some diagnostic\n${JSON.stringify([{ type: 'result', subtype: 'success', is_error: false, result: '{"ok":true}', usage: { input_tokens: 1 } }])}`;
  assert.deepEqual(parseCodeBuddyTranscript(stdout).result?.usage, { input_tokens: 1 });
});

function transcriptWith(overrides: { calls?: any[]; results?: any[]; text?: string } = {}) {
  return {
    toolCalls: overrides.calls || [{ id: 'call-1', name: 'Agent', args: { subagent_type: BLIND_SUBAGENT, prompt: '', run_in_background: false }, raw: '' }],
    toolResults: overrides.results || [{ callId: 'call-1', name: 'Agent', status: 'completed', text: `${overrides.text ?? '{"summary":"ok"}'}\n\n[Agent ID: agent-1]` }],
    assistantText: '',
  };
}

test('blind verification accepts only one completed Agent call whose prompt carries the full payload', () => {
  const { payload, tokens } = blindPayload('系统协议', '当前稿件');
  const callPrompt = `调度说明（可忽略）\n${payload}`;
  const transcript = transcriptWith();
  transcript.toolCalls[0].args.prompt = callPrompt;
  assert.equal(verifyBlindDelegation(transcript, tokens, payload), '{"summary":"ok"}');
});

test('blind verification rejects extra tools, wrong subagent, background runs, missing payload and failed results', () => {
  const { payload, tokens } = blindPayload('系统协议', '当前稿件');
  const cases: { name: string; transcript: any; code: string }[] = [];
  const withPrompt = (mutate: (transcript: any) => void) => {
    const transcript = transcriptWith();
    transcript.toolCalls[0].args.prompt = payload;
    mutate(transcript);
    return transcript;
  };
  cases.push({ name: 'other tool', transcript: withPrompt(t => t.toolCalls.push({ id: 'call-2', name: 'Bash', args: {}, raw: '' })), code: 'BLIND_TOOL_CALL_DETECTED' });
  cases.push({ name: 'no agent call', transcript: { toolCalls: [], toolResults: [], assistantText: '' }, code: 'BLIND_SUBAGENT_UNVERIFIED' });
  cases.push({ name: 'wrong subagent', transcript: withPrompt(t => { t.toolCalls[0].args.subagent_type = 'general-purpose'; }), code: 'BLIND_SUBAGENT_UNVERIFIED' });
  cases.push({ name: 'background', transcript: withPrompt(t => { t.toolCalls[0].args.run_in_background = true; }), code: 'BLIND_SUBAGENT_UNVERIFIED' });
  cases.push({ name: 'missing token', transcript: withPrompt(t => { t.toolCalls[0].args.prompt = payload.replace(tokens[1], 'REMOVED'); }), code: 'BLIND_SUBAGENT_UNVERIFIED' });
  cases.push({ name: 'truncated', transcript: withPrompt(t => { t.toolCalls[0].args.prompt = payload.slice(0, Math.floor(payload.length * 0.4)); }), code: 'BLIND_SUBAGENT_UNVERIFIED' });
  cases.push({ name: 'no result', transcript: withPrompt(t => { t.toolResults = []; }), code: 'BLIND_SUBAGENT_UNVERIFIED' });
  cases.push({ name: 'failed result', transcript: withPrompt(t => { t.toolResults[0].status = 'failed'; }), code: 'BLIND_SUBAGENT_UNVERIFIED' });
  cases.push({ name: 'empty result', transcript: transcriptWith({ text: '' }), code: 'BLIND_SUBAGENT_UNVERIFIED' });
  for (const item of cases) {
    assert.throws(() => verifyBlindDelegation(item.transcript, tokens, payload), error => {
      assert.equal((error as any).code, item.code, item.name);
      return true;
    });
  }
});

test('blind isolation check flags settings, memory, sessions and a written working directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cheat-blind-isolation-'));
  try {
    const config = path.join(root, 'config'), cwd = path.join(root, 'cwd');
    await fs.mkdir(path.join(config, 'projects'), { recursive: true }); await fs.mkdir(path.join(config, 'sessions'), { recursive: true }); await fs.mkdir(cwd);
    await fs.writeFile(path.join(config, 'user-state.json'), '{"numStartups":1}');
    assert.deepEqual(await blindIsolationViolations(config, cwd), []);
    await fs.writeFile(path.join(config, 'settings.json'), '{}');
    assert.ok((await blindIsolationViolations(config, cwd)).some(item => item.includes('settings.json')));
    await fs.rm(path.join(config, 'settings.json'));
    await fs.mkdir(path.join(config, 'projects', 'x', 'memory'), { recursive: true });
    await fs.writeFile(path.join(config, 'projects', 'x', 'memory', 'notes.md'), 'user memory');
    assert.ok((await blindIsolationViolations(config, cwd)).some(item => item.includes('memory')));
    await fs.rm(path.join(config, 'projects'), { recursive: true, force: true }); await fs.mkdir(path.join(config, 'projects'));
    await fs.writeFile(path.join(config, 'sessions', 'session.jsonl'), '{}');
    assert.ok((await blindIsolationViolations(config, cwd)).some(item => item.includes('sessions')));
    await fs.rm(path.join(config, 'sessions'), { recursive: true, force: true }); await fs.mkdir(path.join(config, 'sessions'));
    await fs.writeFile(path.join(cwd, 'tool-output.txt'), 'written by a tool');
    assert.ok((await blindIsolationViolations(config, cwd)).some(item => item.includes('工作目录')));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('CodeBuddy child environment never inherits unrelated model keys', () => {
  const saved = { deepseek: process.env.DEEPSEEK_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY, workbench: process.env.WORKBENCH_MODEL_API_KEY };
  try {
    process.env.DEEPSEEK_API_KEY = 'sk-should-not-leak'; process.env.ANTHROPIC_API_KEY = 'anthropic-should-not-leak'; process.env.WORKBENCH_MODEL_API_KEY = 'sk-workbench-should-not-leak';
    const env = codeBuddyEnvironment({ configDir: 'C:\\temp\\config', apiKey: 'sk-codebuddy-backend', baseUrl: 'https://api.deepseek.com', blind: true });
    assert.equal(env.DEEPSEEK_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.WORKBENCH_MODEL_API_KEY, undefined);
    assert.equal(env.CODEBUDDY_API_KEY, 'sk-codebuddy-backend');
    assert.equal(env.CODEBUDDY_BASE_URL, 'https://api.deepseek.com');
    assert.equal(env.CODEBUDDY_CONFIG_DIR, 'C:\\temp\\config');
    assert.equal(env.CODEBUDDY_CODE_DISABLE_AUTO_MEMORY, '1');
    assert.equal(env.CODEBUDDY_CODE_DISABLE_SESSION_SUMMARY, '1');
    assert.equal(env.CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS, '1');
  } finally {
    if (saved.deepseek === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = saved.deepseek;
    if (saved.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.anthropic;
    if (saved.workbench === undefined) delete process.env.WORKBENCH_MODEL_API_KEY; else process.env.WORKBENCH_MODEL_API_KEY = saved.workbench;
  }
});

test('a Node-script CodeBuddy launcher is discovered and executed through the current Node runtime', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cheat-codebuddy-discovery-'));
  const saved = process.env.WORKBENCH_CODEBUDDY_CLI;
  try {
    const cli = path.join(root, 'codebuddy');
    await fs.writeFile(cli, '#!/usr/bin/env node\nconsole.log("2.156.0")\n');
    process.env.WORKBENCH_CODEBUDDY_CLI = cli; resetCodeBuddyDiscovery();
    assert.equal(findCodeBuddy(), cli);
    const invocation = codeBuddyInvocation(cli);
    assert.equal(invocation.command, process.execPath);
    assert.deepEqual(invocation.prefix, [cli]);
  } finally {
    if (saved === undefined) delete process.env.WORKBENCH_CODEBUDDY_CLI; else process.env.WORKBENCH_CODEBUDDY_CLI = saved;
    resetCodeBuddyDiscovery();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('blind review refuses to start without the model API backend before spawning anything', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cheat-codebuddy-refuse-'));
  const saved = process.env.WORKBENCH_CODEBUDDY_CLI;
  try {
    const marker = path.join(root, 'spawned.txt');
    const cli = path.join(root, 'codebuddy');
    await fs.writeFile(cli, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'spawned');`);
    process.env.WORKBENCH_CODEBUDDY_CLI = cli; resetCodeBuddyDiscovery();
    for (const options of [
      { auth: 'model-api' as const, apiKey: undefined },
      { auth: 'account' as const, apiKey: 'sk-present-but-account-mode' },
    ]) {
      const channel = new CodeBuddyChannel({ auth: options.auth, apiKey: options.apiKey, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', blindModel: 'deepseek-flash' });
      await assert.rejects(channel.run({ skill: 'cheat-score-blind', system: '系统', prompt: '稿件', blind: true, json: true, progress: () => undefined }), error => {
        assert.equal((error as any).code, 'BLIND_CHANNEL_UNAVAILABLE');
        return true;
      });
    }
    await assert.rejects(fs.access(marker));
  } finally {
    if (saved === undefined) delete process.env.WORKBENCH_CODEBUDDY_CLI; else process.env.WORKBENCH_CODEBUDDY_CLI = saved;
    resetCodeBuddyDiscovery();
    await fs.rm(root, { recursive: true, force: true });
  }
});

function fakeCodeBuddy(root: string, argsFile: string): string {
  const source = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('9.9.9-fake'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
const input = fs.readFileSync(0, 'utf8');
const result = { type: 'result', subtype: 'success', is_error: false, result: '{"summary":"fake"}', usage: { input_tokens: 120, output_tokens: 12 } };
if (args.includes('Agent')) {
  const callId = 'call-fake';
  const entries = [
    { type: 'function_call', name: 'Agent', callId, arguments: JSON.stringify({ subagent_type: 'cheat-blind-reviewer', prompt: input, run_in_background: false }) },
    { type: 'function_call_result', name: 'Agent', callId, status: 'completed', output: { type: 'text', text: '{"summary":"from-child"}\\n\\n[Agent ID: agent-fake]' } },
    result,
  ];
  process.stdout.write(JSON.stringify(entries));
} else {
  process.stdout.write(JSON.stringify([result]));
}
`;
  return source;
}

test('direct CodeBuddy run disables tools, sends the task over stdin and parses the result', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cheat-codebuddy-direct-'));
  const saved = process.env.WORKBENCH_CODEBUDDY_CLI;
  try {
    const cli = path.join(root, 'codebuddy'), argsFile = path.join(root, 'args.json');
    await fs.writeFile(cli, fakeCodeBuddy(root, argsFile));
    process.env.WORKBENCH_CODEBUDDY_CLI = cli; resetCodeBuddyDiscovery();
    const channel = new CodeBuddyChannel({ auth: 'account', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', blindModel: 'deepseek-flash' });
    const result = await channel.run({ skill: 'cheat-seed', system: '系统指令', prompt: '阶段任务', blind: false, json: true, progress: () => undefined });
    assert.equal(result.text, '{"summary":"fake"}');
    assert.deepEqual(result.usage, { input_tokens: 120, output_tokens: 12 });
    assert.equal(result.evidence.mode, 'direct');
    const args = JSON.parse(await fs.readFile(argsFile, 'utf8')) as string[];
    assert.ok(args.includes('-p')); assert.ok(args.includes('--strict-mcp-config')); assert.ok(args.includes('--no-session-persistence'));
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.equal(args[args.indexOf('--model') + 1], 'auto');
    assert.equal(args[args.indexOf('--setting-sources') + 1], 'local');
  } finally {
    if (saved === undefined) delete process.env.WORKBENCH_CODEBUDDY_CLI; else process.env.WORKBENCH_CODEBUDDY_CLI = saved;
    resetCodeBuddyDiscovery();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('blind CodeBuddy run delegates through Agent, verifies the transcript and returns the child text', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cheat-codebuddy-blind-'));
  const saved = process.env.WORKBENCH_CODEBUDDY_CLI;
  try {
    const cli = path.join(root, 'codebuddy'), argsFile = path.join(root, 'args.json');
    await fs.writeFile(cli, fakeCodeBuddy(root, argsFile));
    process.env.WORKBENCH_CODEBUDDY_CLI = cli; resetCodeBuddyDiscovery();
    const channel = new CodeBuddyChannel({ auth: 'model-api', apiKey: 'sk-blind-fake-key', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', blindModel: 'deepseek-flash' });
    const result = await channel.run({ skill: 'cheat-score-blind', system: '纯评分规则', prompt: '当前稿件', blind: true, json: true, progress: () => undefined });
    assert.equal(result.text, '{"summary":"from-child"}');
    assert.equal(result.evidence.mode, 'blind-delegate');
    assert.equal(result.evidence.subagent, BLIND_SUBAGENT);
    assert.equal(result.evidence.toolCallVerified, true);
    assert.equal(result.evidence.freshConfig, true);
    const args = JSON.parse(await fs.readFile(argsFile, 'utf8')) as string[];
    assert.equal(args[args.indexOf('--tools') + 1], 'Agent');
    const agents = JSON.parse(args[args.indexOf('--agents') + 1]);
    assert.equal(agents[BLIND_SUBAGENT].model, 'deepseek-flash');
    assert.deepEqual(agents[BLIND_SUBAGENT].tools, []);
    assert.ok(agents[BLIND_SUBAGENT].disallowedTools.includes('Bash'));
    assert.equal(args[args.indexOf('--model') + 1], 'deepseek-flash');
  } finally {
    if (saved === undefined) delete process.env.WORKBENCH_CODEBUDDY_CLI; else process.env.WORKBENCH_CODEBUDDY_CLI = saved;
    resetCodeBuddyDiscovery();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('model API base URL defaults to HTTPS and refuses private endpoints unless explicitly allowed', () => {
  const saved = process.env.WORKBENCH_ALLOW_PRIVATE_MODEL_ENDPOINT;
  try {
    delete process.env.WORKBENCH_ALLOW_PRIVATE_MODEL_ENDPOINT;
    assert.equal(normalizeBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com');
    assert.throws(() => normalizeBaseUrl('http://127.0.0.1:1234/v1'), /HTTPS|私有|本机/);
    assert.throws(() => normalizeBaseUrl('https://10.0.0.5/v1'), /私有|本机/);
    assert.throws(() => normalizeBaseUrl('https://user:pass@example.com/v1'), /账号|密码/);
    process.env.WORKBENCH_ALLOW_PRIVATE_MODEL_ENDPOINT = '1';
    assert.equal(normalizeBaseUrl('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/v1');
  } finally {
    if (saved === undefined) delete process.env.WORKBENCH_ALLOW_PRIVATE_MODEL_ENDPOINT; else process.env.WORKBENCH_ALLOW_PRIVATE_MODEL_ENDPOINT = saved;
  }
});

test('model API status never exposes the configured key', async () => {
  const channel = new ModelApiChannel({ apiKey: 'sk-model-api-secret', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', kind: 'deepseek' });
  const status = await channel.status();
  assert.ok(!JSON.stringify(status).includes('sk-model-api-secret'));
  assert.equal(status.code, 'ready');
});
