import test from 'node:test';
import assert from 'node:assert/strict';
import type { Review, Settings } from '../shared/types.js';
import { activeChannelLabel, blindChip, channelAction, channelCodeLabel, channelName, channelTone, providerIssueAction, resolvedCodeBuddyAuth, reviewChannelLabel } from '../src/modelState.js';

function settings(patch: Partial<Settings> = {}): Settings {
  return {
    provider: 'codebuddy',
    codebuddyAuth: 'auto',
    modelApi: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    budget: 50,
    deepseekConfigured: true,
    codebuddyAvailable: true,
    codexAvailable: false,
    claudeAvailable: false,
    channels: [],
    activeProvider: 'codebuddy',
    activeModel: 'deepseek-flash',
    blind: { mode: 'codebuddy-subagent', subagent: 'cheat-blind-reviewer', ready: true, detail: '子 agent 就绪' },
    ...patch,
  };
}

test('auto auth resolves to the model API only when a key exists', () => {
  assert.equal(resolvedCodeBuddyAuth(settings({ deepseekConfigured: true })), 'model-api');
  assert.equal(resolvedCodeBuddyAuth(settings({ deepseekConfigured: false })), 'account');
  assert.equal(resolvedCodeBuddyAuth(settings({ codebuddyAuth: 'account', deepseekConfigured: true })), 'account');
  assert.equal(resolvedCodeBuddyAuth(settings({ codebuddyAuth: 'model-api', deepseekConfigured: false })), 'model-api');
});

test('the topbar chip names the channel actually running and keeps the fallback issue as a warning', () => {
  assert.deepEqual(activeChannelLabel(settings({ codebuddyAuth: 'account' })), { label: 'CodeBuddy · 本机登录', detail: '主 agent · deepseek-flash', tone: 'ok' });
  assert.deepEqual(activeChannelLabel(settings()), { label: 'CodeBuddy · 模型 API', detail: '主 agent · deepseek-flash', tone: 'ok' });
  assert.equal(activeChannelLabel(settings({ activeProvider: 'model-api' })).label, '模型 API · deepseek-flash');
  assert.equal(activeChannelLabel(settings({ activeProvider: 'none' })).tone, 'amber');
  const fallback = activeChannelLabel(settings({ provider: 'codex', providerIssue: 'Codex CLI 未检测到；本次使用 CodeBuddy。' }));
  assert.equal(fallback.label, 'CodeBuddy · 模型 API');
  assert.equal(fallback.tone, 'amber');
  assert.ok(fallback.detail.includes('Codex CLI 未检测到'));
  assert.equal(activeChannelLabel(settings({ provider: 'claude', activeProvider: 'claude' })).tone, 'amber');
});

test('blind chip reports readiness without offering another channel', () => {
  const ready = blindChip(settings());
  assert.equal(ready.label, '盲评 · 子 agent');
  assert.equal(ready.tone, 'ok');
  const missing = blindChip(settings({ blind: { mode: 'codebuddy-subagent', subagent: 'cheat-blind-reviewer', ready: false, detail: '缺少模型 API Key' } }));
  assert.equal(missing.label, '盲评未就绪');
  assert.equal(missing.tone, 'idle');
  assert.equal(missing.detail, '缺少模型 API Key');
});

test('review labels distinguish the sub-agent blind run from other providers', () => {
  const blind: Review = { id: 'r', draftId: 'd', version: 1, hash: 'h', blind: true, provider: 'codebuddy', model: 'deepseek-flash', mode: 'blind-delegate', dimensions: [], createdAt: '2026-10-23T00:00:00Z', summary: '', suggestions: [] };
  assert.equal(reviewChannelLabel(blind), 'CodeBuddy 子 agent · deepseek-flash');
  assert.equal(reviewChannelLabel({ ...blind, mode: undefined, provider: 'model-api', model: undefined }), 'model-api');
});

test('channel actions map to honest next steps', () => {
  assert.equal(channelCodeLabel('needs-key'), '需要 Key');
  assert.equal(channelTone('ready'), 'ok');
  assert.equal(channelTone('not-installed'), 'idle');
  assert.equal(channelName('qoder'), 'Qoder');
  assert.equal(channelAction({ id: 'qoder', code: 'planned' } as any), '持续开发中');
  assert.equal(channelAction({ id: 'codebuddy', code: 'needs-login' } as any), '完成登录，或改用模型 API');
  assert.equal(channelAction({ id: 'model-api', code: 'needs-key' } as any), '填写 Key');
  assert.equal(channelAction({ id: 'codebuddy', code: 'not-installed' } as any), '检测本机安装');
  assert.equal(providerIssueAction(settings({ provider: 'codex', providerIssue: '不可用' })), '当前选择的执行通道不可用，本次会使用可用的通道执行。');
  assert.equal(providerIssueAction(settings()), '');
});
