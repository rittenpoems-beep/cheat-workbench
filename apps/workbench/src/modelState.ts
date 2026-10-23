import type { ChannelCode, ChannelStatus, Review, Settings } from '../shared/types';

const channelCodeLabels: Record<ChannelCode, string> = {
  ready: '就绪',
  'needs-key': '需要 Key',
  'needs-login': '需要登录',
  'not-installed': '未安装',
  experimental: '实验性',
  planned: '持续开发中',
};

export function channelCodeLabel(code: ChannelCode): string {
  return channelCodeLabels[code];
}

export function channelTone(code: ChannelCode): 'ok' | 'amber' | 'idle' | 'red' {
  if (code === 'ready') return 'ok';
  if (code === 'experimental') return 'amber';
  if (code === 'needs-key' || code === 'needs-login') return 'amber';
  return 'idle';
}

/** The auth actually used when CodeBuddy is selected with auth = auto. */
export function resolvedCodeBuddyAuth(settings: Pick<Settings, 'codebuddyAuth' | 'deepseekConfigured'>): 'account' | 'model-api' {
  if (settings.codebuddyAuth === 'account') return 'account';
  if (settings.codebuddyAuth === 'model-api') return 'model-api';
  return settings.deepseekConfigured ? 'model-api' : 'account';
}

const channelNames: Record<string, string> = {
  codebuddy: 'CodeBuddy',
  'model-api': '模型 API',
  claude: 'Claude CLI',
  codex: 'Codex CLI',
  qoder: 'Qoder',
  none: '未就绪',
};

export function channelName(id: string): string {
  return channelNames[id] || id;
}

export function activeChannelLabel(settings: Settings): { label: string; detail: string; tone: 'ok' | 'amber' | 'idle' | 'red' } {
  const base = (() => {
    if (settings.activeProvider === 'codebuddy') {
      const auth = resolvedCodeBuddyAuth(settings);
      return {
        label: auth === 'account' ? 'CodeBuddy · 本机登录' : 'CodeBuddy · 模型 API',
        detail: `主 agent · ${settings.activeModel || settings.model}`,
        tone: 'ok' as const,
      };
    }
    if (settings.activeProvider === 'model-api') return { label: `模型 API · ${settings.model}`, detail: '独立模型接口，不参与盲评', tone: 'ok' as const };
    if (settings.activeProvider === 'none') return { label: '执行通道未就绪', detail: '请在方法与设置中配置 CodeBuddy 或模型 API', tone: 'amber' as const };
    return { label: channelName(settings.activeProvider), detail: '实验性接入，不保证兼容', tone: 'amber' as const };
  })();
  // The chip always names the channel actually running; the chosen-but-unavailable provider is a warning detail.
  if (!settings.providerIssue) return base;
  return { ...base, detail: `${base.detail}；${settings.providerIssue}`, tone: base.tone === 'ok' ? 'amber' : base.tone };
}

export function blindChip(settings: Settings): { label: string; detail: string; tone: 'ok' | 'amber' | 'idle' } {
  if (!settings.blind.ready) return { label: '盲评未就绪', detail: settings.blind.detail, tone: 'idle' };
  return { label: '盲评 · 子 agent', detail: settings.blind.detail, tone: 'ok' };
}

export function reviewChannelLabel(review: Review): string {
  if (review.mode === 'blind-delegate') return `CodeBuddy 子 agent${review.model ? ` · ${review.model}` : ''}`;
  return review.provider;
}

export function channelAction(status: ChannelStatus): string {
  if (status.id === 'qoder') return '持续开发中';
  if (status.code === 'ready') return '就绪';
  if (status.code === 'needs-key') return '填写 Key';
  if (status.code === 'needs-login') return '完成登录，或改用模型 API';
  if (status.code === 'not-installed') return status.id === 'codebuddy' ? '检测本机安装' : '未检测到';
  if (status.code === 'experimental') return '实验性';
  return '暂未开放';
}

export function providerIssueAction(settings: Settings): string {
  if (!settings.providerIssue) return '';
  if (settings.provider === 'codebuddy') return '请配置 CodeBuddy 登录或模型 API Key。';
  return '当前选择的执行通道不可用，本次会使用可用的通道执行。';
}
