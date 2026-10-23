import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Explicit upstream method dependencies, never creator files or recursive links. */
const dependencies: Record<string, string[]> = {
  'cheat-predict': ['shared-references/blind-prediction-protocol.md', 'shared-references/prediction-anatomy.md', 'shared-references/state-management.md'],
  'cheat-retro': ['shared-references/prediction-anatomy.md', 'shared-references/observation-lifecycle.md'],
  'cheat-bump': ['shared-references/bump-validation-protocol.md', 'shared-references/observation-lifecycle.md'],
};

export async function loadProtocol(root: string, skill: string, blind = false): Promise<string> {
  if (!/^cheat-[a-z-]+$/.test(skill)) throw new Error('无效的上游 Skill。');
  if (blind && skill !== 'cheat-score-blind') throw new Error('盲评分只允许使用独立评分协议。');
  const files = [`skills/${skill}/SKILL.md`, ...(blind ? [] : dependencies[skill] || [])];
  const contents = await Promise.all(files.map(async file => `## 上游原文件：${file}\n\n${await readFile(path.join(root, file), 'utf8')}`));
  return contents.join('\n\n---\n\n');
}
