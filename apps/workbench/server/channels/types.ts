import type { ChannelId, ChannelStatus } from '../../shared/types.js';

export type Progress = (message: string, level?: 'info' | 'warning' | 'error') => void;

export interface ChannelRun {
  skill: string;
  prompt: string;
  system: string;
  blind: boolean;
  json: boolean;
  signal?: AbortSignal;
  progress: Progress;
}

export interface ChannelEvidence {
  channel: ChannelId;
  mode: 'direct' | 'blind-delegate' | 'api';
  toolsDisabled: boolean;
  freshConfig: boolean;
  subagent?: string;
  toolCallVerified?: boolean;
}

export interface ChannelResult {
  text: string;
  model?: string;
  usage?: unknown;
  evidence: ChannelEvidence;
}

export interface ChannelTest {
  ok: boolean;
  channel: ChannelId;
  auth?: string;
  model?: string;
  models?: string[];
  latencyMs: number;
  detail: string;
}

export interface Channel {
  id: ChannelId;
  caps: { blind: boolean; json: boolean; usage: boolean };
  status(): Promise<ChannelStatus>;
  run(input: ChannelRun): Promise<ChannelResult>;
  test?(signal?: AbortSignal): Promise<ChannelTest>;
}

/** Task-level failures carry a stable code so the UI and job log can stay truthful. */
export class ChannelError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ChannelError';
  }
}

export function abortError(): Error {
  return Object.assign(new Error('任务已取消。'), { cancelled: true, code: 'CANCELLED' });
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}
