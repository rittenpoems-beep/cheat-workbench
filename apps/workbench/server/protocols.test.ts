import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadProtocol } from './protocols.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
test('prediction executor receives the actual mandatory anatomy and state references', async () => {
  const text = await loadProtocol(root, 'cheat-predict');
  assert.match(text, /上游原文件：shared-references\/prediction-anatomy.md/);
  assert.match(text, /概率分布.*100%/);
  assert.match(text, /上游原文件：shared-references\/blind-prediction-protocol.md/);
  assert.match(text, /上游原文件：shared-references\/state-management.md/);
});
test('blind input excludes referenced state and prediction protocols and rejects other skills', async () => {
  const text = await loadProtocol(root, 'cheat-score-blind', true);
  assert.equal((text.match(/## 上游原文件：/g) || []).length, 1);
  await assert.rejects(loadProtocol(root, 'cheat-predict', true), /盲评分/);
  await assert.rejects(loadProtocol(root, '../owner'), /无效/);
});
