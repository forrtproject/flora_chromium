import {fetchWithDeadline} from "./work-cancellation";
// Scopus record id → DOI, in one batched call per 50 ids. Runs in the content
// script: the endpoint is same-origin on www.scopus.com and authenticated by
// the session cookie, so no host permission and no worker hop are needed.
//
// Endpoint (checked 2026-08), the one the results page itself uses:
//   POST /gateway/documents/search
//   body    {"query":"EID(2-s2.0-<id>) OR EID(2-s2.0-<id>) …","itemcount":<n>}
//   headers content-type: application/json, accept: application/json
//   → {"metadata":{…},"items":[{"eid":"2-s2.0-105046159914",
//                               "scopusId":"105046159914","doi":"10.…",…}]}

import type {DoiString} from "./types";
import {normaliseDOI} from "./doi-normalise";
import {debugLog, debugWarn} from "./debug";
import {withResolveTimeout} from "./resolve-timeout";

// Relative, so it stays same-origin on both www.scopus.com and scopus.com.
const SCOPUS_SEARCH = "/gateway/documents/search";
// A results page shows at most 200 rows; keep each query string small.
const MAX_IDS_PER_REQUEST = 50;

interface ScopusItem {
    scopusId?: string;
    eid?: string;
    doi?: string | null;
}

/** Canonical digits-only Scopus id, or null when the input isn't one.
 *  Accepts a bare id, a `/pages/publications/<id>` href or an EID. */
export function normaliseScopusId(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const match = /(?:^|\/|2-s2\.0-)(\d{8,})(?=$|[/?#])/.exec(raw.trim());
    return match ? match[1] : null;
}

async function fetchItems(ids: string[], fetchImpl: typeof fetch): Promise<ScopusItem[]> {
    const response = await fetchImpl(SCOPUS_SEARCH, {
        method: "POST",
        credentials: "include",
        headers: {"content-type": "application/json", accept: "application/json"},
        body: JSON.stringify({
            query: ids.map((id) => `EID(2-s2.0-${id})`).join(" OR "),
            itemcount: ids.length,
        }),
    });
    if (!response.ok) throw new Error(`Scopus HTTP ${response.status}`);
    const data = (await response.json()) as {items?: ScopusItem[]};
    return data.items ?? [];
}

/**
 * Resolve Scopus record ids to DOIs, keyed by the digits-only id. A record
 * Scopus holds no DOI for maps to null; an id absent from the map was not
 * returned (unknown id or failed batch), and the pipeline falls back to a
 * title search for it.
 */
export async function resolveScopusIds(
    rawIds: string[],
    fetchImpl: typeof fetch = fetchWithDeadline
): Promise<Map<string, DoiString | null>> {
    const results = new Map<string, DoiString | null>();
    const ids = [...new Set(rawIds.map(normaliseScopusId).filter((id): id is string => id !== null))];
    if (ids.length === 0) return results;

    for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
        const batch = ids.slice(i, i + MAX_IDS_PER_REQUEST);
        try {
            for (const item of await withResolveTimeout(fetchItems(batch, fetchImpl), "Scopus resolve")) {
                const id = normaliseScopusId(item.scopusId ?? item.eid);
                if (!id) continue;
                results.set(id, item.doi ? normaliseDOI(item.doi) : null);
            }
        } catch (err) {
            debugWarn(`Scopus resolve: batch of ${batch.length} failed —`, err);
        }
    }
    debugLog(`Scopus resolve: ${[...results.values()].filter(Boolean).length}/${ids.length} id(s) mapped to a DOI`);
    return results;
}
