// Pure extraction helpers shared by the MAIN-world hook and its unit tests.
// Loaded as a classic content script before main-world.js.
(function () {
  'use strict';

  const ARRAY_KEYS = ['aweme_list', 'item_list', 'items', 'list', 'work_list'];
  const WORK_PATH_HINTS = ['/janus/douyin/creator/pc/work_list', '/aweme/v1/creator/item/list', 'work_list'];
  const ACCOUNT_PATH_HINTS = ['/user/info', '/user_info', '/account/info', '/account/get', '/creator/user', '/user/center', '/profile'];
  const ACCOUNT_NAME_KEYS = ['nickname', 'user_name', 'nick_name'];
  const ACCOUNT_ID_KEYS = ['unique_id', 'unique_uid', 'short_id', 'uid'];
  const METRIC_ALIASES = {
    plays: ['play_count', 'play_cnt'],
    likes: ['digg_count', 'like_count', 'digg_cnt'],
    comments: ['comment_count', 'comment_cnt'],
    shares: ['share_count', 'share_cnt'],
    collects: ['collect_count', 'collect_cnt', 'favorite_count'],
  };
  const METRIC_CANONICAL = {
    plays: 'play_count',
    likes: 'digg_count',
    comments: 'comment_count',
    shares: 'share_count',
    collects: 'collect_count',
  };
  const MAX_DESCRIPTION = 500;
  const MAX_ITEMS = 200;
  const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function numeric(value) {
    if (typeof value === 'boolean' || value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
    if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) {
      const parsed = Number(value.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  function pathOf(url) {
    try { return new URL(url, 'https://creator.douyin.com').pathname; } catch { return ''; }
  }

  function isWorkPath(path) {
    const value = String(path || '');
    return WORK_PATH_HINTS.some(hint => value.includes(hint));
  }

  function isAccountPath(path) {
    const value = String(path || '');
    return ACCOUNT_PATH_HINTS.some(hint => value.includes(hint));
  }

  function unwrap(value) {
    for (const key of ['aweme_info', 'item_info', 'aweme', 'item']) {
      if (isRecord(value[key])) return { ...value, ...value[key] };
    }
    return value;
  }

  function idOf(value) {
    const raw = unwrap(value);
    const candidate = raw.aweme_id !== undefined ? raw.aweme_id
      : raw.item_id !== undefined ? raw.item_id
        : raw.awemeId !== undefined ? raw.awemeId
          : raw.id;
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) return String(Math.trunc(candidate));
    if (typeof candidate === 'string' && /^\d+$/.test(candidate.trim())) return candidate.trim();
    return '';
  }

  function looksLikeWork(value) {
    if (!isRecord(value)) return false;
    if (!idOf(value)) return false;
    const raw = unwrap(value);
    return isRecord(raw.statistics) || isRecord(raw.stats) || isRecord(raw.statistic_data)
      || typeof raw.desc === 'string' || typeof raw.title === 'string';
  }

  function looksLikeWorkStrong(value) {
    if (!isRecord(value) || !idOf(value)) return false;
    const raw = unwrap(value);
    return isRecord(raw.statistics) || isRecord(raw.stats) || isRecord(raw.statistic_data)
      || typeof raw.desc === 'string';
  }

  function collectArrays(payload, options) {
    const workishPath = Boolean(options && options.workishPath);
    const acceptUnknown = Boolean(options && options.acceptUnknown);
    const found = [];
    const visit = (node, path, depth) => {
      if (found.length >= 8 || depth > 4 || node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) return;
      for (const key of Object.keys(node)) {
        const value = node[key];
        const nextPath = path ? `${path}.${key}` : key;
        if (Array.isArray(value)) {
          const known = ARRAY_KEYS.includes(key);
          const sample = value.slice(0, 4).filter(isRecord);
          const strong = sample.filter(looksLikeWorkStrong).length;
          const onWorkPath = known && workishPath;
          const accept = onWorkPath
            ? value.length === 0 || sample.some(looksLikeWork)
            : strong >= 2;
          if (accept && (onWorkPath || acceptUnknown)) {
            found.push({ path: nextPath, items: value.filter(isRecord), known: onWorkPath });
          }
          continue;
        }
        visit(value, nextPath, depth + 1);
        if (found.length >= 8) return;
      }
    };
    visit(payload, '', 0);
    return found;
  }

  function sanitizeWork(value) {
    if (!isRecord(value)) return null;
    const raw = unwrap(value);
    const id = idOf(raw);
    if (!id) return null;

    const description = typeof raw.desc === 'string' ? raw.desc
      : typeof raw.title === 'string' ? raw.title : '';
    const work = { aweme_id: id, desc: description.slice(0, MAX_DESCRIPTION), statistics: {} };

    const createdAt = raw.create_time !== undefined ? raw.create_time : raw.createTime;
    if (typeof createdAt === 'number' && Number.isFinite(createdAt) && createdAt > 0) work.create_time = createdAt;
    else if (typeof createdAt === 'string' && (ISO_WITH_ZONE.test(createdAt.trim()) || /^\d+$/.test(createdAt.trim()))) {
      work.create_time = createdAt.trim();
    }

    const containers = [raw.statistics, raw.stats, raw.statistic_data, raw].filter(isRecord);
    for (const [field, aliases] of Object.entries(METRIC_ALIASES)) {
      for (const container of containers) {
        let matched = null;
        for (const alias of aliases) {
          const count = numeric(container[alias]);
          if (count !== null) { matched = count; break; }
        }
        if (matched !== null) { work.statistics[METRIC_CANONICAL[field]] = matched; break; }
      }
    }
    return work;
  }

  /** Raw works with only id/description/time/five metrics; everything else stays on the page. */
  function worksFromPayload(payload, options) {
    if (!isRecord(payload)) return { items: [], arrays: [], empty: false, tolerant: false };
    const arrays = collectArrays(payload, options || {});
    const items = [];
    const seen = new Set();
    let emptyKnown = false;
    for (const entry of arrays) {
      if (entry.known && entry.items.length === 0) emptyKnown = true;
      for (const raw of entry.items.slice(0, MAX_ITEMS)) {
        const work = sanitizeWork(raw);
        if (!work || seen.has(work.aweme_id)) continue;
        seen.add(work.aweme_id);
        items.push(work);
        if (items.length >= MAX_ITEMS) break;
      }
      if (items.length >= MAX_ITEMS) break;
    }
    return {
      items,
      arrays: arrays.map(entry => ({ path: entry.path, count: entry.items.length })),
      empty: items.length === 0 && emptyKnown,
      tolerant: arrays.some(entry => !entry.known),
    };
  }

  /** Account identity only from account-looking responses; never from a work's author. */
  function accountFromPayload(payload, url) {
    if (!isRecord(payload)) return null;
    const path = pathOf(url);
    if (isWorkPath(path)) return null;
    const topLevel = ['user', 'user_info', 'account'].some(key => isRecord(payload[key]));
    if (!isAccountPath(path) && !topLevel) return null;

    let candidates = [payload];
    for (let depth = 0; depth < 3; depth += 1) {
      const next = [];
      for (const node of candidates) {
        for (const key of ACCOUNT_NAME_KEYS) {
          const name = node[key];
          if (typeof name !== 'string' || !name.trim()) continue;
          const account = { name: name.trim().slice(0, 120) };
          for (const idKey of ACCOUNT_ID_KEYS) {
            const id = node[idKey];
            if (typeof id === 'string' && id.trim()) { account.id = id.trim().slice(0, 120); break; }
            if (typeof id === 'number' && Number.isFinite(id)) { account.id = String(id); break; }
          }
          return account;
        }
        for (const key of ['data', 'user', 'user_info', 'author', 'account']) {
          if (isRecord(node[key])) next.push(node[key]);
        }
      }
      candidates = next;
    }
    return null;
  }

  const api = Object.freeze({
    ARRAY_KEYS: ARRAY_KEYS.slice(),
    METRIC_ALIASES,
    isRecord,
    numeric,
    pathOf,
    isWorkPath,
    isAccountPath,
    unwrap,
    idOf,
    looksLikeWork,
    looksLikeWorkStrong,
    sanitizeWork,
    worksFromPayload,
    accountFromPayload,
  });

  Object.defineProperty(globalThis, 'WorkbenchExtract', { value: api, configurable: true });
})();
