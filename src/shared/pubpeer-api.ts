import {activeWorkSignal, fetchWithDeadline} from "@shared/work-cancellation";
import { debugLog } from "./debug";
import { BlobCache } from "./blob-cache";
import { getHiddenCommenters, isHiddenCommenter } from "./pubpeer-filter";

export interface PubPeerFeedback {
  id: string;
  title: string;
  total_comments: number;
  total_peeriodical_comments: number;
  last_commented_at: string;
  users: string;
  url: string;
}

export function commentersOf(feedback: PubPeerFeedback): string[] {
  return (feedback.users ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

export function applyCommenterMutes(
  feedback: PubPeerFeedback,
  hidden: readonly string[]
): PubPeerFeedback {
  if (hidden.length === 0) return feedback;
  const names = commentersOf(feedback);
  const muted = names.filter((name) => isHiddenCommenter(name, hidden));
  if (muted.length === 0) return feedback;

  return {
    ...feedback,
    total_comments: Math.max(0, feedback.total_comments - muted.length),
    users: names.filter((name) => !isHiddenCommenter(name, hidden)).join(", "),
  };
}

export class PubPeerRateLimitError extends Error {
  constructor(public retryAfterMs: number) {
    super(`PubPeer rate limited (retry after ${retryAfterMs}ms)`);
  }
}

async function fetchPubPeer(
  dois: string[],
  urls: string[],
  signal: AbortSignal | null | undefined = activeWorkSignal()
): Promise<PubPeerFeedback[]> {
  const response = await fetchWithDeadline(
    "https://pubpeer.com/v3/publications?devkey=PubMedChrome",
    {
      signal: signal ?? null,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "1.6.2",
        browser: "Chrome",
        urls,
        dois,
      }),
    }
  );
  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get("Retry-After") ?? "0", 10);
    throw new PubPeerRateLimitError((retryAfter > 0 ? retryAfter : 60) * 1000);
  }
  if (!response.ok) {
    throw new Error(`PubPeer API error: ${response.status}`);
  }
  const data = (await response.json()) as { status: string; feedbacks?: PubPeerFeedback[] };
  return data.feedbacks ?? [];
}

export async function lookupPubPeer(
  dois: string[],
  urls: string[],
  signal: AbortSignal | null | undefined = activeWorkSignal()
): Promise<PubPeerFeedback[]> {
  const feedbacks = await fetchPubPeer(dois, urls, signal);
  const hidden = await getHiddenCommenters();
  return feedbacks.map((feedback) => applyCommenterMutes(feedback, hidden));
}

const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

const cacheKey = (doi: string): string => doi.toLowerCase();

const PUBPEER_CACHE = new BlobCache<{ feedback: PubPeerFeedback | null }>({
  storageKey: "flora_pubpeer_blob",
  ttlMs: CACHE_TTL,
  legacyPrefixes: ["flora_pubpeer:"],
});

// Module-level back-off — when PubPeer returns 429, suppress further requests
// until this timestamp passes so we don't keep retrying every DOM tick.
let rateLimitedUntil = 0;

/**
 * Look up PubPeer feedback for many DOIs in a single batch request.
 * The v3/publications endpoint returns `id` = the DOI for each hit, so results
 * are mapped back to their queried DOI without any secondary lookups.
 *
 * Cache strategy:
 *  1. Read chrome.storage for all DOIs — serve hits immediately.
 *  2. One batch POST for all cache-misses.
 *  3. Write results (hits and confirmed misses) back to cache.
 *
 * Returns a Map containing only the DOIs PubPeer has a record for.
 */
export async function lookupPubPeerForDois<T extends string>(
  dois: T[],
  signal: AbortSignal | null | undefined = activeWorkSignal()
): Promise<Map<T, PubPeerFeedback>> {
  const result = new Map<T, PubPeerFeedback>();
  if (dois.length === 0) return result;
  const hidden = await getHiddenCommenters();
  const visible = (feedback: PubPeerFeedback): PubPeerFeedback =>
    applyCommenterMutes(feedback, hidden);

  // 1. Serve from cache; collect DOIs that need a network call.
  const uncached: T[] = [];
  const now = Date.now();
  const cached = await PUBPEER_CACHE.getMany(dois.map(cacheKey));
  for (const doi of dois) {
    const entry = cached.get(cacheKey(doi));
    if (entry) {
      if (entry.feedback) result.set(doi, visible(entry.feedback));
    } else {
      uncached.push(doi);
    }
  }

  if (uncached.length === 0) {
    debugLog(`PubPeer: ${result.size}/${dois.length} reference DOI(s) matched (all cached)`);
    return result;
  }

  if (now < rateLimitedUntil) {
    debugLog(`PubPeer: rate-limited, skipping ${uncached.length} uncached DOI(s)`);
    return result;
  }

  // 2. One batch call for all uncached DOIs.
  let feedbacks: PubPeerFeedback[] = [];
  try {
    feedbacks = await fetchPubPeer(uncached.map(cacheKey), [], signal);
  } catch (err) {
    if (err instanceof PubPeerRateLimitError) {
      rateLimitedUntil = now + err.retryAfterMs;
      debugLog(`PubPeer: rate limited; backing off ${err.retryAfterMs}ms`);
    }
    return result;
  }

  // feedback.id is the DOI — build a lookup map from the response.
  const hitByDoi = new Map<string, PubPeerFeedback>();
  for (const fb of feedbacks) {
    if (fb.id) hitByDoi.set(cacheKey(fb.id), fb);
  }

  // 3. Cache every uncached DOI (hit → feedback, miss → null) and populate result.
  const writes: Array<[string, { feedback: PubPeerFeedback | null }]> = [];
  for (const doi of uncached) {
    const feedback = hitByDoi.get(cacheKey(doi)) ?? null;
    writes.push([cacheKey(doi), { feedback }]);
    if (feedback) result.set(doi, visible(feedback));
  }
  void PUBPEER_CACHE.setMany(writes);

  debugLog(`PubPeer: ${result.size}/${dois.length} reference DOI(s) have a PubPeer record`);
  return result;
}

// One indicator pill per reference means dozens of concurrent single-DOI
// POSTs, all issued before any has written to the cache — so all of them miss
// it and PubPeer 429s. Collect same-tick lookups into one batch.
const BATCH_WINDOW_MS = 50;
type Batch = Map<string, Array<(fb: PubPeerFeedback | null) => void>>;
// Keep each scan’s ownership across the batching delay and storage awaits.
const pendingDois = new Map<AbortSignal | null, Batch>();
let flushHandle: ReturnType<typeof setTimeout> | null = null;

function flushPendingDois(): void {
  flushHandle = null;
  if (pendingDois.size === 0) return;
  const batches = new Map(pendingDois);
  pendingDois.clear();

  for (const [signal, batch] of batches) {
    const settle = (map: Map<string, PubPeerFeedback> | null) => {
      for (const [doi, resolvers] of batch) {
        const feedback = map?.get(doi) ?? null;
        for (const resolve of resolvers) resolve(feedback);
      }
    };
    if (signal?.aborted) { settle(null); continue; }
    lookupPubPeerForDois([...batch.keys()], signal).then(settle).catch(() => settle(null));
  }
}

/** Resolves to null on miss or failure — callers render "no discussion" for both. */
export function lookupPubPeerForDoi(doi: string): Promise<PubPeerFeedback | null> {
  const signal = activeWorkSignal() ?? null;
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(null); return; }
    let batch = pendingDois.get(signal);
    if (!batch) { batch = new Map(); pendingDois.set(signal, batch); }
    const waiting = batch.get(doi);
    if (waiting) {
      waiting.push(resolve);
    } else {
      batch.set(doi, [resolve]);
    }
    if (flushHandle === null) flushHandle = setTimeout(flushPendingDois, BATCH_WINDOW_MS);
  });
}

/** Test-only: drop in-memory cache state so each case starts fresh. */
export function _resetPubPeerCacheForTesting(): void {
  PUBPEER_CACHE.resetForTesting();
  if (flushHandle !== null) clearTimeout(flushHandle);
  flushHandle = null;
  pendingDois.clear();
  rateLimitedUntil = 0;
}
