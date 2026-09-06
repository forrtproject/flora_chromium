import {debugWarn} from "./debug";
import {getSettings} from "./settings";
import {RET_MAP_KEY, RET_BUDGET_EVICTED_SYNC_KEY} from "./data-extract";

// Only disposable provider data belongs to this budget. Preferences, the
// debug log and pending reports must never be evicted to make room for it.
const BLOB_KEYS = new Set([
  "flora_oa_blob", "flora_pubpeer_blob", "flora_doival_blob", "flora_doi_blob",
  "flora_title_blob", "flora_pmc_blob", "flora_citation_blob", "RetractionLookupLocal",
]);
export function isProviderCacheKey(key: string): boolean {
  return ["flora:", "flora_doi:", "flora_title:", "flora_pubpeer:", "flora_doival:"].some(prefix => key.startsWith(prefix)) || BLOB_KEYS.has(key);
}

function writtenAt(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  if (typeof record.createdAt === "number") return record.createdAt;
  // Blobs are evicted as a unit so a sweep never writes a stale snapshot over
  // a concurrent cache update. An eviction can cause a refetch, not data loss.
  const timestamps = Object.values(record).map(v =>
    v && typeof v === "object" ? (v as {t?: unknown}).t : undefined,
  ).filter((t): t is number => typeof t === "number");
  return timestamps.length ? Math.max(...timestamps) : 0;
}

/** Enforce the shared soft budget with batched storage reads/removals. */
export async function enforceCacheBudget(bytes: number): Promise<void> {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(isProviderCacheKey);
  if (!keys.length) return;
  let used = await chrome.storage.local.getBytesInUse(keys);
  if (used <= bytes) return;
  const now = Date.now();
  const expired = (key: string) => {
    const entry = all[key] as {expiresAt?: number | null} | undefined;
    return typeof entry?.expiresAt === "number" && entry.expiresAt <= now;
  };
  const age = (key: string) => key === "RetractionLookupLocal" && typeof all.synctime === "number"
    ? all.synctime : writtenAt(all[key]);
  const ordered = keys.sort((a, b) => Number(expired(b)) - Number(expired(a)) || age(a) - age(b));
  const encoder = new TextEncoder();
  let cursor = 0;
  while (used > bytes && cursor < ordered.length) {
    const remove: string[] = [];
    let estimatedFreed = 0;
    const target = used - bytes * 0.9; // headroom for the next batch of writes
    while (cursor < ordered.length && estimatedFreed < target) {
      const key = ordered[cursor++];
      remove.push(key);
      estimatedFreed += encoder.encode(key + JSON.stringify(all[key])).length;
    }
    if (remove.includes(RET_MAP_KEY)) {
      // A refresh may have landed since the initial budget snapshot. Associate
      // eviction with its current generation, not an older snapshot timestamp.
      const {synctime} = await chrome.storage.local.get("synctime");
      if (typeof synctime === "number" && Number.isFinite(synctime) && synctime > 0) {
        // Missing data alone must still trigger recovery; record deliberate
        // eviction before removal so checks can keep the weekly schedule.
        await chrome.storage.local.set({[RET_BUDGET_EVICTED_SYNC_KEY]: synctime});
      }
    }
    await chrome.storage.local.remove(remove);
    // Check the actual storage accounting, rather than relying on estimates.
    used = cursor < ordered.length ? await chrome.storage.local.getBytesInUse(ordered.slice(cursor)) : 0;
  }
}

/** Install only in the service worker: one sweep owner for every provider. */
export function installCacheBudget(): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let again = false;
  const schedule = () => {
    if (running) { again = true; return; }
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      running = true;
      void getSettings().then(settings => enforceCacheBudget(settings.cacheQuotaMb * 1024 * 1024))
        .catch(err => debugWarn("Provider cache budget: sweep failed —", err))
        .finally(() => {
          running = false;
          if (again) { again = false; schedule(); }
        });
    }, 1000);
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === "local" && Object.keys(changes).some(isProviderCacheKey)) ||
        (area === "sync" && "flora_settings" in changes)) schedule();
  });
  schedule(); // covers a restart and a quota change made while asleep
}
