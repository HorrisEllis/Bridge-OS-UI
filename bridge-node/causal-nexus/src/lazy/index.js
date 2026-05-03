// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
/**
 * @module       lazy
 * @uuid         6786d999-41cf-4a10-8a59-1f85026718ba
 * @version      5.0.0
 *
 * Demand-paged virtual scroll, LRU page cache, and calendar index.
 * Wraps a kernel instance for efficient large-dataset rendering.
 *
 * R1 fix: eventTsToWindow() uses ev.eventTs (logical clock), never ev.ts
 * (wall clock). This makes all analytics replay-deterministic — the same
 * event sequence produces the same buckets regardless of wall-clock time.
 *
 * @hook 1a6d62aa-81dc-4f8c-9485-2c06628dec3e  createLazyLoader
 * @hook 66fe7335-de5f-4285-9b80-fc94408b8d4e  buildCalendarIndex
 * @hook e550b9c8-a7c6-43e5-9915-7a1bb8939350  wallTsToDay
 * @hook 4267fdf7-be47-405b-8737-9874c41016bc  wallTsToMinute
 * @hook 030ef6be-0586-4a23-97e2-370903e8901b  timeRangeWindow
 * @hook a3f1c820-5b2e-4d91-b7e3-9c4d2f8e1a05  eventTsToWindow
 */

const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_MAX_PAGES = 20;

// ── LRU page cache ────────────────────────────────────────────────────────────

function createPageCache(maxPages) {
  const pages = new Map(); // pageKey → { data, kernelVersion, accessCount }

  function pageKey(start, end) { return `${start}:${end}`; }

  function get(start, end, kernelVersion) {
    const k     = pageKey(start, end);
    const entry = pages.get(k);
    if (entry && entry.kernelVersion === kernelVersion) {
      pages.delete(k);
      pages.set(k, entry); // move to end (MRU)
      entry.accessCount++;
      return entry.data;
    }
    return null;
  }

  function set(start, end, kernelVersion, data) {
    const k = pageKey(start, end);
    if (pages.size >= maxPages && !pages.has(k)) {
      pages.delete(pages.keys().next().value); // evict LRU (first = oldest)
    }
    pages.set(k, { data, kernelVersion, accessCount: 1 });
  }

  function invalidate() { pages.clear(); }

  function stats() {
    let hits = 0;
    for (const e of pages.values()) hits += e.accessCount - 1;
    return { size: pages.size, maxPages, hitCount: hits };
  }

  return { get, set, invalidate, stats };
}

// ── Calendar index ────────────────────────────────────────────────────────────

/**
 * Build a day-level index: Map<'YYYY-MM-DD' → { day, firstIdx, lastIdx, count, firstTs, lastTs }>
 * O(n) to build, O(1) to query. Rebuilt when kernel.version changes.
 * @hook 66fe7335-de5f-4285-9b80-fc94408b8d4e  lazy:buildCalendarIndex
 */
export function buildCalendarIndex(events) {
  const days = new Map();
  for (let i = 0; i < events.length; i++) {
    const ev  = events[i];
    const day = wallTsToDay(ev.ts);
    if (!days.has(day)) {
      days.set(day, { day, firstIdx: i, lastIdx: i, count: 1, firstTs: ev.ts, lastTs: ev.ts });
    } else {
      const d = days.get(day);
      d.lastIdx = i;
      d.count++;
      d.lastTs = ev.ts;
    }
  }
  return days;
}

/**
 * Convert wall-clock timestamp to 'YYYY-MM-DD' string.
 * @hook e550b9c8-a7c6-43e5-9915-7a1bb8939350  lazy:wallTsToDay
 */
export function wallTsToDay(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-'
    + String(d.getMonth() + 1).padStart(2, '0') + '-'
    + String(d.getDate()).padStart(2, '0');
}

/**
 * Convert wall-clock timestamp to 'YYYY-MM-DD HH:MM' string.
 * @hook 4267fdf7-be47-405b-8737-9874c41016bc  lazy:wallTsToMinute
 */
export function wallTsToMinute(ts) {
  const d = new Date(ts);
  return wallTsToDay(ts) + ' '
    + String(d.getHours()).padStart(2, '0') + ':'
    + String(d.getMinutes()).padStart(2, '0');
}

// ── Logical clock bucketing (R1 fix) ─────────────────────────────────────────

/**
 * Default tick window size for eventTs bucketing.
 * 1000 ticks ~= second-level granularity in typical Bridge sessions.
 */
export const DEFAULT_TICK_WINDOW = 1000;

/**
 * Bucket a logical event timestamp into a window index.
 *
 * R1: Uses ev.eventTs, not ev.ts. Replay-deterministic by construction —
 * same event sequence always produces the same bucket regardless of wall time.
 *
 * @hook a3f1c820-5b2e-4d91-b7e3-9c4d2f8e1a05  lazy:eventTsToWindow
 */
export function eventTsToWindow(eventTs, windowSize = DEFAULT_TICK_WINDOW) {
  return Math.floor(eventTs / windowSize);
}

// ── Time range filter ─────────────────────────────────────────────────────────

/**
 * Binary search for the first and last events in [tsStart, tsEnd].
 * Returns { firstIdx, lastIdx, count } or null if no events in range.
 * O(log n) — requires events sorted by ts (ring buffer guarantees this).
 *
 * @hook 030ef6be-0586-4a23-97e2-370903e8901b  lazy:timeRangeWindow
 */
export function timeRangeWindow(events, tsStart, tsEnd) {
  if (!events.length) return null;

  let lo = 0, hi = events.length - 1, firstIdx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].ts >= tsStart) { firstIdx = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  if (firstIdx === -1) return null;

  lo = firstIdx; hi = events.length - 1;
  let lastIdx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].ts <= tsEnd) { lastIdx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (lastIdx === -1 || lastIdx < firstIdx) return null;

  return { firstIdx, lastIdx, count: lastIdx - firstIdx + 1 };
}

// ── Lazy loader ───────────────────────────────────────────────────────────────

/**
 * Create a lazy loader wrapping a kernel instance.
 * Demand-paged access to the ring buffer with LRU caching and time filtering.
 *
 * @param {object} kernel   — createKernel() instance
 * @param {object} options
 *   pageSize {number}  events per page (default 200)
 *   maxPages {number}  LRU page count  (default 20)
 *
 * @hook 1a6d62aa-81dc-4f8c-9485-2c06628dec3e  lazy:createLazyLoader
 */
export function createLazyLoader(kernel, { pageSize = DEFAULT_PAGE_SIZE, maxPages = DEFAULT_MAX_PAGES } = {}) {
  const cache = createPageCache(maxPages);

  let _calIndex      = null;
  let _calVersion    = -1;
  let _timeRange     = null; // { tsStart, tsEnd } | null
  let _window        = null; // { firstIdx, lastIdx, count } | null

  // Events array cache — avoids repeated getAll() calls per kernel version
  let _eventsCache        = null;
  let _eventsCacheVersion = -1;

  function _getEvents() {
    if (_eventsCache && _eventsCacheVersion === kernel.version) return _eventsCache;
    _eventsCache        = kernel.getAll();
    _eventsCacheVersion = kernel.version;
    return _eventsCache;
  }

  function _resolveWindow() {
    const events = _getEvents();
    if (!events.length) return { firstIdx: 0, lastIdx: -1, count: 0 };
    if (!_timeRange)    return { firstIdx: 0, lastIdx: events.length - 1, count: events.length };
    const w = timeRangeWindow(events, _timeRange.tsStart, _timeRange.tsEnd);
    return w || { firstIdx: 0, lastIdx: -1, count: 0 };
  }

  function setTimeRange(range) {
    _timeRange = range;
    _window    = null;
    cache.invalidate();
  }

  function getTimeRange() { return _timeRange; }

  function windowLength() {
    _window = _resolveWindow();
    return _window.count;
  }

  function loadPage(pageIndex) {
    _window = _resolveWindow();
    const { firstIdx, lastIdx, count } = _window;
    if (count === 0) return { events: [], pageIndex: 0, totalPages: 0, windowFirstIdx: 0, windowLastIdx: -1 };

    const totalPages   = Math.ceil(count / pageSize);
    const clampedPage  = Math.max(0, Math.min(pageIndex, totalPages - 1));
    const pageStart    = firstIdx + clampedPage * pageSize;
    const pageEnd      = Math.min(firstIdx + (clampedPage + 1) * pageSize - 1, lastIdx);

    const cached = cache.get(pageStart, pageEnd, kernel.version);
    if (cached) return { events: cached, pageIndex: clampedPage, totalPages, windowFirstIdx: firstIdx, windowLastIdx: lastIdx };

    const events = kernel.rangeView(pageStart, pageEnd);
    cache.set(pageStart, pageEnd, kernel.version, events);
    return { events, pageIndex: clampedPage, totalPages, windowFirstIdx: firstIdx, windowLastIdx: lastIdx };
  }

  function loadPageForIndex(logicalIdx) {
    _window = _resolveWindow();
    const { firstIdx } = _window;
    return loadPage(Math.floor((logicalIdx - firstIdx) / pageSize));
  }

  function getCalendarIndex() {
    if (_calIndex && _calVersion === kernel.version) return _calIndex;
    _calIndex   = buildCalendarIndex(_getEvents());
    _calVersion = kernel.version;
    return _calIndex;
  }

  function getCalendarDays() {
    return [...getCalendarIndex().keys()].sort();
  }

  function jumpToDay(dayStr) {
    const idx   = getCalendarIndex();
    const entry = idx.get(dayStr);
    if (!entry) return false;
    const d = new Date(dayStr + 'T00:00:00');
    setTimeRange({ tsStart: d.getTime(), tsEnd: d.getTime() + 86_399_999 });
    return true;
  }

  function invalidate() {
    cache.invalidate();
    _calIndex           = null;
    _calVersion         = -1;
    _window             = null;
    _eventsCache        = null;
    _eventsCacheVersion = -1;
  }

  return {
    setTimeRange, getTimeRange, windowLength,
    loadPage, loadPageForIndex,
    getCalendarIndex, getCalendarDays, jumpToDay,
    invalidate,
    get pageSize()   { return pageSize; },
    get cacheStats() { return cache.stats(); },
  };
}
