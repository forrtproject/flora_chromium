import {debugError} from "./debug";

export const RET_MAP_KEY = "RetractionLookupLocal";
// Successful sync generation deliberately evicted by the shared cache budget.
export const RET_BUDGET_EVICTED_SYNC_KEY = "flora_retraction_budget_evicted_sync";

/**
 * Prebuilt retraction data, refreshed daily by the GitHub Action
 * (`.github/workflows/update.yml` -> `retractions-updater.ts`) which parses and
 * filters the Retraction Watch CSV. The extension never parses the CSV itself;
 * it pulls this committed JSON and caches it in `chrome.storage`.
 */
const PREBUILT_JSON_URL =
    'https://raw.githubusercontent.com/forrtproject/chromium-extension/main/src/retractions.json'

/**
 * Maps from an original paper's DOI to the DOI of the notice about it.
 * Built by filtering Retraction Watch on `RetractionNature` (see
 * `retractions-updater.ts`): only papers whose latest status event is a
 * retraction or an expression of concern are kept. Corrections and reinstated
 * papers are dropped entirely.
 */
export interface RetractionMaps {
    /** originalPaperDOI -> retraction notice DOI */
    retractions: Record<string, string>;
    /** originalPaperDOI -> expression-of-concern notice DOI */
    concerns: Record<string, string>;
    lowercasedKeys?: boolean;
}

export async function fetchRetractionMap(): Promise<RetractionMaps | undefined> {
    try {
        const response = await fetch(PREBUILT_JSON_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (data && typeof data === 'object' && data.retractions && data.concerns)
            return data as RetractionMaps;
        debugError("Retractions: unexpected data shape from", PREBUILT_JSON_URL);
    } catch (error) {
        debugError("Retractions: download failed —", error);
    }
}

export async function storageSync(): Promise<boolean> {
    const map = await fetchRetractionMap();
    if (!map) return false;
    await chrome.storage.local.set({[RET_MAP_KEY]: map});
    return true;
}
