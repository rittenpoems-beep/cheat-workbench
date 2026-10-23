import test from 'node:test';
import assert from 'node:assert/strict';
import { browserTaskResult, edgeChipState, isActiveTask, phaseLabel, shouldOpenSession, syncErrorHint } from '../src/browserState.js';
import type { BrowserStatus } from '../shared/browser.js';
import type { Task } from '../shared/types.js';

const status = (patch: Partial<BrowserStatus> = {}): BrowserStatus => ({
  connected: true,
  browserName: 'Microsoft Edge',
  version: '0.1.0',
  lastSeenAt: new Date().toISOString(),
  pairingRequired: false,
  account: { name: '测试账号', id: 'test-uid' },
  lastSyncAt: null,
  extensionPath: 'C:\\workbench\\browser-extension',
  protocol: 1,
  ...patch,
});

const task = (patch: Partial<Task> = {}): Task => ({
  id: 'task-1', kind: 'sync', label: '同步抖音作品', status: 'running',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [],
  result: { transport: 'browser', phase: 'capturing', limit: 10, count: 3 },
  ...patch,
});

test('connection states map to an actionable chip', () => {
  assert.equal(edgeChipState(undefined).label, '连接 Edge');
  assert.equal(edgeChipState(status({ pairingRequired: true, connected: false, account: null })).action, 'setup');
  assert.equal(edgeChipState(status({ connected: false })).label, 'Edge 未响应');
  assert.equal(edgeChipState(status({ account: null })).label, 'Edge 已连接');
  assert.equal(edgeChipState(status()).label, 'Edge · 测试账号');
  assert.equal(edgeChipState(status()).tone, 'ok');
});

test('a running sync shows phase and progress instead of connection status', () => {
  const chip = edgeChipState(status(), task());
  assert.equal(chip.action, 'session');
  assert.equal(chip.busy, true);
  assert.match(chip.label, /3\/10/);
  assert.equal(edgeChipState(status(), task({ status: 'cancelling' })).tone, 'warn');
});

test('login wait and account confirmation demand attention', () => {
  const login = task({ status: 'waiting', result: { transport: 'browser', phase: 'login', limit: 10 } });
  assert.equal(edgeChipState(status(), login).label, '在 Edge 登录抖音');
  assert.equal(shouldOpenSession(login), true);

  const confirm = task({ status: 'waiting', result: { transport: 'browser', phase: 'account', limit: 10, requiresConfirmation: true } });
  assert.equal(edgeChipState(status(), confirm).label, '确认抖音账号');
  assert.equal(shouldOpenSession(confirm), true);

  assert.equal(shouldOpenSession(task()), false);
  assert.equal(shouldOpenSession(task({ status: 'completed', result: { transport: 'browser', phase: 'done', count: 3 } })), false);
});

test('completed sync leaves the chip on the connection state', () => {
  const completed = task({ status: 'completed', result: { transport: 'browser', phase: 'done', count: 3, limit: 10 } });
  assert.equal(isActiveTask(completed), false);
  assert.equal(edgeChipState(status(), completed).label, 'Edge · 测试账号');
});

test('only browser sync tasks are parsed as browser task results', () => {
  assert.equal(browserTaskResult(task())?.phase, 'capturing');
  assert.equal(browserTaskResult(task({ kind: 'review' })), null);
  assert.equal(browserTaskResult(task({ result: { transport: 'legacy' } })), null);
  assert.equal(browserTaskResult(task({ result: null })), null);
});

test('phase labels keep missing counts honest', () => {
  assert.equal(phaseLabel('capturing', 0, 10), '正在读取作品 0/10');
  assert.equal(phaseLabel('paging'), '正在翻页读取作品…');
  assert.equal(phaseLabel('done', 3), '已导入 3 条作品');
  assert.equal(phaseLabel(undefined), '准备同步');
});

test('known error codes get actionable copy and unknown codes fall back', () => {
  assert.match(syncErrorHint('NO_METRICS'), /真实指标/);
  assert.equal(syncErrorHint('SOMETHING_NEW', '原始错误'), '原始错误');
  assert.equal(syncErrorHint(), '同步没有完成，请重试。');
});
