// MAIN-world observer. It only reads the page's own creator-center responses,
// keeps a whitelisted subset in memory and forwards it to the isolated relay.
(() => {
  'use strict';
  if (window.__workbenchCaptureInstalled) return;
  window.__workbenchCaptureInstalled = true;

  const X = globalThis.WorkbenchExtract;
  const MAX_BUFFER = 80;
  const MAX_BODY = 4 * 1024 * 1024;
  const state = { armed: false, taskId: null, buffer: new Map(), account: null, accountKey: '' };
  const now = () => Date.now();

  const post = (type, data) => {
    try { window.postMessage({ __workbench: 'main', type, at: now(), ...(data || {}) }, location.origin); } catch { /* page tearing down */ }
  };

  if (!X) {
    post('ready', { hasExtract: false, href: location.href });
    return;
  }

  const isContentPage = () => /\/creator-micro\/content/.test(location.pathname);
  const isWorkishPath = (path) => X.isWorkPath(path) || /work_list|item_list|creator\/pc\/work|creator\/item/i.test(path);

  function noteAccount(account) {
    if (!account || !account.name) return;
    const key = `${account.name}|${account.id || ''}`;
    if (key === state.accountKey) return;
    state.account = account;
    state.accountKey = key;
    if (state.armed) post('account', { account });
  }

  function observe(payload, rawUrl, transport) {
    let target;
    try { target = new URL(rawUrl, location.href); } catch { return; }
    if (target.origin !== location.origin) return;

    const account = X.accountFromPayload(payload, rawUrl);
    if (account) noteAccount(account);

    if (!isContentPage() && !X.isWorkPath(target.pathname)) return;
    const result = X.worksFromPayload(payload, {
      workishPath: isWorkishPath(target.pathname),
      acceptUnknown: true,
    });
    if (result.items.length === 0 && !result.empty) return;

    for (const work of result.items) state.buffer.set(work.aweme_id, work);
    while (state.buffer.size > MAX_BUFFER) {
      const oldest = state.buffer.keys().next().value;
      state.buffer.delete(oldest);
    }
    if (!state.armed) return;
    post('capture', {
      url: target.origin + target.pathname,
      transport,
      works: result.items,
      empty: result.items.length === 0 && result.empty,
    });
  }

  function observeText(text, url, transport) {
    if (!text || text.length > MAX_BODY) return;
    let payload = null;
    try { payload = JSON.parse(text); } catch { return; }
    observe(payload, url, transport);
  }

  async function observeFetch(response, input) {
    try {
      const url = response.url || (typeof input === 'string' ? input : input && input.url);
      if (!url) return;
      let target;
      try { target = new URL(url, location.href); } catch { return; }
      if (target.origin !== location.origin) return;
      if (!response.ok) return;
      const contentType = response.headers.get('content-type') || '';
      if (!/json|text\/plain/i.test(contentType)) return;
      const length = Number(response.headers.get('content-length') || 0);
      if (length > MAX_BODY) return;
      const text = await response.clone().text();
      observeText(text, url, 'fetch');
    } catch { /* observation must never break the page */ }
  }

  function installFetch() {
    const originalFetch = window.fetch;
    if (typeof originalFetch !== 'function') return false;
    try {
      window.fetch = function patchedFetch(input) {
        const result = originalFetch.apply(this, arguments);
        try {
          result.then(
            response => { void observeFetch(response, input); },
            () => undefined,
          );
        } catch { /* ignore */ }
        return result;
      };
      return true;
    } catch {
      return false;
    }
  }

  function installXhr() {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const meta = new WeakMap();
    try {
      XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
        try { meta.set(this, { method: String(method || 'GET').toUpperCase(), url: String(url || '') }); } catch { /* ignore */ }
        return originalOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function patchedSend() {
        try {
          this.addEventListener('load', () => {
            try {
              const request = meta.get(this) || { url: this.responseURL };
              const url = request.url || this.responseURL;
              let target;
              try { target = new URL(url, location.href); } catch { return; }
              if (target.origin !== location.origin) return;
              if (this.status < 200 || this.status >= 400) return;
              const contentType = this.getResponseHeader('content-type') || '';
              if (!/json|text\/plain/i.test(contentType)) return;
              if (this.responseType === 'json' && this.response) {
                observe(this.response, url, 'xhr');
                return;
              }
              if (this.responseType === '' || this.responseType === 'text') {
                observeText(this.responseText, url, 'xhr');
              }
            } catch { /* ignore */ }
          }, { once: true });
        } catch { /* ignore */ }
        return originalSend.apply(this, arguments);
      };
      return true;
    } catch {
      return false;
    }
  }

  const fetchPatched = installFetch();
  const xhrPatched = installXhr();

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.__workbench !== 'relay') return;
    if (message.type === 'arm') {
      state.armed = true;
      state.taskId = typeof message.taskId === 'string' ? message.taskId : null;
      if (state.account) post('account', { account: state.account });
      if (state.buffer.size) {
        post('capture', {
          url: location.origin + location.pathname,
          transport: 'buffer',
          works: [...state.buffer.values()],
          empty: false,
        });
      }
      post('armed', { taskId: state.taskId });
      return;
    }
    if (message.type === 'disarm') {
      state.armed = false;
      state.taskId = null;
      state.buffer.clear();
      state.account = null;
      state.accountKey = '';
      return;
    }
    if (message.type === 'ping') post('ready', { hasExtract: true, href: location.href, fetchPatched, xhrPatched });
  });

  post('ready', { hasExtract: true, href: location.href, fetchPatched, xhrPatched });
})();
