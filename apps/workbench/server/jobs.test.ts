import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jobs } from './jobs.js';

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cheat-jobs-test-'));
  const jobs = new Jobs(directory); await jobs.init();
  return { jobs, directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test('cancellation remains in progress until the worker has released its resources', async () => {
  const { jobs, directory, cleanup } = await fixture(); const began = deferred(), release = deferred();
  try {
    const task = jobs.start('sync', '连接测试', async (_task, signal) => { began.resolve(); await release.promise; assert.equal(signal.aborted, true); throw new Error('同步取消且清理完成'); });
    await began.promise; await jobs.cancel(task.id);
    assert.equal(task.status, 'cancelling'); assert.ok(jobs.controllers.has(task.id));
    release.resolve(); await jobs.settle();
    assert.equal(task.status, 'cancelled'); assert.equal(jobs.controllers.size, 0);
    assert.equal(JSON.parse(await readFile(path.join(directory, 'tasks.json'), 'utf8'))[0].status, 'cancelled');
  } finally { release.resolve(); await jobs.settle(); await cleanup(); }
});
test('queued cancellation never starts a model and does not retain controller handles', async () => {
  const { jobs, cleanup } = await fixture(); const began = deferred(), release = deferred(); let called = false;
  try {
    jobs.start('first', '先执行', async () => { began.resolve(); await release.promise; }); await began.promise;
    const queued = jobs.start('draft', '不会执行', async () => { called = true; });
    await jobs.cancel(queued.id); assert.equal(queued.status, 'cancelled'); release.resolve(); await jobs.settle();
    assert.equal(called, false); assert.equal(jobs.controllers.size, 0);
  } finally { release.resolve(); await jobs.settle(); await cleanup(); }
});
test('an in-flight atomic save refuses cancellation, and cancelled tasks cannot begin a save', async () => {
  const { jobs, cleanup } = await fixture(); const saving = deferred(), release = deferred(); let saved = false;
  try {
    const task = jobs.start('draft', '原子保存', async (task, signal) => jobs.commit(task, signal, async () => { saving.resolve(); await release.promise; saved = true; }));
    await saving.promise; await assert.rejects(jobs.cancel(task.id), /原子保存/);
    release.resolve(); await jobs.settle(); assert.equal(saved, true); assert.equal(task.status, 'completed');
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(jobs.commit(task, cancelled.signal, async () => { throw new Error('不应执行'); }), error => (error as Error).name === 'AbortError');
  } finally { release.resolve(); await jobs.settle(); await cleanup(); }
});
test('cleanup failure is a failure even when cancellation was requested', async () => {
  const { jobs, cleanup } = await fixture(); const began = deferred(), release = deferred();
  try {
    const task = jobs.start('sync', '清理故障', async () => { began.resolve(); await release.promise; throw Object.assign(new Error('CLEANUP_FAILED: 浏览器资料仍存在'), { cleanupFailed: true }); });
    await began.promise; await jobs.cancel(task.id); release.resolve(); await jobs.settle();
    assert.equal(task.status, 'failed'); assert.match(task.error!, /CLEANUP_FAILED/);
  } finally { release.resolve(); await jobs.settle(); await cleanup(); }
});
test('waiting for login remains one task status instead of repeated polling messages', async () => {
  const { jobs, cleanup } = await fixture();
  try {
    const task = jobs.start('sync', '登录等待', async task => {
      for (let poll = 0; poll < 10; poll++) jobs.event(task, '等待登录');
      jobs.event(task, '账号已确认');
    });
    await jobs.settle();
    assert.equal(task.events.filter(event => event.message === '等待登录').length, 1);
    assert.ok(task.events.some(event => event.message === '账号已确认'));
  } finally { await jobs.settle(); await cleanup(); }
});
