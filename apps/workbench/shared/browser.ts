export const BROWSER_PROTOCOL = 1;
export const BROWSER_EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

export interface BrowserAccount { name: string; id?: string }
export interface BrowserStatus {
  connected: boolean;
  browserName: string | null;
  version: string | null;
  lastSeenAt: string | null;
  pairingRequired: boolean;
  account: BrowserAccount | null;
  lastSyncAt: string | null;
  extensionPath: string;
  protocol: number;
  error?: string;
}
export interface BrowserPairing { code: string; expiresAt: string }

export type RawWorkItem = Record<string, unknown>;
export type BrowserCommandKind = 'sync' | 'confirm' | 'cancel' | 'focus';
export interface BrowserCommand {
  id: string;
  kind: BrowserCommandKind;
  taskId: string;
  limit?: number;
  expiresAt: string;
  protocol: number;
}
export type BrowserCommandInput = Pick<BrowserCommand, 'kind' | 'taskId'> & { limit?: number };

export type BrowserEventType = 'accepted' | 'progress' | 'login_required' | 'account' | 'complete' | 'cancelled' | 'error';
export type BrowserSyncPhase = 'queued' | 'opening' | 'login' | 'account' | 'capturing' | 'paging' | 'importing' | 'done';
export interface BrowserEvent {
  taskId: string;
  type: BrowserEventType;
  message: string;
  phase?: BrowserSyncPhase;
  account?: BrowserAccount;
  works?: RawWorkItem[];
  warnings?: string[];
  code?: string;
  count?: number;
  limit?: number;
}
export interface BrowserPoll {
  command: BrowserCommand | null;
  account: BrowserAccount | null;
  lastSyncAt: string | null;
  protocol: number;
  goneTaskId?: string;
}

// Owner routes (normal same-origin UI; not mounted in the demo space):
// GET /api/browser/status -> BrowserStatus (rate limited)
// POST /api/browser/pairing -> BrowserPairing (one-time code, 10 minutes)
// POST /api/browser/disconnect -> {ok:true} (revokes token and binding)
// POST /api/browser/reveal-extension -> {ok:true} (opens the extension source folder)
// POST /api/browser/focus {taskId?} -> {ok:true}
// POST /api/jobs {kind:'sync',input:{limit}} uses the paired Edge, no fallback.
// GET /api/snapshot includes optional browser:BrowserStatus.
// task.result = {transport:'browser',phase?,account?,requiresConfirmation?}; no screenshots or credentials.
// POST /api/connections/:id/confirm {confirmed:true} is an alias for the confirm command.
// Extension agent routes (restricted channel, never demo; POST keeps Origin visible):
// POST /api/browser/agent/pair {code,browserName,version,protocol} Origin: chrome-extension://<id> -> {token,protocol}
// POST /api/browser/agent/poll {activeTaskId?} Authorization:Bearer token -> BrowserPoll
// POST /api/browser/agent/event BrowserEvent Authorization:Bearer token -> {ok:true} or 409 {code:'TASK_GONE'}
// POST /api/browser/agent/disconnect Authorization:Bearer token -> {ok:true} (revokes this pairing)
// The server stores only sha256(token); the extension keeps the token in chrome.storage.local.
