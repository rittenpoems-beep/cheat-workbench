import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { recoverConnection, validateConnectionCleanup, readConnectionView } from './connections.js';
import express from 'express';

const claimed = { profileRemoved: true, loginViewRemoved: true, browserClosed: true };
const markerName = '.workbench-collector-session.json';

async function temporary() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cheat-connections-test-'));
  const task = path.join(root, 'connections', randomUUID());
  await fs.mkdir(task, { recursive: true });
  return { root, task, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function fixture(task: string, pid = 2_147_483_647) {
  const session = path.join(task, 'profile');
  const browser = path.join(session, 'profile');
  await fs.mkdir(browser, { recursive: true });
  await fs.writeFile(path.join(browser, 'Cookies'), 'fixture-only; no real credentials');
  const marker = { token: randomUUID(), pid, createdAt: new Date().toISOString() };
  await fs.writeFile(path.join(session, markerName), JSON.stringify(marker));
  for (const name of ['login.png', 'login.pending.png', 'confirm.json']) await fs.writeFile(path.join(task, name), 'fixture-only');
  await fs.writeFile(path.join(task, 'result.json'), '{"preserve":true}');
  return { session, browser, marker };
}

test('login PNG inside hidden workspace folders reaches HTTP as image/png, while missing images stay 404', async () => {
  const { root, cleanup } = await temporary();
  const task = path.join(root, '.workbench-data', 'owner', '.workbench', 'connections', randomUUID());
  await fs.mkdir(task, { recursive: true });
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await fs.writeFile(path.join(task, 'login.png'), png);
  const app = express();
  app.get('/view', async (_req, res) => {
    const bytes = await readConnectionView(task);
    if (!bytes) res.sendStatus(404); else res.type('png').send(bytes);
  });
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/view`;
    const response = await fetch(url); assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /image\/png/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    await fs.unlink(path.join(task, 'login.png'));
    assert.equal((await fetch(url)).status, 404);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await cleanup(); }
});

test('valid cleanup claims require all flags and absence of every known artifact', async () => {
  const { task, cleanup } = await temporary();
  try {
    await validateConnectionCleanup(task, claimed);
    for (const invalid of [undefined, null, false, {}, { profileRemoved: true }, { ...claimed, browserClosed: false }]) {
      await assert.rejects(validateConnectionCleanup(task, invalid), /CLEANUP_FAILED/);
    }
    for (const name of ['login.png', 'login.pending.png', 'confirm.json']) {
      const file = path.join(task, name); await fs.writeFile(file, 'fixture');
      await assert.rejects(validateConnectionCleanup(task, claimed), /CLEANUP_FAILED/);
      await fs.unlink(file);
    }
    await fs.mkdir(path.join(task, 'profile', 'profile'), { recursive: true });
    await assert.rejects(validateConnectionCleanup(task, claimed), /CLEANUP_FAILED/);
  } finally { await cleanup(); }
});

test('a live worker receives cancellation and its files are never deleted', async () => {
  const { task, cleanup } = await temporary();
  try {
    const { browser } = await fixture(task, process.pid);
    const result = await recoverConnection(task);
    assert.equal(result.cleaned, false); assert.equal(result.workerPid, process.pid);
    assert.match(result.reason, /仍在运行/);
    assert.equal(await fs.readFile(path.join(task, 'cancel.json'), 'utf8'), '{}');
    assert.equal(await fs.readFile(path.join(browser, 'Cookies'), 'utf8'), 'fixture-only; no real credentials');
    assert.equal(await fs.readFile(path.join(task, 'login.png'), 'utf8'), 'fixture-only');
  } finally { await cleanup(); }
});

test('a dead worker can be recovered while output and a sanitized ownership marker are retained', async () => {
  const { task, cleanup } = await temporary();
  try {
    const { session, browser, marker } = await fixture(task);
    await fs.writeFile(path.join(session, markerName), JSON.stringify({ ...marker, unexpected: 'must not retain unknown data' }));
    const result = await recoverConnection(task);
    assert.equal(result.cleaned, true);
    await assert.rejects(fs.lstat(browser), { code: 'ENOENT' });
    await validateConnectionCleanup(task);
    const retained = JSON.parse(await fs.readFile(path.join(session, markerName), 'utf8'));
    assert.equal(retained.token, marker.token); assert.equal(retained.profileRemoved, true);
    assert.equal(retained.unexpected, undefined);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(task, 'result.json'), 'utf8')), { preserve: true });
    assert.equal((await recoverConnection(task)).cleaned, true, 'recovery can be repeated safely');
  } finally { await cleanup(); }
});

test('missing or corrupt ownership markers never authorize deletion of a remaining browser profile', async () => {
  for (const markerText of [undefined, 'invalid-json', '{}', JSON.stringify({ token: randomUUID(), pid: 0, createdAt: new Date().toISOString() })]) {
    const { task, cleanup } = await temporary();
    try {
      const { session, browser } = await fixture(task);
      if (markerText === undefined) await fs.unlink(path.join(session, markerName));
      else await fs.writeFile(path.join(session, markerName), markerText);
      await assert.rejects(recoverConnection(task), /CLEANUP_FAILED/);
      assert.ok(await fs.stat(path.join(browser, 'Cookies')));
      assert.ok(await fs.stat(path.join(task, 'login.png')));
      assert.ok(await fs.stat(path.join(task, 'cancel.json')));
    } finally { await cleanup(); }
  }
});

test('a never-started task and an already-clean task are verified without requiring a profile marker', async () => {
  const { root, task, cleanup } = await temporary();
  try {
    assert.equal((await recoverConnection(task)).cleaned, true);
    const absent = path.join(root, 'connections', randomUUID());
    assert.equal((await recoverConnection(absent)).cleaned, true);
    await validateConnectionCleanup(absent);
    await assert.rejects(fs.lstat(absent), { code: 'ENOENT' });
    // Unknown metadata alone cannot block cleaning explicitly named images.
    await fs.mkdir(path.join(task, 'profile'));
    await fs.writeFile(path.join(task, 'profile', markerName), 'invalid-json');
    await fs.writeFile(path.join(task, 'login.pending.png'), 'fixture');
    assert.equal((await recoverConnection(task)).cleaned, true);
  } finally { await cleanup(); }
});

test('unsafe paths and a junction substituted for the profile root are refused', async () => {
  const { root, task, cleanup } = await temporary();
  try {
    await assert.rejects(recoverConnection('relative/connections/' + randomUUID()), /CLEANUP_FAILED/);
    await assert.rejects(recoverConnection(path.join(root, 'connections', 'not-a-task-id')), /CLEANUP_FAILED/);
    await assert.rejects(recoverConnection(path.join(root, 'unrelated', randomUUID())), /CLEANUP_FAILED/);
    const outside = path.join(root, 'outside'); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'preserve.txt'), 'valuable');
    await fs.symlink(outside, path.join(task, 'profile'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(recoverConnection(task), /CLEANUP_FAILED/);
    await assert.rejects(validateConnectionCleanup(task), /CLEANUP_FAILED/);
    assert.equal(await fs.readFile(path.join(outside, 'preserve.txt'), 'utf8'), 'valuable');
  } finally { await cleanup(); }
});

test('symlinked known image paths are refused without touching their target', async () => {
  const { root, task, cleanup } = await temporary();
  try {
    const outside = path.join(root, 'outside'); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'preserve.txt'), 'valuable');
    // A junction also exercises Windows link handling without developer-mode
    // privileges required for file symlinks.
    await fs.symlink(outside, path.join(task, 'login.png'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(recoverConnection(task), /CLEANUP_FAILED/);
    assert.equal(await fs.readFile(path.join(outside, 'preserve.txt'), 'utf8'), 'valuable');
  } finally { await cleanup(); }
});

test('a nested profile junction is removed as a link and never traversed', async () => {
  const { root, task, cleanup } = await temporary();
  try {
    const { browser } = await fixture(task);
    const outside = path.join(root, 'outside'); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'preserve.txt'), 'valuable');
    await fs.symlink(outside, path.join(browser, 'linked-cache'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await recoverConnection(task)).cleaned, true);
    assert.equal(await fs.readFile(path.join(outside, 'preserve.txt'), 'utf8'), 'valuable');
  } finally { await cleanup(); }
});
