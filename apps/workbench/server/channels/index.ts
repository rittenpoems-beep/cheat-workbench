import type { ChannelId } from '../../shared/types.js';
import { CodeBuddyChannel, type CodeBuddyOptions } from './codebuddy.js';
import { ModelApiChannel, type ModelApiOptions } from './model-api.js';
import { ClaudeChannel } from './claude.js';
import { CodexChannel } from './codex.js';
import { QoderChannel } from './qoder.js';
import type { Channel } from './types.js';

export { BLIND_SUBAGENT } from './codebuddy.js';
export { ChannelError } from './types.js';
export type { Channel, ChannelEvidence, ChannelResult, ChannelTest } from './types.js';

export const CHANNEL_LABELS: Record<ChannelId, string> = {
  codebuddy: 'CodeBuddy',
  'model-api': '独立模型 API',
  claude: 'Claude CLI',
  codex: 'Codex CLI',
  qoder: 'Qoder CLI',
};

export function buildChannels(options: { codebuddy: CodeBuddyOptions; modelApi: ModelApiOptions }): Record<ChannelId, Channel> {
  return {
    codebuddy: new CodeBuddyChannel(options.codebuddy),
    'model-api': new ModelApiChannel(options.modelApi),
    claude: new ClaudeChannel(),
    codex: new CodexChannel(),
    qoder: new QoderChannel(),
  };
}

