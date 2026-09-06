import {fetchWithDeadline} from "./work-cancellation";
// OpenAlex work id → DOI, in one batched API call per 50 ids. Runs in the
// service worker (see resolveOpenAlexIdsViaWorker) so the polite-pool mailto
// and any future pacing sit with the other OpenAlex traffic.

import type {DoiString} from "./types";
import {normaliseDOI} from "./doi-normalise";
import {getSettings} from "./settings";
import {debugLog, debugWarn} from "./debug";
import {withResolveTimeout} from "./resolve-timeout";

const OPENALEX_WORKS = "https://api.openalex.org/works";
// OpenAlex caps a `|`-joined filter at 50 values.
const MAX_IDS_PER_REQUEST = 50;

/** Canonical `W…` form, or null when the input isn't an OpenAlex work id. */
export function normaliseOpenAlexId(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const match = /(?:^|\/)w(\d{4,})\s*$/i.exec(raw.trim());
    return match ? `W${match[1]}` : null;
}

async function fetchWorks(ids: string[], signal?: AbortSignal): Promise<Array<{id?: string; doi?: string | null}>> {
    const {email} = await getSettings();
    const params = new URLSearchParams({
        filter: `openalex:${ids.join("|")}`,
        select: "id,doi",
        "per-page": String(MAX_IDS_PER_REQUEST),
    });
    if (email) params.set("mailto", email);
    const response = await fetchWithDeadline(`${OPENALEX_WORKS}?${params.toString()}`, {signal});
    if (!response.ok) throw new Error(`OpenAlex HTTP ${response.status}`);
    const data = (await response.json()) as {results?: Array<{id?: string; doi?: string | null}>};
    return data.results ?? [];
}

/**
 * Resolve OpenAlex work ids to DOIs, keyed by canonical `W…` form. An id
 * OpenAlex knows but has no DOI for maps to null; an id absent from the map
 * was not returned (unknown id or failed batch).
 */
export async function resolveOpenAlexIds(rawIds: string[], signal?: AbortSignal): Promise<Map<string, DoiString | null>> {
    const results = new Map<string, DoiString | null>();
    const ids = [...new Set(rawIds.map(normaliseOpenAlexId).filter((id): id is string => id !== null))];
    if (ids.length === 0) return results;

    for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
        signal?.throwIfAborted();
        const batch = ids.slice(i, i + MAX_IDS_PER_REQUEST);
        try {
            for (const work of await withResolveTimeout(fetchWorks(batch, signal), "OpenAlex resolve")) {
                const id = normaliseOpenAlexId(work.id);
                if (!id) continue;
                results.set(id, work.doi ? normaliseDOI(work.doi) : null);
            }
        } catch (err) {
            debugWarn(`OpenAlex resolve: batch of ${batch.length} failed —`, err);
        }
    }
    debugLog(`OpenAlex resolve: ${[...results.values()].filter(Boolean).length}/${ids.length} id(s) mapped to a DOI`);
    return results;
}
