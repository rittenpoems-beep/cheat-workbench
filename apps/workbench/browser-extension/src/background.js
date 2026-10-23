import {
  ALARM_NAME, HOME_URL, MANAGE_URL, MAX_LIMIT, MAX_PAGES, PROTOCOL, SERVER_URL,
  STORAGE_ACTIVE, STORAGE_STATUS, STORAGE_TOKEN,
} from './lib/protocol.js';

const VOLATILE = ['pagingTimer', 'pageDeadlineTimer', 'completionTimer', 'captureWatchdog', 'accountTimer', 'accountFallbackTimer', 'homeTimer'];
const DEFAULT_STATUS = {
  paired: false, connected: false, account: null, lastSyncAt: null,
  phase: 'idle', taskId: null, count: 0, limit: 0, error: '', code: '', network: false,
};
const STATUS_PHASES = new Set(['idle', 'opening', 'login', 'account', 'capturing', 'paging', 'done', 'cancelled', 'error']);

let token = '';
let status = { ...DEFAULT_STATUS };
let active = null;
let polling = false;
let pollGeneration = 0;
let pollBackoff = 0;
let pagingTimer = null;
let pageDeadlineTimer = null;
let completionTimer = null;
let captureWatchdog = null;
let accountTimer = null;
let accountFallbackTimer = null;
let homeTimer = null;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const now = () => Date.now();
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

async function safeJson(response) {
  try { return await response.json(); } catch { return {}; }
}

function normalizeStatus(value) {
  if (!isRecord(value)) return { ...DEFAULT_STATUS };
  const next = { ...DEFAULT_STATUS };
  for (const key of Object.keys(DEFAULT_STATUS)) if (key in value) next[key] = value[key];
  if (!STATUS_PHASES.has(next.phase)) next.phase = 'idle';
  return next;
}

function normalizeActive(value) {
  if (!isRecord(value) || typeof value.taskId !== 'string' || !value.taskId) return null;
  const items = Array.isArray(value.items) ? value.items.filter(isRecord).slice(0, MAX_LIMIT) : [];
  return {
    taskId: value.taskId,
    limit: Math.min(MAX_LIMIT, Math.max(1, Number(value.limit) || 10)),
    phase: STATUS_PHASES.has(value.phase) ? value.phase : 'opening',
    confirmed: Boolean(value.confirmed),
    ending: Boolean(value.ending),
    account: isRecord(value.account) && typeof value.account.name === 'string' ? value.account : null,
    accountSource: typeof value.accountSource === 'string' ? value.accountSource : '',
    accountSent: Boolean(value.accountSent),
    accountKey: typeof value.accountKey === 'string' ? value.accountKey : '',
    accountHint: typeof value.accountHint === 'string' ? value.accountHint : '',
    items,
    pages: Math.max(0, Number(value.pages) || 0),
    tabId: Number.isInteger(value.tabId) ? value.tabId : null,
    loginState: typeof value.loginState === 'string' ? value.loginState : 'unknown',
    homeTried: Boolean(value.homeTried),
    reloads: Math.max(0, Number(value.reloads) || 0),
    warnings: Array.isArray(value.warnings) ? value.warnings.filter(item => typeof item === 'string').slice(0, 20) : [],
    startedAt: Number(value.startedAt) || now(),
    updatedAt: Number(value.updatedAt) || now(),
    lastCaptureAt: Number(value.lastCaptureAt) || 0,
    lastHeartbeatAt: Number(value.lastHeartbeatAt) || 0,
    reloadGraceUntil: Number(value.reloadGraceUntil) || 0,
  };
}

async function saveStatus(patch) {
  status = { ...status, ...patch };
  try { await chrome.storage.session.set({ [STORAGE_STATUS]: status }); } catch { /* session storage unavailable */ }
  await updateBadge();
}

async function persistActive() {
  try {
    if (active) await chrome.storage.session.set({ [STORAGE_ACTIVE]: active });
    else await chrome.storage.session.remove(STORAGE_ACTIVE);
  } catch { /* ignore */ }
}

async function updateBadge() {
  try {
    let text = '';
    let color = '#2f6f4e';
    let title = '创作者实验台连接器';
    if (!token) {
      text = '';
      title = '创作者实验台连接器：尚未配对';
    } else if (active && !active.ending && ['capturing', 'paging'].includes(active.phase)) {
      text = String(active.items.length);
      color = '#2f6f4e';
      title = `正在读取作品 ${active.items.length}/${active.limit}`;
    } else if (active && !active.ending && active.phase === 'login') {
      text = '!';
      color = '#a36a2f';
      title = '请在 Edge 中登录抖音创作者中心';
    } else if (active && !active.ending && active.phase === 'account') {
      text = '?';
      color = '#a36a2f';
      title = '等待确认抖音账号';
    } else if (status.error) {
      text = '!';
      color = '#a3452f';
      title = status.error.slice(0, 120);
    } else if (!status.connected) {
      text = '…';
      color = '#a36a2f';
      title = '工作台未响应，正在重连';
    } else if (status.account) {
      title = `已连接：${status.account.name}`;
    } else {
      title = '已连接创作者实验台';
    }
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
    await chrome.action.setTitle({ title });
  } catch { /* action unavailable during startup */ }
}

async function api(path, { method = 'POST', body, timeout = 15_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(SERVER_URL + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function emit(type, payload = {}, options = {}) {
  const taskId = options.taskId || active?.taskId;
  if (!taskId) return { ok: false, gone: false };
  const body = {
    taskId,
    type,
    message: typeof payload.message === 'string' ? payload.message.slice(0, 2000) : '',
    ...(payload.phase ? { phase: payload.phase } : {}),
    ...(payload.account ? { account: payload.account } : {}),
    ...(payload.works ? { works: payload.works } : {}),
    ...(payload.warnings && payload.warnings.length ? { warnings: payload.warnings.slice(0, 20) } : {}),
    ...(payload.code ? { code: String(payload.code).slice(0, 60) } : {}),
    ...(Number.isInteger(payload.count) ? { count: payload.count } : {}),
    ...(Number.isInteger(payload.limit) ? { limit: payload.limit } : {}),
  };
  const attempts = Math.max(1, Number(options.retries) || 1);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await api('/api/browser/agent/event', { body });
      if (response.status === 401) { await invalidateToken(); return { ok: false, gone: true }; }
      if (response.status === 409) {
        const data = await safeJson(response);
        if (data.code === 'TASK_GONE') {
          if (active?.taskId === taskId) await loseTask();
          return { ok: false, gone: true };
        }
      }
      if (response.ok) {
        status.network = false;
        if (!status.connected) await saveStatus({ connected: true });
        return { ok: true, gone: false };
      }
      if (response.status < 500) return { ok: false, gone: false };
    } catch { /* local server unreachable; retry below */ }
    if (attempt < attempts) await delay(attempt * 1000);
  }
  return { ok: false, gone: false };
}

async function invalidateToken() {
  token = '';
  pollGeneration += 1;
  polling = false;
  clearTaskTimers();
  active = null;
  await persistActive();
  try { await chrome.storage.local.remove(STORAGE_TOKEN); } catch { /* ignore */ }
  await saveStatus({ ...DEFAULT_STATUS, paired: false, error: '配对已失效，请重新配对。', code: 'PAIR_EXPIRED' });
  await broadcastDisarm();
}

async function stopPolling() {
  pollGeneration += 1;
  polling = false;
}

async function ensurePolling() {
  if (polling || !token) return;
  polling = true;
  const generation = ++pollGeneration;
  pollBackoff = 0;
  while (polling && generation === pollGeneration && token) {
    let response;
    try {
      const requestBody = active && !active.ending ? { activeTaskId: active.taskId } : {};
      response = await api('/api/browser/agent/poll', { body: requestBody, timeout: 32_000 });
    } catch {
      if (generation !== pollGeneration) break;
      await saveStatus({ connected: false, network: true, error: status.code ? status.error : '工作台未响应，正在重试…' });
      pollBackoff = Math.min(pollBackoff ? pollBackoff * 2 : 1000, 30_000);
      await delay(pollBackoff);
      continue;
    }
    if (generation !== pollGeneration) break;
    if (response.status === 401 || response.status === 403) {
      const data = await safeJson(response);
      if (response.status === 403 && data.code === 'ORIGIN_REQUIRED' && !token) break;
      await invalidateToken();
      break;
    }
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) {
        pollBackoff = Math.min(pollBackoff ? pollBackoff * 2 : 1000, 30_000);
        await delay(pollBackoff);
        continue;
      }
      const data = await safeJson(response);
      await saveStatus({ connected: false, error: data.error || '工作台拒绝了扩展请求。', code: data.code || 'POLL_FAILED' });
      break;
    }
    pollBackoff = 0;
    const data = await safeJson(response);
    await saveStatus({
      paired: true,
      connected: true,
      network: false,
      account: active?.account || data.account || null,
      lastSyncAt: typeof data.lastSyncAt === 'string' ? data.lastSyncAt : null,
      error: status.code ? status.error : '',
    });
    if (data.protocol !== PROTOCOL) {
      await saveStatus({ error: '扩展与工作台的协议版本不一致，请重新加载扩展。', code: 'EXTENSION_OUTDATED' });
      break;
    }
    if (data.goneTaskId && active && active.taskId === data.goneTaskId) await loseTask();
    if (data.command) void handleCommand(data.command);
    await checkLiveness();
    await delay(120);
  }
  if (generation === pollGeneration) polling = false;
}

async function handleCommand(command) {
  if (!command || command.protocol !== PROTOCOL) return;
  if (command.kind === 'sync') { await beginSync(command); return; }
  if (command.kind === 'focus') { await focusCreatorTab(); return; }
  if (!active || active.taskId !== command.taskId) return;
  if (command.kind === 'confirm') { await confirmSync(); return; }
  if (command.kind === 'cancel') { await cancelActive('已按工作台请求停止本次同步'); }
}

async function beginSync(command) {
  if (active && active.taskId === command.taskId) return;
  if (active) {
    if (!active.ending) await cancelActive('新的同步已开始，旧同步已停止');
    else { await disarm(active.tabId); active = null; await persistActive(); }
  }
  nextInFlight = false;
  active = {
    taskId: command.taskId,
    limit: Math.min(MAX_LIMIT, Math.max(1, Number(command.limit) || 10)),
    phase: 'opening', confirmed: false, ending: false,
    account: null, accountSource: '', accountSent: false, accountKey: '', accountHint: '',
    items: [], pages: 0, tabId: null, loginState: 'unknown', homeTried: false, reloads: 0,
    warnings: [], startedAt: now(), updatedAt: now(), lastCaptureAt: 0, lastHeartbeatAt: 0, reloadGraceUntil: 0,
  };
  await persistActive();
  await saveStatus({ phase: 'opening', taskId: command.taskId, count: 0, limit: active.limit, error: '', code: '', network: false });
  const accepted = await emit('accepted', { phase: 'opening', message: 'Edge 扩展已接手，正在打开创作者中心' }, { retries: 3 });
  if (!accepted.ok) return;
  await openForSync();
}

async function openForSync() {
  if (!active || active.ending) return;
  const tab = await ensureCreatorTab();
  if (!active) return;
  active.tabId = tab.id;
  active.updatedAt = now();
  await persistActive();
  await armTab(tab.id, true);
  const info = await sendToTab(tab.id, { action: 'page-info' }, 6000).catch(() => null);
  if (info) await handlePageState(info);
  scheduleAccountCheck(2500);
}

function scheduleAccountCheck(ms) {
  clearTimeout(accountFallbackTimer);
  accountFallbackTimer = setTimeout(() => { void accountCheck(); }, ms);
}

async function accountCheck() {
  if (!active || active.ending) return;
  if (active.phase === 'login' || active.loginState === 'logged_out') return;
  if (active.account && !active.accountSent) { await emitAccount(); return; }
  if (active.accountSent) return;
  if (now() - active.startedAt > 30_000) {
    await failActive('ACCOUNT_UNKNOWN', '未能识别抖音账号，请确认创作者中心已登录后重试。');
    return;
  }
  if (active.tabId && !active.homeTried) {
    active.homeTried = true;
    active.updatedAt = now();
    await persistActive();
    const info = await sendToTab(active.tabId, { action: 'page-info' }, 4000).catch(() => null);
    if (!active || active.ending || active.accountSent) return;
    try {
      if (info && info.home) await chrome.tabs.reload(active.tabId);
      else await chrome.tabs.update(active.tabId, { url: HOME_URL });
    } catch { return failActive('TAB_CLOSED', '创作者中心标签已关闭，本次同步已停止。'); }
  }
  scheduleAccountCheck(5000);
}

function mergeAccount(account, source) {
  if (!active || active.ending || !isRecord(account)) return;
  const name = typeof account.name === 'string' ? account.name.trim().slice(0, 120) : '';
  if (!name) return;
  const id = typeof account.id === 'string' || typeof account.id === 'number' ? String(account.id).trim().slice(0, 120) : '';
  const incoming = id ? { name, id } : { name };
  if (active.account) {
    if (active.account.id && !incoming.id) return;
    if (active.account.name === incoming.name && (active.account.id || '') === (incoming.id || '')) return;
  }
  active.account = incoming;
  active.accountSource = source;
  active.updatedAt = now();
  void persistActive();
  void saveStatus({ account: incoming });
  if (!active.confirmed) scheduleAccountEmit(active.accountSent ? 300 : 900);
}

function scheduleAccountEmit(ms) {
  clearTimeout(accountTimer);
  accountTimer = setTimeout(() => { void emitAccount(); }, ms);
}

async function emitAccount(force = false) {
  if (!active || active.ending || !active.account) return;
  const session = active;
  const key = `${session.account.name}|${session.account.id || ''}`;
  if (!force && session.accountSent && session.accountKey === key) return;
  session.accountKey = key;
  session.accountSent = true;
  session.updatedAt = now();
  await persistActive();
  await saveStatus({ account: session.account, phase: session.phase === 'opening' ? 'account' : session.phase });
  const result = await emit('account', { account: session.account, phase: 'account', message: `识别到账号「${session.account.name}」` }, { retries: 3, taskId: session.taskId });
  if (active !== session) return;
  if (!result.ok && !result.gone && !session.ending) {
    session.accountSent = false;
    session.accountKey = '';
    await persistActive();
    scheduleAccountCheck(3000);
  }
}

async function handlePageState(info) {
  if (!active || active.ending || !isRecord(info)) return;
  const state = typeof info.state === 'string' ? info.state : 'unknown';
  active.loginState = state;
  if (typeof info.hint === 'string' && info.hint) active.accountHint = info.hint;
  active.updatedAt = now();

  if (state === 'logged_out') {
    await transitionLogin();
    return;
  }

  const wasLogin = active.phase === 'login';
  if (wasLogin) {
    active.phase = active.confirmed ? 'capturing' : 'account';
    await saveStatus({ phase: active.phase });
  }
  if (state === 'logged_in' && info.hint) mergeAccount({ name: info.hint }, 'dom');
  await persistActive();

  if (wasLogin && active.confirmed) { await startCapture(); return; }
  if (!active.confirmed) {
    if (!active.account && !active.homeTried) scheduleAccountCheck(4000);
    else if (active.account && !active.accountSent) scheduleAccountEmit(900);
    else scheduleAccountCheck(3000);
  }
}

async function transitionLogin() {
  if (!active || active.ending) return;
  clearTaskTimers();
  const already = active.phase === 'login';
  active.phase = 'login';
  active.startedAt = now();
  active.updatedAt = now();
  await persistActive();
  await saveStatus({ phase: 'login', error: '' });
  if (!already) {
    await emit('login_required', { phase: 'login', message: '请在 Edge 的创作者中心标签完成抖音登录，登录后会自动继续' });
  }
}

async function confirmSync() {
  if (!active || active.ending) return;
  active.confirmed = true;
  active.updatedAt = now();
  await persistActive();
  await saveStatus({ phase: 'capturing', error: '' });
  await emit('progress', { phase: 'capturing', message: '账号已确认，正在读取作品列表' });
  await startCapture();
}

async function startCapture() {
  if (!active || active.ending || !active.confirmed) return;
  if (!active.account || !active.accountSent) {
    await emitAccount(true);
    if (!active || active.ending) return;
    if (!active.accountSent) { scheduleAccountCheck(1500); return; }
  }
  if (active.loginState === 'logged_out') { await transitionLogin(); return; }
  clearTaskTimers();
  active.phase = 'capturing';
  active.items = [];
  active.pages = 0;
  active.reloads = 0;
  active.warnings = [];
  active.lastCaptureAt = 0;
  active.updatedAt = now();
  await persistActive();
  await saveStatus({ phase: 'capturing', count: 0, error: '' });
  const tabId = active.tabId;
  if (!tabId) return failActive('TAB_CLOSED', '创作者中心标签已关闭，本次同步已停止。');
  await armTab(tabId, true);
  const info = await sendToTab(tabId, { action: 'page-info' }, 5000).catch(() => null);
  if (!active || active.ending) return;
  if (info && info.state === 'logged_out') { await transitionLogin(); return; }
  try {
    if (info && info.manage) await chrome.tabs.reload(tabId);
    else await chrome.tabs.update(tabId, { url: MANAGE_URL });
  } catch {
    return failActive('TAB_CLOSED', '创作者中心标签已关闭，本次同步已停止。');
  }
  await emit('progress', { phase: 'capturing', message: '正在读取创作者中心的作品列表', count: 0 });
  scheduleCaptureWatchdog(16_000);
}

function scheduleCaptureWatchdog(ms) {
  clearTimeout(captureWatchdog);
  captureWatchdog = setTimeout(() => { void captureWatchdogFired(); }, ms);
}

async function captureWatchdogFired() {
  if (!active || active.ending || !active.confirmed) return;
  if (active.phase === 'login') return;
  clearTimeout(captureWatchdog);
  captureWatchdog = null;
  if (active.items.length) { scheduleNextPage(500); return; }
  if (active.reloads < 1 && active.tabId) {
    active.reloads += 1;
    active.updatedAt = now();
    await persistActive();
    try { await chrome.tabs.reload(active.tabId); } catch { return failActive('TAB_CLOSED', '创作者中心标签已关闭，本次同步已停止。'); }
    await emit('progress', { phase: 'capturing', message: '作品列表尚未返回，正在重新加载页面' });
    scheduleCaptureWatchdog(14_000);
    return;
  }
  await failActive('NO_WORKS', '创作者中心没有返回作品列表，请确认「内容管理」能正常打开后重试。');
}

async function handleCapture(event) {
  if (!active || active.ending) return;
  if (event.account) mergeAccount(event.account, 'api');
  if (!active.confirmed || active.phase === 'login') return;
  if (active.phase !== 'capturing' && active.phase !== 'paging') return;
  clearTimeout(captureWatchdog);
  captureWatchdog = null;
  clearTimeout(pageDeadlineTimer);
  pageDeadlineTimer = null;
  clearTimeout(completionTimer);
  completionTimer = null;
  active.lastCaptureAt = now();
  active.updatedAt = now();
  const works = Array.isArray(event.works) ? event.works : [];
  let added = 0;
  for (const work of works) {
    if (!isRecord(work)) continue;
    const id = typeof work.aweme_id === 'string' ? work.aweme_id : '';
    if (!/^\d+$/.test(id)) continue;
    if (active.items.some(item => item.aweme_id === id)) continue;
    active.items.push(work);
    added += 1;
    if (active.items.length >= active.limit) break;
  }
  await persistActive();
  if (active.items.length === 0 && event.empty) {
    scheduleCompletion(2500);
    return;
  }
  if (added) {
    await saveStatus({ phase: 'paging', count: active.items.length });
    await emit('progress', { phase: 'paging', count: active.items.length, message: `已读取 ${active.items.length} 条作品` });
    if (!active || active.ending) return;
    if (active.items.length >= active.limit) { scheduleCompletion(400); return; }
    scheduleNextPage(1200);
    return;
  }
  if (active.items.length === 0) scheduleCaptureWatchdog(8000);
}

function scheduleCompletion(ms) {
  clearTimeout(completionTimer);
  completionTimer = setTimeout(() => { void completeActive(); }, ms);
}

function scheduleNextPage(ms) {
  clearTimeout(pagingTimer);
  pagingTimer = setTimeout(() => { void requestNextPage(); }, ms);
}

function schedulePageDeadline(ms) {
  clearTimeout(pageDeadlineTimer);
  pageDeadlineTimer = setTimeout(() => {
    if (!active || active.ending) return;
    if (active.items.length) void completeActive();
    else void failActive('NO_WORKS', '创作者中心没有返回作品列表，请确认「内容管理」能正常打开后重试。');
  }, ms);
}

let nextInFlight = false;

async function requestNextPage() {
  if (!active || active.ending || !active.confirmed) return;
  if (active.phase === 'login') return;
  if (active.items.length >= active.limit) return completeActive();
  if (active.pages >= MAX_PAGES) {
    if (!active.warnings.includes('已读取 12 页，导入已获取的作品')) active.warnings.push('已读取 12 页，导入已获取的作品');
    return completeActive();
  }
  if (nextInFlight) return;
  if (!active.tabId) return failActive('TAB_CLOSED', '创作者中心标签已关闭，本次同步已停止。');
  nextInFlight = true;
  let result = null;
  try { result = await sendToTab(active.tabId, { action: 'next-page' }, 6000); } catch { result = null; }
  nextInFlight = false;
  if (!active || active.ending) return;
  if (result && result.clicked) {
    active.pages += 1;
    active.phase = 'paging';
    active.updatedAt = now();
    await persistActive();
    await saveStatus({ phase: 'paging', count: active.items.length });
    schedulePageDeadline(10_000);
    return;
  }
  if (result && result.scrolled) { schedulePageDeadline(6000); return; }
  if (active.items.length) { scheduleCompletion(1200); return; }
  scheduleCaptureWatchdog(5000);
}

function hasRealMetric(work) {
  const stats = isRecord(work.statistics) ? work.statistics : {};
  return ['play_count', 'digg_count', 'comment_count', 'share_count', 'collect_count']
    .some(key => typeof stats[key] === 'number' && Number.isFinite(stats[key]) && stats[key] >= 0);
}

async function completeActive() {
  if (!active || active.ending) return;
  const session = active;
  clearTaskTimers();
  const items = session.items.slice(0, session.limit);
  if (!items.length) return failActive('NO_WORKS', '创作者中心没有返回作品列表。');
  if (!items.some(hasRealMetric)) return failActive('NO_METRICS', '作品列表没有返回任何真实指标，请稍后重试。');
  session.ending = true;
  session.updatedAt = now();
  await persistActive();
  await disarm(session.tabId);
  const result = await emit('complete', {
    phase: 'done', works: items, count: items.length, limit: session.limit,
    account: session.account, warnings: session.warnings,
  }, { retries: 3, taskId: session.taskId });
  if (active !== session) return;
  if (result.gone) { active = null; await persistActive(); return; }
  await saveStatus({ phase: 'done', count: items.length, taskId: null, error: '', code: '' });
  active = null;
  await persistActive();
  await updateBadge();
}

async function failActive(code, message) {
  if (!active) return;
  const session = active;
  if (session.ending) { active = null; await persistActive(); return; }
  clearTaskTimers();
  session.ending = true;
  session.updatedAt = now();
  const phase = session.phase;
  const count = session.items.length;
  await persistActive();
  await disarm(session.tabId);
  await emit('error', { code, message, phase, count }, { taskId: session.taskId });
  if (active !== session) return;
  await saveStatus({ phase: 'error', code, error: message, count, taskId: null });
  active = null;
  await persistActive();
  await updateBadge();
}

async function cancelActive(message) {
  if (!active || active.ending) return;
  const session = active;
  clearTaskTimers();
  const phase = session.phase;
  session.ending = true;
  session.updatedAt = now();
  await persistActive();
  await disarm(session.tabId);
  await emit('cancelled', { phase, message: message || '已停止本次同步' }, { taskId: session.taskId });
  if (active !== session) return;
  await saveStatus({ phase: 'cancelled', count: 0, taskId: null, error: '', code: '' });
  active = null;
  await persistActive();
  await updateBadge();
}

async function loseTask() {
  clearTaskTimers();
  await disarm(active?.tabId);
  active = null;
  await persistActive();
  await saveStatus({ phase: 'idle', count: 0, taskId: null });
}

function clearTaskTimers() {
  for (const name of VOLATILE) {
    if (name === 'pagingTimer') { clearTimeout(pagingTimer); pagingTimer = null; }
    if (name === 'pageDeadlineTimer') { clearTimeout(pageDeadlineTimer); pageDeadlineTimer = null; }
    if (name === 'completionTimer') { clearTimeout(completionTimer); completionTimer = null; }
    if (name === 'captureWatchdog') { clearTimeout(captureWatchdog); captureWatchdog = null; }
    if (name === 'accountTimer') { clearTimeout(accountTimer); accountTimer = null; }
    if (name === 'accountFallbackTimer') { clearTimeout(accountFallbackTimer); accountFallbackTimer = null; }
    if (name === 'homeTimer') { clearTimeout(homeTimer); homeTimer = null; }
  }
}

async function handleRelayEvent(event, tab) {
  if (!active || active.ending || !isRecord(event)) return;
  if (active.tabId && tab && Number.isInteger(tab.id) && tab.id !== active.tabId) return;
  if (!active.tabId && tab && Number.isInteger(tab.id)) active.tabId = tab.id;
  active.lastHeartbeatAt = now();
  if (event.kind === 'unloading') {
    active.reloadGraceUntil = now() + 25_000;
    await persistActive();
    return;
  }
  if (event.kind === 'heartbeat') {
    active.reloadGraceUntil = 0;
    return;
  }
  if (event.kind === 'main_missing') {
    await failActive('EXTENSION_INCOMPATIBLE', '扩展未能读取页面响应，请重新加载扩展后再试。');
    return;
  }
  if (event.kind === 'ready') {
    if (event.hasExtract === false) {
      await failActive('EXTENSION_INCOMPATIBLE', '扩展脚本没有正常加载，请重新加载扩展后再试。');
      return;
    }
    active.reloadGraceUntil = 0;
    if (active.tabId) await armTab(active.tabId, false);
    const info = await sendToTab(active.tabId, { action: 'page-info' }, 4000).catch(() => null);
    if (info) await handlePageState(info);
    return;
  }
  if (event.kind === 'state') {
    await handlePageState(event);
    return;
  }
  if (event.kind === 'account') {
    if (event.account) mergeAccount(event.account, 'api');
    return;
  }
  if (event.kind === 'capture') {
    await handleCapture(event);
  }
}

async function checkLiveness() {
  if (!active || active.ending) return;
  if (active.reloadGraceUntil && now() > active.reloadGraceUntil) {
    active.reloadGraceUntil = 0;
    await failActive('PAGE_LOST', '创作者中心页面已离开或没有响应，请保持页面打开后重试。');
  }
}

async function resumeActive() {
  if (!active || active.ending) {
    if (active && active.ending) { active = null; await persistActive(); }
    return;
  }
  let tab = active.tabId ? await chrome.tabs.get(active.tabId).catch(() => null) : null;
  if (!tab) {
    tab = await findCreatorTab();
    if (!tab) return failActive('TAB_CLOSED', '创作者中心标签已关闭，本次同步已停止。');
    active.tabId = tab.id;
    await persistActive();
  }
  await armTab(active.tabId, false);
  const info = await sendToTab(active.tabId, { action: 'page-info' }, 5000).catch(() => null);
  if (info) await handlePageState(info);
  if (!active || active.ending) return;
  if (active.confirmed) {
    if (active.phase === 'capturing' || active.phase === 'paging') {
      if (active.items.length) {
        if (active.items.length >= active.limit) scheduleCompletion(300);
        else scheduleNextPage(800);
      } else scheduleCaptureWatchdog(8000);
    } else if (active.phase !== 'login') {
      await startCapture();
    }
  } else if (active.accountSent) {
    // Waiting for the confirmation command; polling delivers it.
  } else {
    scheduleAccountCheck(1000);
  }
}

async function findCreatorTab() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: 'https://creator.douyin.com/*' }); } catch { return null; }
  return tabs.find(tab => tab.active) || tabs.find(tab => typeof tab.url === 'string' && tab.url.includes('/creator-micro')) || tabs[0] || null;
}

async function ensureCreatorTab() {
  let tab = await findCreatorTab();
  if (tab) {
    try {
      await chrome.tabs.update(tab.id, { active: true });
      if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true });
    } catch { /* ignore */ }
    return tab;
  }
  tab = await chrome.tabs.create({ url: HOME_URL, active: true });
  return tab;
}

async function armTab(tabId, wait) {
  if (!active || active.ending || !Number.isInteger(tabId)) return false;
  try {
    await sendToTab(tabId, { action: 'arm', taskId: active.taskId, limit: active.limit }, wait ? 7000 : 2500);
    return true;
  } catch {
    return false;
  }
}

async function disarm(tabId) {
  if (!Number.isInteger(tabId)) return;
  try { await sendToTab(tabId, { action: 'disarm' }, 1500); } catch { /* tab may be gone */ }
}

async function sendToTab(tabId, payload, timeoutMs) {
  const deadline = now() + Math.max(500, timeoutMs || 4000);
  let lastError;
  while (now() < deadline) {
    try {
      const response = await Promise.race([
        chrome.tabs.sendMessage(tabId, { type: 'wb-control', ...payload }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('页面没有及时响应')), 2500)),
      ]);
      if (response !== undefined) return response;
    } catch (error) { lastError = error; }
    await delay(250);
  }
  throw lastError || new Error('创作者中心页面没有响应');
}

async function broadcastDisarm() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: 'https://creator.douyin.com/*' }); } catch { return; }
  for (const tab of tabs) if (Number.isInteger(tab.id)) await disarm(tab.id);
}

async function focusCreatorTab() {
  const tab = await ensureCreatorTab();
  try {
    await chrome.tabs.update(tab.id, { active: true });
    if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true });
  } catch { /* ignore */ }
}

async function pair(code) {
  const value = typeof code === 'string' ? code.trim() : '';
  if (!value) return { ok: false, error: '请输入配对码。' };
  await stopPolling();
  if (active) {
    if (!active.ending) await cancelActive('重新配对，已停止当前同步');
    else { await disarm(active.tabId); active = null; await persistActive(); }
  }
  try {
    const response = await api('/api/browser/agent/pair', {
      body: {
        code: value,
        browserName: navigator.userAgent.includes('Edg/') ? 'Microsoft Edge' : 'Chromium',
        version: chrome.runtime.getManifest().version,
        protocol: PROTOCOL,
      },
      timeout: 12_000,
    });
    const data = await safeJson(response);
    if (!response.ok || typeof data.token !== 'string') {
      if (token) void ensurePolling();
      return { ok: false, error: data.error || '配对失败，请重新生成配对码。', code: data.code || 'PAIR_FAILED' };
    }
    if (data.protocol !== PROTOCOL) {
      if (token) void ensurePolling();
      return { ok: false, error: '扩展与工作台的协议版本不一致，请更新扩展。', code: 'EXTENSION_OUTDATED' };
    }
    token = data.token;
    await chrome.storage.local.set({ [STORAGE_TOKEN]: token });
    await saveStatus({ ...DEFAULT_STATUS, paired: true, connected: true, error: '' });
    void ensurePolling();
    return { ok: true };
  } catch (error) {
    if (token) void ensurePolling();
    return { ok: false, error: error instanceof Error ? error.message : '无法连接本机工作台，请确认工作台已启动。', code: 'PAIR_NETWORK' };
  }
}

async function disconnect() {
  clearTaskTimers();
  active = null;
  await persistActive();
  if (token) {
    try { await api('/api/browser/agent/disconnect', { timeout: 5000 }); } catch { /* still disconnect locally */ }
  }
  await stopPolling();
  token = '';
  try { await chrome.storage.local.remove(STORAGE_TOKEN); } catch { /* ignore */ }
  await saveStatus({ ...DEFAULT_STATUS, error: '已断开连接。', code: '' });
  await broadcastDisarm();
  await updateBadge();
  return { ok: true };
}

function publicStatus() {
  return {
    paired: Boolean(token),
    connected: Boolean(status.connected),
    account: active?.account || status.account || null,
    lastSyncAt: status.lastSyncAt || null,
    phase: active && !active.ending ? active.phase : status.phase,
    count: active ? active.items.length : status.count,
    limit: active ? active.limit : status.limit,
    error: status.error || '',
    code: status.code || '',
    version: chrome.runtime.getManifest().version,
    protocol: PROTOCOL,
    server: SERVER_URL,
  };
}

const ready = (async () => {
  try {
    const local = await chrome.storage.local.get(STORAGE_TOKEN);
    token = typeof local[STORAGE_TOKEN] === 'string' ? local[STORAGE_TOKEN] : '';
    const session = await chrome.storage.session.get([STORAGE_STATUS, STORAGE_ACTIVE]);
    status = normalizeStatus(session[STORAGE_STATUS]);
    active = normalizeActive(session[STORAGE_ACTIVE]);
  } catch { /* first run */ }
  try { await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 }); }
  catch { try { await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 }); } catch { /* polling still works */ } }
  await updateBadge();
  if (token) void ensurePolling();
  if (active) setTimeout(() => { void resumeActive(); }, 400);
})();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;
  if (message.type === 'wb:relay') {
    const event = message.event;
    if (event && (event.kind === 'ready' || event.kind === 'main_ready')) {
      void ready.then(async () => {
        if (active && !active.ending && (!active.tabId || (sender.tab && sender.tab.id === active.tabId))) {
          if (!active.tabId && sender.tab && Number.isInteger(sender.tab.id)) {
            active.tabId = sender.tab.id;
            await persistActive();
          }
          sendResponse({ armed: true, taskId: active.taskId, limit: active.limit });
          await handleRelayEvent(event, sender.tab);
        } else {
          sendResponse({ armed: false });
        }
      });
      return true;
    }
    void ready.then(() => handleRelayEvent(event, sender.tab));
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'wb:pair') {
    void ready.then(() => pair(message.code)).then(sendResponse);
    return true;
  }
  if (message.type === 'wb:status') {
    void ready.then(() => sendResponse(publicStatus()));
    return true;
  }
  if (message.type === 'wb:disconnect') {
    void ready.then(() => disconnect()).then(sendResponse);
    return true;
  }
  if (message.type === 'wb:retry') {
    void ready.then(async () => {
      await stopPolling();
      if (token) void ensurePolling();
      sendResponse({ ok: true });
    });
    return true;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void ready.then(async () => {
    if (active && !active.ending && active.tabId === tabId) {
      await failActive('TAB_CLOSED', '创作者中心标签已关闭，本次同步已停止。');
    }
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  void ready.then(async () => {
    if (!active || active.ending || active.tabId !== tabId) return;
    if (changeInfo.url && !String(changeInfo.url).startsWith('https://creator.douyin.com/')) {
      active.reloadGraceUntil = now() + 20_000;
      await persistActive();
      return;
    }
    if (changeInfo.status === 'complete' || changeInfo.url) {
      active.reloadGraceUntil = 0;
      await armTab(tabId, false);
      const info = await sendToTab(tabId, { action: 'page-info' }, 4000).catch(() => null);
      if (info) await handlePageState(info);
    }
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  void ready.then(async () => {
    if (token) void ensurePolling();
    await checkLiveness();
    if (active && !active.ending && now() - active.updatedAt > 45_000) await resumeActive();
  });
});

chrome.runtime.onStartup.addListener(() => {
  void ready.then(() => { if (token) void ensurePolling(); });
});

chrome.runtime.onInstalled.addListener(() => {
  void ready.then(async () => {
    await updateBadge();
    if (token) void ensurePolling();
  });
});
