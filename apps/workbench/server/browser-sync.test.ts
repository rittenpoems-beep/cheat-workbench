import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserBridge } from './browser-bridge.js';
import { BrowserSync, sameAccount } from './browser-sync.js';
import { Jobs } from './jobs.js';
import type { Workspace } from './workspace.js';
import type { BrowserEvent } from '../shared/browser.js';
import type { Task, Work } from '../shared/types.js';
import { BROWSER_PROTOCOL } from '../shared/browser.js';

const ORIGIN = `chrome-extension://${'c'.repeat(32)}`;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeout = 1500) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('等待条件超时');
    await sleep(5);
  }
}

async function settle(jobs: Jobs, timeout = 2000) {
  await Promise.race([
    jobs.settle(),
    sleep(timeout).then(() => { throw new Error('任务没有在预期时间内结束'); }),
  ]);
}

async function fixture(timings: { acceptMs?: number; confirmMs?: number; inactivityMs?: number; totalMs?: number; cancelAckMs?: number } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cheat-browser-sync-'));
  const bridge = new BrowserBridge(path.join(directory, 'bridge'), { extensionPath: 'ext', pollTimeoutMs: 100 });
  await bridge.init();
  const pairing = await bridge.createPairing();
  const { token } = await bridge.pair({ code: pairing.code, browserName: 'Microsoft Edge', version: '0.1.0', origin: ORIGIN, protocol: BROWSER_PROTOCOL });
  const jobs = new Jobs(path.join(directory, 'jobs')); await jobs.init();
  const imported: Work[][] = [];
  const workspace = { importWorks: async (works: Work[]) => { imported.push(works); return works; } } as unknown as Workspace;
  const sync = new BrowserSync(bridge, jobs, workspace, timings);
  const start = (limit = 5) => jobs.start('sync', '同步作品', (task, signal) => sync.start(task, signal, limit));
  const send = (task: Task, event: Omit<BrowserEvent, 'taskId'>) => bridge.handleEvent(token, ORIGIN, { taskId: task.id, ...event } as BrowserEvent);
  const command = async () => (await bridge.poll(token, ORIGIN)).command;
  return {
    directory, bridge, token, jobs, imported, sync, start, send, command,
    cleanup: async () => { await jobs.settle().catch(() => undefined); await bridge.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

const work = (id: string, plays: number | null = 120, extra: Record<string, unknown> = {}) => ({
  aweme_id: id, desc: `作品 ${id}`, create_time: 1_700_000_000,
  statistics: { play_count: plays, digg_count: 8, comment_count: 2, share_count: 1, collect_count: 3 },
  ...extra,
});

test('account comparison prefers ids and falls back to normalized names', () => {
  assert.equal(sameAccount({ name: '创作者', id: '1' }, { name: '改名了', id: '1' }), true);
  assert.equal(sameAccount({ name: '创作者', id: '1' }, { name: '创作者', id: '2' }), false);
  assert.equal(sameAccount({ name: '创 作 者' }, { name: '创作者' }), true);
  assert.equal(sameAccount({ name: '创作者' }, { name: '其他账号' }), false);
  assert.equal(sameAccount(null, { name: '创作者' }), false);
});

test('the same confirmed account continues without a modal and imports validated works', async () => {
  const context = await fixture();
  try {
    await context.bridge.rememberAccount({ name: '创作者', id: '42' });
    const task = context.start(5);
    const syncCommand = await context.command();
    assert.equal(syncCommand?.kind, 'sync');
    assert.equal(syncCommand?.limit, 5);
    await context.send(task, { type: 'accepted', message: '', phase: 'opening' });
    await context.send(task, { type: 'account', message: '', account: { name: '创作者', id: '42' } });
    await waitFor(() => (task.result as { phase?: string })?.phase === 'capturing');
    const confirm = await context.command();
    assert.equal(confirm?.kind, 'confirm');
    assert.equal(confirm?.taskId, task.id);
    await context.send(task, { type: 'complete', message: '', works: [work('111', 120), work('222', null)] });
    await settle(context.jobs);
    assert.equal(task.status, 'completed');
    assert.equal(task.errorCode, undefined);
    assert.equal(context.imported.length, 1);
    assert.deepEqual(context.imported[0].map(item => item.id), ['111', '222']);
    assert.equal(context.imported[0][0].metrics.plays, 120);
    assert.equal(context.imported[0][1].metrics.plays, null);
    assert.ok(context.bridge.status().lastSyncAt);
    assert.deepEqual(context.bridge.currentAccount(), { name: '创作者', id: '42' });
  } finally { await context.cleanup(); }
});

test('a changed account waits for explicit confirmation before any import', async () => {
  const context = await fixture();
  try {
    await context.bridge.rememberAccount({ name: '旧账号', id: '1' });
    const task = context.start();
    assert.equal((await context.command())?.kind, 'sync');
    await context.send(task, { type: 'accepted', message: '', phase: 'opening' });
    await context.send(task, { type: 'account', message: '', account: { name: '新账号', id: '2' } });
    await waitFor(() => task.status === 'waiting');
    assert.equal((task.result as { requiresConfirmation?: boolean }).requiresConfirmation, true);
    assert.equal(context.imported.length, 0);
    context.sync.confirm(task.id);
    await waitFor(() => (task.result as { phase?: string })?.phase === 'capturing');
    assert.equal((await context.command())?.kind, 'confirm');
    assert.equal(task.status, 'running');
    await context.send(task, { type: 'complete', message: '', works: [work('333', 7)] });
    await settle(context.jobs);
    assert.equal(task.status, 'completed');
    assert.equal(context.imported[0][0].id, '333');
    assert.deepEqual(context.bridge.currentAccount(), { name: '新账号', id: '2' });
  } finally { await context.cleanup(); }
});

test('an unidentified account is a failure, never a silent import', async () => {
  const context = await fixture();
  try {
    const task = context.start();
    await context.command();
    await context.send(task, { type: 'accepted', message: '', phase: 'account' });
    await context.send(task, { type: 'account', message: '', account: { name: '  ' } });
    await settle(context.jobs);
    assert.equal(task.status, 'failed');
    assert.equal(task.errorCode, 'ACCOUNT_UNKNOWN');
    assert.equal(context.imported.length, 0);
  } finally { await context.cleanup(); }
});

test('cancellation waits for the extension, imports nothing, and keeps the tab untouched', async () => {
  const context = await fixture({ cancelAckMs: 100 });
  try {
    const task = context.start();
    assert.equal((await context.command())?.kind, 'sync');
    await context.send(task, { type: 'accepted', message: '', phase: 'capturing' });
    await context.jobs.cancel(task.id);
    assert.equal(task.status, 'cancelling');
    await waitFor(() => task.events.some(event => event.message.includes('通知 Edge')));
    assert.equal((await context.command())?.kind, 'cancel');
    await context.send(task, { type: 'cancelled', message: '用户停止了采集' });
    await settle(context.jobs);
    assert.equal(task.status, 'cancelled');
    assert.equal(context.imported.length, 0);
  } finally { await context.cleanup(); }
});

test('a cancel acknowledgement timeout still ends as cancelled without importing', async () => {
  const context = await fixture({ cancelAckMs: 40 });
  try {
    const task = context.start();
    await context.command();
    await context.send(task, { type: 'accepted', message: '', phase: 'capturing' });
    await context.jobs.cancel(task.id);
    await settle(context.jobs);
    assert.equal(task.status, 'cancelled');
    assert.equal(context.imported.length, 0);
  } finally { await context.cleanup(); }
});

test('missing extension acknowledgement fails within the acceptance window', async () => {
  const context = await fixture({ acceptMs: 40 });
  try {
    const task = context.start();
    await settle(context.jobs);
    assert.equal(task.status, 'failed');
    assert.equal(task.errorCode, 'EXTENSION_TIMEOUT');
  } finally { await context.cleanup(); }
});

test('a closed creator tab fails the task with the extension code', async () => {
  const context = await fixture();
  try {
    const task = context.start();
    await context.command();
    await context.send(task, { type: 'accepted', message: '', phase: 'capturing' });
    await context.send(task, { type: 'error', message: '创作者中心标签已关闭。', code: 'TAB_CLOSED' });
    await settle(context.jobs);
    assert.equal(task.status, 'failed');
    assert.equal(task.errorCode, 'TAB_CLOSED');
    assert.equal(context.imported.length, 0);
  } finally { await context.cleanup(); }
});

test('works without metrics or without valid ids fail before writing', async () => {
  for (const [items, code] of [
    [[{ aweme_id: '444', desc: '无指标', statistics: { play_count: null, digg_count: null } }], 'NO_METRICS'],
    [[{ aweme_id: 'not-a-number', desc: '坏 ID' }], 'INVALID_ITEMS'],
    [[], 'NO_WORKS'],
  ] as const) {
    const context = await fixture();
    try {
      await context.bridge.rememberAccount({ name: '创作者', id: '42' });
      const task = context.start();
      await context.command();
      await context.send(task, { type: 'accepted', message: '', phase: 'opening' });
      await context.send(task, { type: 'account', message: '', account: { name: '创作者', id: '42' } });
      await waitFor(() => (task.result as { phase?: string })?.phase === 'capturing');
      await context.command();
      await context.send(task, { type: 'complete', message: '', works: items as unknown as Record<string, unknown>[] });
      await settle(context.jobs);
      assert.equal(task.status, 'failed', code);
      assert.equal(task.errorCode, code);
      assert.equal(context.imported.length, 0, code);
    } finally { await context.cleanup(); }
  }
});

test('duplicate ids merge and the requested limit is enforced', async () => {
  const context = await fixture();
  try {
    await context.bridge.rememberAccount({ name: '创作者', id: '42' });
    const task = context.start(1);
    await context.command();
    await context.send(task, { type: 'accepted', message: '', phase: 'opening' });
    await context.send(task, { type: 'account', message: '', account: { name: '创作者', id: '42' } });
    await waitFor(() => (task.result as { phase?: string })?.phase === 'capturing');
    await context.command();
    await context.send(task, { type: 'complete', message: '', works: [work('555', 10), work('555', 20), work('666', 30)] });
    await settle(context.jobs);
    assert.equal(task.status, 'completed');
    assert.equal(context.imported[0].length, 1);
    assert.equal(context.imported[0][0].id, '555');
    assert.equal(context.imported[0][0].metrics.plays, 20);
  } finally { await context.cleanup(); }
});

test('account confirmation expires and no works are imported', async () => {
  const context = await fixture({ confirmMs: 40 });
  try {
    await context.bridge.rememberAccount({ name: '旧账号', id: '1' });
    const task = context.start();
    await context.command();
    await context.send(task, { type: 'accepted', message: '', phase: 'opening' });
    await context.send(task, { type: 'account', message: '', account: { name: '新账号', id: '2' } });
    await settle(context.jobs);
    assert.equal(task.status, 'failed');
    assert.equal(task.errorCode, 'ACCOUNT_CONFIRM_TIMEOUT');
    assert.equal(context.imported.length, 0);
  } finally { await context.cleanup(); }
});

test('a disconnected bridge fails preflight before a command is queued', async () => {
  const context = await fixture();
  try {
    await context.bridge.disconnect();
    const task = context.start();
    await settle(context.jobs);
    assert.equal(task.status, 'failed');
    assert.equal(task.errorCode, 'BROWSER_UNPAIRED');
    assert.equal(context.imported.length, 0);
  } finally { await context.cleanup(); }
});

test('inactivity while capturing fails with a retryable code', async () => {
  const context = await fixture({ inactivityMs: 40 });
  try {
    await context.bridge.rememberAccount({ name: '创作者', id: '42' });
    const task = context.start();
    await context.command();
    await context.send(task, { type: 'accepted', message: '', phase: 'capturing' });
    await settle(context.jobs);
    assert.equal(task.status, 'failed');
    assert.equal(task.errorCode, 'SYNC_INACTIVE');
  } finally { await context.cleanup(); }
});
