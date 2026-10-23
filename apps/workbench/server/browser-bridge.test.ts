import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { BrowserBridge, BrowserBridgeError } from './browser-bridge.js';
import { BROWSER_PROTOCOL } from '../shared/browser.js';

const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const OTHER_ORIGIN = `chrome-extension://${'b'.repeat(32)}`;

async function fixture(options: { now?: () => number; pollTimeoutMs?: number } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cheat-browser-bridge-'));
  const bridge = new BrowserBridge(directory, { extensionPath: path.join(directory, 'browser-extension'), pollTimeoutMs: options.pollTimeoutMs ?? 40, ...options });
  await bridge.init();
  return {
    bridge, directory,
    file: path.join(directory, 'browser.json'),
    cleanup: async () => { await bridge.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

async function paired(options: { now?: () => number; pollTimeoutMs?: number } = {}) {
  const context = await fixture(options);
  const pairing = await context.bridge.createPairing();
  const result = await context.bridge.pair({ code: pairing.code, browserName: 'Microsoft Edge', version: '0.1.0', origin: ORIGIN, protocol: BROWSER_PROTOCOL });
  return { ...context, pairing, token: result.token };
}

const rejectsCode = (code: string, status?: number) => (error: unknown) => error instanceof BrowserBridgeError && error.code === code && (status === undefined || error.status === status);

test('pairing code is grouped, one-time, and expires after ten minutes', async () => {
  let now = Date.parse('2026-10-22T00:00:00Z');
  const { bridge, cleanup } = await fixture({ now: () => now });
  try {
    const pairing = await bridge.createPairing();
    assert.match(pairing.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(Date.parse(pairing.expiresAt), now + 10 * 60 * 1000);
    const result = await bridge.pair({ code: pairing.code.toLowerCase(), browserName: 'Edge', version: '1', origin: ORIGIN, protocol: BROWSER_PROTOCOL });
    assert.match(result.token, /^wbc_[A-Za-z0-9_-]{43}$/);
    await assert.rejects(bridge.pair({ code: pairing.code, browserName: 'Edge', version: '1', origin: ORIGIN, protocol: BROWSER_PROTOCOL }), rejectsCode('PAIRING_INVALID', 410));

    const expired = await bridge.createPairing();
    now += 10 * 60 * 1000 + 1;
    await assert.rejects(bridge.pair({ code: expired.code, browserName: 'Edge', version: '1', origin: ORIGIN, protocol: BROWSER_PROTOCOL }), rejectsCode('PAIRING_EXPIRED', 410));
  } finally { await cleanup(); }
});

test('only the token hash is stored and the token is bound to the extension origin', async () => {
  const { bridge, token, file, cleanup } = await paired();
  try {
    const saved = await readFile(file, 'utf8');
    assert.equal(saved.includes(token), false);
    assert.equal(JSON.parse(saved).tokenHash, createHash('sha256').update(token).digest('hex'));
    assert.equal(JSON.parse(saved).extensionOrigin, ORIGIN);
    assert.equal(bridge.authenticate(token, ORIGIN).extensionOrigin, ORIGIN);
    assert.throws(() => bridge.authenticate(token, OTHER_ORIGIN), rejectsCode('ORIGIN_MISMATCH', 403));
    assert.throws(() => bridge.authenticate(token, undefined), rejectsCode('ORIGIN_REQUIRED', 403));
    assert.throws(() => bridge.authenticate(`wbc_${'x'.repeat(43)}`, ORIGIN), rejectsCode('TOKEN_INVALID', 401));
    assert.throws(() => bridge.authenticate(undefined, ORIGIN), rejectsCode('TOKEN_INVALID', 401));
  } finally { await cleanup(); }
});

test('a restarted workbench accepts the stored token and reconnects on the next poll', async () => {
  const first = await paired({ pollTimeoutMs: 30 });
  let second: BrowserBridge | undefined;
  try {
    second = new BrowserBridge(first.directory, { extensionPath: 'ext', pollTimeoutMs: 30 });
    await second.init();
    assert.equal(second.status().pairingRequired, false);
    assert.equal(second.status().connected, false);
    second.authenticate(first.token, ORIGIN);
    const poll = await second.poll(first.token, ORIGIN);
    assert.equal(poll.command, null);
    assert.equal(second.status().connected, true);
  } finally {
    if (second) await second.close();
    await first.cleanup();
  }
});

test('connected state expires 45 seconds after the last poll or event', async () => {
  let now = Date.parse('2026-10-22T00:00:00Z');
  const { bridge, token, cleanup } = await paired({ now: () => now, pollTimeoutMs: 20 });
  try {
    await bridge.poll(token, ORIGIN);
    assert.equal(bridge.status().connected, true);
    now += 46 * 1000;
    assert.equal(bridge.status().connected, false);
    await bridge.handleEvent(token, ORIGIN, { taskId: 'task-1', type: 'progress', message: '仍在运行' });
    assert.equal(bridge.status().connected, true);
  } finally { await cleanup(); }
});

test('long polling returns a queued command immediately and times out with no command', async () => {
  const { bridge, token, cleanup } = await paired({ pollTimeoutMs: 40 });
  try {
    const pending = bridge.poll(token, ORIGIN);
    bridge.enqueue({ kind: 'sync', taskId: 'task-1', limit: 3 });
    const poll = await pending;
    assert.equal(poll.command?.kind, 'sync');
    assert.equal(poll.command?.taskId, 'task-1');
    assert.equal(poll.command?.limit, 3);
    assert.equal(poll.command?.protocol, BROWSER_PROTOCOL);
    assert.ok(Date.parse(poll.command!.expiresAt) > Date.now());
    const empty = await bridge.poll(token, ORIGIN);
    assert.equal(empty.command, null);
  } finally { await cleanup(); }
});

test('commands deduplicate by task and kind and expire without delivery', async () => {
  let now = Date.parse('2026-10-22T00:00:00Z');
  const { bridge, token, cleanup } = await paired({ now: () => now, pollTimeoutMs: 20 });
  try {
    bridge.enqueue({ kind: 'sync', taskId: 'task-1', limit: 10 });
    bridge.enqueue({ kind: 'sync', taskId: 'task-1', limit: 10 });
    const first = await bridge.poll(token, ORIGIN);
    assert.equal(first.command?.kind, 'sync');
    const second = await bridge.poll(token, ORIGIN);
    assert.equal(second.command, null);

    bridge.enqueue({ kind: 'cancel', taskId: 'task-2' });
    now += 61 * 1000;
    const expired = await bridge.poll(token, ORIGIN);
    assert.equal(expired.command, null);
  } finally { await cleanup(); }
});

test('late events for a finished task are acknowledged as gone and stale polls disarm', async () => {
  const { bridge, token, cleanup } = await paired({ pollTimeoutMs: 20 });
  try {
    bridge.registerTask('task-1');
    bridge.enqueue({ kind: 'sync', taskId: 'task-1', limit: 10 });
    await bridge.poll(token, ORIGIN);
    await bridge.finishTask('task-1');
    const event = await bridge.handleEvent(token, ORIGIN, { taskId: 'task-1', type: 'complete', message: '迟到结果', works: [] });
    assert.equal(event.gone, true);
    const stale = await bridge.poll(token, ORIGIN, 'task-1');
    assert.equal(stale.goneTaskId, 'task-1');
    const unknown = await bridge.poll(token, ORIGIN, 'task-unknown');
    assert.equal(unknown.goneTaskId, 'task-unknown');
  } finally { await cleanup(); }
});

test('a registered active task is not reported as gone while its command is in flight', async () => {
  const { bridge, token, cleanup } = await paired({ pollTimeoutMs: 20 });
  try {
    bridge.registerTask('task-1');
    const poll = await bridge.poll(token, ORIGIN, 'task-1');
    assert.equal(poll.goneTaskId, undefined);
  } finally { await cleanup(); }
});

test('events reach the sync handler and update the connection heartbeat', async () => {
  const { bridge, token, cleanup } = await paired({ pollTimeoutMs: 20 });
  const seen: string[] = [];
  try {
    bridge.onEvent(event => seen.push(`${event.type}:${event.taskId}`));
    const account = await bridge.handleEvent(token, ORIGIN, { taskId: 'task-1', type: 'account', message: '账号', account: { name: '创作者', id: '42' } });
    assert.equal(account.gone, undefined);
    assert.deepEqual(seen, ['account:task-1']);
    assert.equal(bridge.currentAccount(), null);
  } finally { await cleanup(); }
});

test('confirmed account and last sync time survive a restart', async () => {
  const first = await paired();
  let second: BrowserBridge | undefined;
  try {
    await first.bridge.rememberAccount({ name: '创作者', id: '42' });
    await first.bridge.rememberSync();
    second = new BrowserBridge(first.directory, { extensionPath: 'ext' });
    await second.init();
    assert.deepEqual(second.status().account, { name: '创作者', id: '42' });
    assert.ok(second.status().lastSyncAt);
  } finally {
    if (second) await second.close();
    await first.cleanup();
  }
});

test('disconnect revokes the token, clears the binding and resolves a pending poll', async () => {
  const { bridge, token, file, cleanup } = await paired({ pollTimeoutMs: 5000 });
  try {
    const pending = bridge.poll(token, ORIGIN);
    await bridge.disconnect();
    const poll = await pending;
    assert.equal(poll.command, null);
    assert.equal(bridge.status().pairingRequired, true);
    assert.equal(bridge.status().connected, false);
    assert.throws(() => bridge.authenticate(token, ORIGIN), rejectsCode('BROWSER_UNPAIRED', 401));
    await assert.rejects(readFile(file, 'utf8'), /ENOENT/);
  } finally { await cleanup(); }
});

test('pairing creation and attempts are rate limited', async () => {
  const { bridge, cleanup } = await fixture();
  try {
    for (let index = 0; index < 5; index += 1) await bridge.createPairing();
    await assert.rejects(bridge.createPairing(), rejectsCode('RATE_LIMITED', 429));
  } finally { await cleanup(); }
  const second = await fixture();
  try {
    for (let index = 0; index < 5; index += 1) {
      await assert.rejects(second.bridge.pair({ code: 'AAAA-AAAA', browserName: 'Edge', version: '1', origin: ORIGIN, protocol: BROWSER_PROTOCOL }), rejectsCode('PAIRING_INVALID', 410));
    }
    await assert.rejects(second.bridge.pair({ code: 'AAAA-AAAA', browserName: 'Edge', version: '1', origin: ORIGIN, protocol: BROWSER_PROTOCOL }), rejectsCode('RATE_LIMITED', 429));
  } finally { await second.cleanup(); }
});

test('an outdated extension protocol is rejected before the code is consumed', async () => {
  const { bridge, cleanup } = await fixture();
  try {
    const pairing = await bridge.createPairing();
    await assert.rejects(bridge.pair({ code: pairing.code, browserName: 'Edge', version: '1', origin: ORIGIN, protocol: 999 }), rejectsCode('EXTENSION_OUTDATED', 409));
    await bridge.pair({ code: pairing.code, browserName: 'Edge', version: '1', origin: ORIGIN, protocol: BROWSER_PROTOCOL });
  } finally { await cleanup(); }
});

test('a corrupt pairing file fails closed, stays on disk, and can be replaced by re-pairing', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cheat-browser-corrupt-'));
  const file = path.join(directory, 'browser.json');
  await writeFile(file, '{not json', 'utf8');
  const bridge = new BrowserBridge(directory, { extensionPath: 'ext', pollTimeoutMs: 20 });
  try {
    await bridge.init();
    assert.equal(bridge.status().pairingRequired, true);
    assert.match(bridge.status().error || '', /重新配对/);
    assert.equal(await readFile(file, 'utf8'), '{not json');
    const pairing = await bridge.createPairing();
    await bridge.pair({ code: pairing.code, browserName: 'Edge', version: '1', origin: ORIGIN, protocol: BROWSER_PROTOCOL });
    assert.equal(bridge.status().pairingRequired, false);
    assert.ok(JSON.parse(await readFile(file, 'utf8')).tokenHash);
  } finally { await bridge.close(); await rm(directory, { recursive: true, force: true }); }
});
