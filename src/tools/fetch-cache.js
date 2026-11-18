// In-memory TTL cache for HTML/JSON fetched from wol.jw.org and jw.org.
// Ported from prreobby/jw-research-mcp (src/lib/cache.ts). Requests go through
// fetchWithTimeout so a slow host can't hang the server.
import { fetchWithTimeout } from './fetch-with-timeout.js';
import { isBotChallenge, WOLBlockedError } from './wol-scraper.js';

function parseTtl() {
  const raw = Number(process.env.CACHE_TTL_SECONDS || '900');
  return Number.isFinite(raw) && raw >= 0 ? raw * 1000 : 900_000;
}

export class TTLCache {
  entries = new Map();

  constructor(ttlMs = parseTtl(), maxEntries = 1000) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  async getOrLoad(key, sourceUrl, loader, force = false, ttlMs = this.ttlMs) {
    const now = Date.now();
    const cached = this.entries.get(key);
    if (!force && cached && cached.expiresAt > now) {
      return {
        value: cached.value,
        metadata: { source_url: sourceUrl, timestamp: cached.fetchedAt, cache_hit: true },
      };
    }
    const value = await loader();
    const fetchedAt = new Date().toISOString();
    this.entries.set(key, { value, fetchedAt, expiresAt: now + ttlMs });
    this.prune(now);
    return {
      value,
      metadata: { source_url: sourceUrl, timestamp: fetchedAt, cache_hit: false },
    };
  }

  clear() {
    this.entries.clear();
  }

  prune(now) {
    if (this.entries.size < this.maxEntries) return;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    // Still over the cap (everything is fresh): drop the oldest entries.
    // Map keeps insertion order, so the first keys are the oldest.
    for (const key of this.entries.keys()) {
      if (this.entries.size < this.maxEntries) break;
      this.entries.delete(key);
    }
  }
}

export const cache = new TTLCache();

// Same headers as wol-scraper.js. AWS WAF on wol.jw.org serves an unsolvable JS
// challenge to browser-looking User-Agents, so keep the plain name. The site has
// also stalled on requests without Accept-Language.
const DEFAULT_HEADERS = {
  'User-Agent': 'jw-mcp',
  Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Overridable in tests.
let fetchFn = fetchWithTimeout;
export function setFetchForTesting(fn) {
  fetchFn = fn || fetchWithTimeout;
  cache.clear();
}

async function load(url, options, asJson) {
  const response = await fetchFn(url, {
    ...options,
    headers: { ...DEFAULT_HEADERS, ...(options.headers || {}) },
  });
  if (asJson) {
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
    return response.json();
  }
  const body = await response.text();
  if (isBotChallenge(response.status, body)) throw new WOLBlockedError(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
  }
  return body;
}

/**
 * Fetch a URL as text, cached. `ttlMs` overrides the default lifetime for
 * pages that rarely change (tables of contents, topic lists).
 */
export async function fetchTextCached(url, options = {}, force = false, ttlMs) {
  return cache.getOrLoad(`text:${url}`, url, () => load(url, options, false), force, ttlMs);
}

export async function fetchJsonCached(url, options = {}, force = false, ttlMs) {
  return cache.getOrLoad(`json:${url}`, url, () => load(url, options, true), force, ttlMs);
}

/**
 * Run `worker` over `items` with at most `limit` in flight. Keeps the load on
 * wol.jw.org and jw.org polite when a tool needs several pages.
 */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
