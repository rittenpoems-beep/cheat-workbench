import type { ChannelStatus } from '../../shared/types.js';
import type { Channel } from './types.js';
import { ChannelError } from './types.js';

/** Reserved for a future Qoder CLI adapter; no compatibility promise is made yet. */
export class QoderChannel implements Channel {
  readonly id = 'qoder' as const;
  readonly caps = { blind: false, json: false, usage: false };
  async status(): Promise<ChannelStatus> {
    return { id: this.id, label: 'Qoder CLI', kind: 'agent', code: 'planned', detail: '持续开发中，暂未接入，不保证兼容。' };
  }
  async run(): Promise<never> {
    throw new ChannelError('CHANNEL_PLANNED', 'Qoder 接入仍在持续开发中，当前版本暂不支持。请使用 CodeBuddy 或独立模型 API。');
  }
}
