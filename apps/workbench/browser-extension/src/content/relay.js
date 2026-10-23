// ISOLATED-world relay: page state, pagination actions and MAIN -> service worker.
(() => {
  'use strict';
  if (window.__workbenchRelayInstalled) return;
  window.__workbenchRelayInstalled = true;

  const state = { armed: false, taskId: null, limit: 10, mainSeen: false, lastMainAt: 0, armedAt: 0, missingSent: false };
  const last = { href: '', state: '', hint: '' };

  const cleanHref = () => location.origin + location.pathname;
  const textOf = (element) => (element.innerText || element.textContent || '').trim().replace(/\s+/g, ' ');
  const visible = (element) => {
    try {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = getComputedStyle(element);
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0.05;
    } catch { return false; }
  };

  const sendEvent = (event) => {
    try {
      chrome.runtime.sendMessage({ type: 'wb:relay', event }, () => void chrome.runtime.lastError);
    } catch { /* extension reloaded mid-page */ }
  };

  const toMain = (message) => {
    try { window.postMessage({ __workbench: 'relay', ...message }, location.origin); } catch { /* ignore */ }
  };

  const IGNORED_NAMES = new Set(['登录', '注册', '登录/注册', '创作者中心', '发布作品', '首页', '内容管理', '数据中心', '互动管理', '变现中心', '创作灵感', '更多', '消息', '帮助', '设置', '通知']);
  const NAME_SELECTORS = ['[class*="nickname"]', '[class*="user-name"]', '[class*="userName"]', '[class*="username"]', '[class*="account-name"]', '[class*="accountName"]'];

  function nickname() {
    let regions = [];
    try {
      regions = [...document.querySelectorAll('header, [class*="header"], [class*="topbar"], [class*="top-bar"], [class*="navbar"], [class*="nav-bar"]')];
    } catch { return ''; }
    for (const region of regions.slice(0, 8)) {
      for (const selector of NAME_SELECTORS) {
        let nodes = [];
        try { nodes = [...region.querySelectorAll(selector)]; } catch { continue; }
        for (const node of nodes) {
          if (!visible(node)) continue;
          const value = textOf(node);
          if (!value || value.length > 40 || IGNORED_NAMES.has(value) || /^\d+$/.test(value)) continue;
          return value;
        }
      }
    }
    return '';
  }

  function loginState() {
    const path = location.pathname;
    const byUrl = /\/login|\/passport|\/signin/i.test(path);
    let password = false;
    let layer = false;
    try {
      password = [...document.querySelectorAll('input[type="password"]')].some(visible);
      layer = [...document.querySelectorAll('[class*="login-container"],[class*="login-panel"],[class*="loginModal"],[class*="login-modal"]')].some(visible);
    } catch { /* ignore */ }
    const hint = nickname();
    const value = byUrl || password || layer ? 'logged_out' : hint ? 'logged_in' : 'unknown';
    return { value, hint, path };
  }

  const NEXT_SELECTORS = [
    'button[aria-label*="下一页"]',
    '[title="下一页"]',
    '.ant-pagination-next:not(.ant-pagination-disabled) button',
    '[class*="pagination-next"]:not([aria-disabled="true"])',
    '[role="button"][aria-label*="下一页"]',
  ];

  function isDisabled(element) {
    if (!element) return true;
    if (element.disabled) return true;
    if (element.getAttribute('aria-disabled') === 'true') return true;
    const className = typeof element.className === 'string' ? element.className : '';
    if (/disabled/i.test(className)) return true;
    const parent = element.closest('[aria-disabled="true"], .ant-pagination-disabled, [class*="disabled"]');
    return Boolean(parent);
  }

  function findNext() {
    for (const selector of NEXT_SELECTORS) {
      let nodes = [];
      try { nodes = [...document.querySelectorAll(selector)]; } catch { continue; }
      for (const node of nodes.reverse()) {
        if (!visible(node) || isDisabled(node)) continue;
        return node;
      }
    }
    let nodes = [];
    try { nodes = [...document.querySelectorAll('button, [role="button"], a')]; } catch { return null; }
    for (const node of nodes) {
      const label = `${node.getAttribute('aria-label') || ''} ${textOf(node)}`;
      if (/下一页|下一步/.test(label) && visible(node) && !isDisabled(node)) return node;
    }
    return null;
  }

  function scrollForMore() {
    const candidates = [document.scrollingElement, ...document.querySelectorAll('main, [class*="content"], [class*="list"], [class*="table"], [style*="overflow"]')];
    for (const element of candidates) {
      if (!(element instanceof Element)) continue;
      try {
        if (element.scrollHeight <= element.clientHeight + 40) continue;
        const style = getComputedStyle(element);
        if (!/auto|scroll/.test(style.overflowY)) continue;
        const before = element.scrollTop;
        element.scrollTop = element.scrollHeight;
        if (element.scrollTop !== before) return true;
      } catch { /* ignore */ }
    }
    try {
      const before = window.scrollY;
      window.scrollTo(0, document.body.scrollHeight);
      return window.scrollY !== before;
    } catch { return false; }
  }

  function clickNext() {
    const control = findNext();
    if (!control) {
      const scrolled = scrollForMore();
      return { clicked: false, scrolled, reason: scrolled ? 'scrolled' : 'no-next-control' };
    }
    const target = control.matches('button, a') ? control : control.querySelector('button, a') || control;
    try { target.scrollIntoView({ block: 'center' }); } catch { /* ignore */ }
    try {
      target.click();
      return { clicked: true, reason: 'clicked' };
    } catch {
      try { control.click(); return { clicked: true, reason: 'clicked-container' }; } catch { return { clicked: false, scrolled: false, reason: 'click-failed' }; }
    }
  }

  function pageInfo() {
    const login = loginState();
    return {
      href: cleanHref(),
      path: location.pathname,
      state: login.value,
      hint: login.hint,
      manage: /\/creator-micro\/content\/manage/.test(location.pathname),
      home: /\/creator-micro\/home/.test(location.pathname),
      readyState: document.readyState,
    };
  }

  function reportState(force) {
    const info = pageInfo();
    if (force || info.href !== last.href || info.state !== last.state || info.hint !== last.hint) {
      last.href = info.href;
      last.state = info.state;
      last.hint = info.hint;
      sendEvent({ kind: 'state', href: info.href, path: info.path, state: info.state, hint: info.hint, manage: info.manage });
    }
    return info;
  }

  function applyArm(taskId, limit) {
    state.armed = true;
    state.taskId = taskId || null;
    state.limit = Number(limit) || 10;
    state.armedAt = Date.now();
    state.missingSent = false;
    toMain({ type: 'arm', taskId: state.taskId, limit: state.limit });
  }

  function requestArm(attempt) {
    try {
      chrome.runtime.sendMessage(
        { type: 'wb:relay', event: { kind: 'ready', href: cleanHref(), ...pageInfo() } },
        (response) => {
          const failed = Boolean(chrome.runtime.lastError);
          if (!failed && response && response.armed) {
            applyArm(response.taskId, response.limit);
          } else if (!failed && response && !response.armed) {
            state.armed = false;
          } else if (attempt < 3) {
            setTimeout(() => requestArm(attempt + 1), attempt === 1 ? 400 : 1500);
          }
          reportState(true);
        },
      );
    } catch { /* ignore */ }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.__workbench !== 'main') return;
    state.mainSeen = true;
    state.lastMainAt = Date.now();
    if (message.type === 'ready') {
      state.missingSent = false;
      sendEvent({
        kind: 'ready', href: cleanHref(), hasExtract: message.hasExtract !== false,
        fetchPatched: Boolean(message.fetchPatched), xhrPatched: Boolean(message.xhrPatched),
      });
      if (message.hasExtract === false) {
        sendEvent({ kind: 'main_missing', reason: 'extract-unavailable', href: cleanHref() });
      }
      return;
    }
    if (message.type === 'capture') {
      sendEvent({
        kind: 'capture',
        href: cleanHref(),
        url: typeof message.url === 'string' ? message.url : cleanHref(),
        transport: typeof message.transport === 'string' ? message.transport : 'unknown',
        works: Array.isArray(message.works) ? message.works : [],
        empty: Boolean(message.empty),
      });
      return;
    }
    if (message.type === 'account') {
      sendEvent({ kind: 'account', href: cleanHref(), account: message.account });
      return;
    }
    if (message.type === 'armed') reportState(true);
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'wb-control') return false;
    if (message.action === 'arm') {
      applyArm(message.taskId, message.limit);
      reportState(true);
      sendResponse({ ok: true });
      return false;
    }
    if (message.action === 'disarm') {
      state.armed = false;
      state.taskId = null;
      toMain({ type: 'disarm' });
      sendResponse({ ok: true });
      return false;
    }
    if (message.action === 'page-info') {
      sendResponse(pageInfo());
      return false;
    }
    if (message.action === 'next-page') {
      sendResponse(clickNext());
      return false;
    }
    if (message.action === 'ping-main') {
      toMain({ type: 'ping' });
      sendResponse({ ok: true });
      return false;
    }
    sendResponse({ ok: false });
    return false;
  });

  window.addEventListener('pagehide', () => sendEvent({ kind: 'unloading', href: cleanHref() }));
  window.addEventListener('beforeunload', () => sendEvent({ kind: 'unloading', href: cleanHref() }));

  let heartbeatAt = 0;
  setInterval(() => {
    const info = reportState(false);
    if (!state.mainSeen && state.armed && !state.missingSent && Date.now() - state.armedAt > 3000) {
      state.missingSent = true;
      sendEvent({ kind: 'main_missing', reason: 'main-not-ready', href: cleanHref() });
    }
    if (state.armed && Date.now() - heartbeatAt >= 5000) {
      heartbeatAt = Date.now();
      sendEvent({ kind: 'heartbeat', href: info.href, state: info.state, hint: info.hint });
    }
  }, 1000);

  requestArm(1);
})();
