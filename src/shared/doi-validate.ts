import {fetchWithDeadline} from "@shared/work-cancellation";
import type { DoiString } from "./types";
import { debugLog, debugWarn } from "./debug";
import { BlobCache } from "./blob-cache";
import { mapWithLimit } from "./request-gate";

/**
 * Validate DOIs by checking the doi.org Handle System API.
 * A responseCode of 1 means the DOI exists and resolves.
 * This is much cheaper than full augmentation (Crossref/OpenAlex title search).
 */

const HANDLE_API = "https://doi.org/api/handles/";
const MAX_CONCURRENT_CHECKS = 6;
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

const VALIDATION_CACHE = new BlobCache<{ valid: boolean }>({
  storageKey: "flora_doival_blob",
  ttlMs: CACHE_TTL,
  legacyPrefixes: ["flora_doival:"],
});

/**
 * Check whether a single DOI resolves via doi.org.
 * Results are cached in chrome.storage.local for 7 days.
 */
export async function validateDOI(doi: DoiString): Promise<boolean> {
  const result = await validateDOIs([doi]);
  return result.get(doi) ?? false;
}

/**
 * Validate multiple DOIs in parallel via the doi.org Handle System API.
 * Returns a Map of DOI → valid (true/false).
 * Cached results are reused; uncached DOIs are checked in parallel.
 */
export async function validateDOIs(
  dois: DoiString[]
): Promise<Map<DoiString, boolean>> {
  const results = new Map<DoiString, boolean>();
  if (dois.length === 0) return results;

  // Check cache first — single-blob lookup keyed by DOI.
  const uncached: DoiString[] = [];
  const cached = await VALIDATION_CACHE.getMany(dois);
  for (const doi of dois) {
    const entry = cached.get(doi);
    if (entry) {
      results.set(doi, entry.valid);
    } else {
      uncached.push(doi);
    }
  }

  if (uncached.length === 0) {
    debugLog(`DOI validation: ${dois.length} DOI(s) all cached`);
    return results;
  }

  debugLog(`DOI validation: ${uncached.length} uncached DOI(s) to check`);

  // Validate uncached DOIs in parallel. A DOI is recorded `false` only when
  // doi.org *definitively* reports it absent (HTTP 404, or responseCode 100).
  // Transient failures — network errors, rate limits, 5xx — leave the DOI out
  // of the result map entirely so callers treat it as "unknown" and don't drop
  // a possibly-valid DOI. (Marking it invalid here permanently strands the
  // reference: processReferenceDois sets its processed-marker before this
  // check, so a falsely-invalid DOI never gets a second chance at a pill.)
  // Accumulate cache writes and flush the blob once at the end rather than once
  // per resolved DOI (each VALIDATION_CACHE.set is a full chrome.storage.local
  // write of the whole blob).
  const updates: Array<[DoiString, { valid: boolean }]> = [];
  await mapWithLimit(uncached, MAX_CONCURRENT_CHECKS, async (doi) => {
    try {
      // Preserve slashes as URL path separators so multi-slash DOIs
      // (e.g. 10.6338/JDA.202212/SP_17(4).0000) route correctly on doi.org.
      // encodeURIComponent on the full DOI would collapse all '/' to %2F,
      // making the server see a single opaque segment instead of a path.
      const encodedHandle = doi.split("/").map(encodeURIComponent).join("/");
      const response = await fetchWithDeadline(`${HANDLE_API}${encodedHandle}`);
      if (!response.ok) {
        // 404 = the Handle System has no record of this DOI → invalid.
        // Any other non-OK status (429, 5xx) is transient — leave unknown.
        if (response.status === 404) {
          results.set(doi, false);
          updates.push([doi, { valid: false }]);
        }
        return;
      }
      const data = (await response.json()) as { responseCode?: number };
      // Only success and explicit handle-not-found are conclusive. Other
      // protocol responses (including 200: handle exists but has no values)
      // and malformed payloads do not prove that this DOI is invalid.
      // https://www.handle.net/proxy_servlet.html
      if (data.responseCode !== 1 && data.responseCode !== 100) return;
      const valid = data.responseCode === 1;
      results.set(doi, valid);
      updates.push([doi, { valid }]);
      debugLog(`DOI validation: ${doi} → ${valid ? "valid" : "invalid"}`);
    } catch (err) {
      // Left out of the map entirely, so the caller keeps the DOI.
      debugWarn(`DOI validation: ${doi} unresolved —`, err);
    }
  });

  if (updates.length > 0) await VALIDATION_CACHE.setMany(updates);
  return results;
}

/** Test-only: drop in-memory cache state so each case starts fresh. */
export function _resetValidationCacheForTesting(): void {
  VALIDATION_CACHE.resetForTesting();
}
