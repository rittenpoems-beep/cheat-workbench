import test from 'node:test';
import assert from 'node:assert/strict';

// Opt-in against an already-running local application. These cases never start a
// model, collector, or real account connection, and never write business data.
const enabled = process.env.WORKBENCH_HTTP_TEST === '1';
const ownerBase = process.env.WORKBENCH_TEST_OWNER_URL || 'http://127.0.0.1:4317';
const demoBase = process.env.WORKBENCH_TEST_DEMO_URL || 'http://127.0.0.1:4318';
const options = { skip: !enabled };

test('HTTP owner and demo stay in their own workspace despite space query parameters', options, async () => {
  const owner = await fetch(`${ownerBase}/api/snapshot?space=demo`).then(response => response.json());
  const demo = await fetch(`${demoBase}/api/snapshot?space=owner`).then(response => response.json());
  assert.equal(owner.mode, 'owner'); assert.equal(demo.mode, 'demo');
  assert.ok(demo.works.length >= 5); assert.ok(demo.works.every((work: { source: string }) => work.source.includes('虚构')));
  const ownerIds = new Set(owner.works.map((work: { id: string }) => work.id));
  assert.ok(demo.works.every((work: { id: string }) => !ownerIds.has(work.id)));
});

test('HTTP demo rejects real sync, Skill execution and settings before queuing any task', options, async () => {
  const before = await fetch(`${demoBase}/api/snapshot`).then(response => response.json());
  for (const kind of ['sync', 'skill', 'initialize']) {
    const response = await fetch(`${demoBase}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, input: {} }) });
    assert.equal(response.status, 403);
  }
  const configuration = await fetch(`${demoBase}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'deepseek', deepseekKey: 'sk-test-not-a-real-secret' }) });
  assert.equal(configuration.status, 403);
  const after = await fetch(`${demoBase}/api/snapshot`).then(response => response.json());
  assert.equal(after.tasks.length, before.tasks.length);
  assert.deepEqual(after.settings, before.settings);
});

test('HTTP cross-origin writes are blocked before any draft write', options, async () => {
  const before = await fetch(`${demoBase}/api/snapshot`).then(response => response.json());
  const response = await fetch(`${demoBase}/api/drafts`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.example' }, body: JSON.stringify({ title: 'MUST NOT BE SAVED', content: 'cross-site write' }) });
  assert.equal(response.status, 403);
  const after = await fetch(`${demoBase}/api/snapshot`).then(response => response.json());
  assert.equal(after.drafts.length, before.drafts.length);
});

test('HTTP file preview blocks secret and traversal paths; public upstream skill remains readable', options, async () => {
  for (const requested of ['.env', '.auth/cookies.json', '.workbench/settings.json', '../owner/.cheat-state.json', 'scripts/../../.env', 'C:\\Windows\\win.ini']) {
    const response = await fetch(`${demoBase}/api/files?path=${encodeURIComponent(requested)}`);
    assert.ok(response.status >= 400, `${requested} must not be readable`);
    const body = await response.text();
    assert.ok(!body.includes('sk-')); assert.ok(!body.includes('ANTHROPIC_AUTH_TOKEN='));
  }
  const publicFile = await fetch(`${demoBase}/api/files?path=SKILL.md`);
  assert.equal(publicFile.status, 200);
  assert.ok((await publicFile.json()).content.includes('cheat'));
});

test('HTTP invalid commands fail without creating tasks and API errors use JSON', options, async () => {
  const before = await fetch(`${demoBase}/api/snapshot`).then(response => response.json());
  const response = await fetch(`${demoBase}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'not-a-workflow' }) });
  assert.equal(response.status, 400); assert.ok((await response.json()).error);
  const after = await fetch(`${demoBase}/api/snapshot`).then(response => response.json());
  assert.equal(after.tasks.length, before.tasks.length);
  const missing = await fetch(`${demoBase}/api/not-an-endpoint`);
  assert.equal(missing.status, 404); assert.ok((await missing.json()).error);
});
