import type { DoiString } from "./types";
import { normaliseDOI } from "./doi-normalise";

const OPENALEX_BASE = "https://api.openalex.org/works";
const CACHE_PREFIX = "flora_doi:";
const DEFAULT_EMAIL = "flora-extension@example.com";
const MATCH_THRESHOLD = 0.8;

/**
 * Normalize a title for comparison: lowercase, strip non-word chars, collapse spaces.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Clean a title for use in OpenAlex filter syntax.
 * Strips characters that break the title.search filter.
 */
function cleanTitleForSearch(title: string): string {
  return title
    .replace(/[:()\[\]&|\\,;'"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Levenshtein-based similarity score between two strings (0 to 1).
 * 1.0 = identical, 0.0 = completely different.
 */
export function similarity(s1: string, s2: string): number {
  const longer = s1.length >= s2.length ? s1 : s2;
  const shorter = s1.length >= s2.length ? s2 : s1;

  if (longer.length === 0) return 1.0;

  const costs: number[] = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }

  return (longer.length - costs[s2.length]) / longer.length;
}

interface CachedDoiResult {
  found: boolean;
  doi: string | null;
}

/**
 * Augment DOIs for article titles that don't have a DOI.
 * Queries the OpenAlex API by title, then fuzzy-matches results.
 * Returns a Map of original title → resolved DoiString (or null if not found).
 */
export async function augmentDOIs(
  titles: string[]
): Promise<Map<string, DoiString | null>> {
  const results = new Map<string, DoiString | null>();
  if (titles.length === 0) return results;

  // Check cache first
  const uncached: string[] = [];
  const cacheKeys = titles.map((t) => CACHE_PREFIX + normalizeTitle(t));

  try {
    const cached = await chrome.storage.local.get(cacheKeys);
    for (const title of titles) {
      const key = CACHE_PREFIX + normalizeTitle(title);
      const entry = cached[key] as CachedDoiResult | undefined;
      if (entry) {
        results.set(
          title,
          entry.found && entry.doi ? normaliseDOI(entry.doi) : null
        );
      } else {
        uncached.push(title);
      }
    }
  } catch {
    // Storage unavailable, treat all as uncached
    uncached.push(...titles);
  }

  if (uncached.length === 0) return results;

  // Build OpenAlex query: titles joined with | (OR)
  const searchTerms = uncached
    .map((t) => encodeURIComponent(cleanTitleForSearch(t)))
    .join("|");

  const url = `${OPENALEX_BASE}?filter=title.search:${searchTerms}&select=id,doi,title&per_page=50&mailto=${encodeURIComponent(DEFAULT_EMAIL)}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      // Mark all as not found
      for (const title of uncached) {
        results.set(title, null);
      }
      return results;
    }

    const data = (await response.json()) as {
      results?: Array<{ doi?: string; title?: string }>;
    };

    const matchedTitles = new Set<string>();

    for (const work of data.results ?? []) {
      if (!work.doi || !work.title) continue;

      const workNormalized = normalizeTitle(work.title);

      // Find best matching uncached title
      let bestTitle: string | null = null;
      let bestScore = 0;

      for (const title of uncached) {
        if (matchedTitles.has(title)) continue;

        const score = similarity(workNormalized, normalizeTitle(title));
        if (score > bestScore && score > MATCH_THRESHOLD) {
          bestScore = score;
          bestTitle = title;
        }
      }

      if (bestTitle) {
        matchedTitles.add(bestTitle);

        // Extract DOI — OpenAlex returns "https://doi.org/10.xxx" format
        const doi = normaliseDOI(work.doi);
        results.set(bestTitle, doi);

        // Cache the result
        const cacheKey = CACHE_PREFIX + normalizeTitle(bestTitle);
        const cacheEntry: CachedDoiResult = {
          found: doi !== null,
          doi: doi,
        };
        chrome.storage.local.set({ [cacheKey]: cacheEntry }).catch(() => {});
      }
    }

    // Cache negative results for unmatched titles
    for (const title of uncached) {
      if (!results.has(title)) {
        results.set(title, null);
        const cacheKey = CACHE_PREFIX + normalizeTitle(title);
        const cacheEntry: CachedDoiResult = { found: false, doi: null };
        chrome.storage.local.set({ [cacheKey]: cacheEntry }).catch(() => {});
      }
    }
  } catch {
    for (const title of uncached) {
      if (!results.has(title)) {
        results.set(title, null);
      }
    }
  }

  return results;
}
