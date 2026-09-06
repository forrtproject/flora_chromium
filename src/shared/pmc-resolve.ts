import {fetchWithDeadline} from "./work-cancellation";
// PMC id / PMID → DOI via NCBI's ID Converter. NCBI sends no CORS headers, so
// this only runs in the service worker (see resolvePmcIdsViaWorker).
//
// The converter only knows articles that have a PMC record: an id it cannot
// place maps to null, and callers fall back to a title search.

import type {DoiString} from "./types";
import {normaliseDOI} from "./doi-normalise";
import {getSettings} from "./settings";
import {BlobCache} from "./blob-cache";
import {debugLog, debugWarn} from "./debug";
import {withResolveTimeout} from "./resolve-timeout";

const IDCONV_BASE = "https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/";
// NCBI caps one request at 200 ids.
const MAX_IDS_PER_REQUEST = 200;

const PMC_CACHE = new BlobCache<{doi: string | null}>({
    storageKey: "flora_pmc_blob",
    ttlMs: 30 * 24 * 60 * 60 * 1000, // 30 days
});

interface IdConvRecord {
    doi?: string;
    pmcid?: string;
    /** JSON number in the converter's response. */
    pmid?: number | string;
    "requested-id"?: string;
    status?: string;
    errmsg?: string;
}

/** The id types this module asks the converter about. */
export type NcbiIdType = "pmcid" | "pmid";

/** Canonical `PMC…` form, or null when the input isn't a PMC id. */
export function normalisePmcId(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const match = /^\s*pmc(\d{3,9})\s*$/i.exec(raw);
    return match ? `PMC${match[1]}` : null;
}

/** Bare digits, or null when the input isn't a PubMed id. The converter
 *  returns PMIDs as JSON numbers, so numeric input is accepted too. */
export function normalisePmid(raw: unknown): string | null {
    if (typeof raw !== "string" && typeof raw !== "number") return null;
    const match = /^\s*(?:pmid:?\s*)?(\d{1,9})\s*$/i.exec(String(raw));
    return match ? match[1] : null;
}

const NORMALISERS: Record<NcbiIdType, (raw: unknown) => string | null> = {
    pmcid: normalisePmcId,
    pmid: normalisePmid,
};

async function fetchIdConv(ids: string[], idtype: NcbiIdType, signal?: AbortSignal): Promise<IdConvRecord[]> {
    const {email} = await getSettings();
    const params = new URLSearchParams({
        ids: ids.join(","),
        idtype,
        format: "json",
        versions: "no",
        tool: "flora",
    });
    if (email) params.set("email", email);

    const response = await fetchWithDeadline(`${IDCONV_BASE}?${params.toString()}`, {signal});
    if (!response.ok) throw new Error(`ID converter HTTP ${response.status}`);
    const data = (await response.json()) as {records?: IdConvRecord[]};
    return data.records ?? [];
}

/**
 * Resolve NCBI ids of one type to DOIs, keyed by their canonical form
 * (`PMC…` for PMC ids, bare digits for PMIDs). An id NCBI has no DOI for maps
 * to null; an id absent from the map failed to resolve and is worth retrying.
 */
export async function resolvePmcIds(
    rawIds: string[],
    idtype: NcbiIdType = "pmcid", signal?: AbortSignal
): Promise<Map<string, DoiString | null>> {
    const normalise = NORMALISERS[idtype];
    const results = new Map<string, DoiString | null>();
    const ids = [...new Set(rawIds.map(normalise).filter((id): id is string => id !== null))];
    if (ids.length === 0) return results;

    const cached = await PMC_CACHE.getMany(ids);
    const uncached: string[] = [];
    for (const id of ids) {
        const entry = cached.get(id);
        if (entry) results.set(id, entry.doi ? normaliseDOI(entry.doi) : null);
        else uncached.push(id);
    }
    if (uncached.length === 0) {
        debugLog(`NCBI resolve (${idtype}): ${ids.length} id(s) all cached`);
        return results;
    }

    const updates: Array<[string, {doi: string | null}]> = [];
    for (let i = 0; i < uncached.length; i += MAX_IDS_PER_REQUEST) {
        signal?.throwIfAborted();
        const batch = uncached.slice(i, i + MAX_IDS_PER_REQUEST);
        let records: IdConvRecord[];
        try {
            records = await withResolveTimeout(fetchIdConv(batch, idtype, signal), `NCBI resolve (${idtype})`);
        } catch (err) {
            debugWarn(`NCBI resolve (${idtype}): batch of ${batch.length} failed, retrying next pass —`, err);
            continue;
        }
        for (const record of records) {
            const id = normalise(record["requested-id"]) ?? normalise(record[idtype === "pmid" ? "pmid" : "pmcid"]);
            if (!id) continue;
            const doi = record.status === "error" ? null : normaliseDOI(record.doi);
            results.set(id, doi);
            updates.push([id, {doi}]);
        }
    }

    if (updates.length > 0) await PMC_CACHE.setMany(updates);
    debugLog(`NCBI resolve (${idtype}): ${[...results.values()].filter(Boolean).length}/${ids.length} id(s) mapped to a DOI`);
    return results;
}

/** Test-only: drop in-memory cache state so each case starts fresh. */
export function _resetPmcCacheForTesting(): void {
    PMC_CACHE.resetForTesting();
}
