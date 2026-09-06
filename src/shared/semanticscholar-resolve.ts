import {fetchWithDeadline} from "./work-cancellation";
// Semantic Scholar paper id → DOI, in one batched API call per 500 ids. Runs
// in the service worker (see resolveSemanticScholarIdsViaWorker) so the fetch
// has the api.semanticscholar.org host permission.

import type {DoiString} from "./types";
import {normaliseDOI} from "./doi-normalise";
import {debugLog, debugWarn} from "./debug";
import {withResolveTimeout} from "./resolve-timeout";

const S2_BATCH = "https://api.semanticscholar.org/graph/v1/paper/batch";
// The batch endpoint accepts at most 500 ids per request.
const MAX_IDS_PER_REQUEST = 500;

interface BatchPaper {
    paperId?: string;
    externalIds?: {DOI?: string | null} | null;
}

/** Canonical lower-case 40-hex paper id, or null when the input isn't one.
 *  Accepts a bare id or a /paper/<slug>/<id> href. */
export function normaliseSemanticScholarId(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const match = /(?:^|\/)([0-9a-f]{40})(?=$|[/?#])/i.exec(raw.trim());
    return match ? match[1].toLowerCase() : null;
}

async function fetchPapers(ids: string[], signal?: AbortSignal): Promise<Array<BatchPaper | null>> {
    const response = await fetchWithDeadline(`${S2_BATCH}?fields=externalIds`, {
        signal,
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ids}),
    });
    // The unauthenticated API rate-limits with 429; the pipeline falls back to
    // a title search rather than retrying.
    if (!response.ok) throw new Error(`Semantic Scholar HTTP ${response.status}`);
    return (await response.json()) as Array<BatchPaper | null>;
}

/**
 * Resolve Semantic Scholar paper ids to DOIs, keyed by the canonical lower-case
 * 40-hex id. A paper with no DOI maps to null; an id absent from the map was
 * not returned (unknown id or failed batch).
 */
export async function resolveSemanticScholarIds(rawIds: string[], signal?: AbortSignal): Promise<Map<string, DoiString | null>> {
    const results = new Map<string, DoiString | null>();
    const ids = [...new Set(rawIds.map(normaliseSemanticScholarId).filter((id): id is string => id !== null))];
    if (ids.length === 0) return results;

    for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
        signal?.throwIfAborted();
        const batch = ids.slice(i, i + MAX_IDS_PER_REQUEST);
        try {
            // The response array is aligned with the request; unknown ids come back null.
            const papers = await withResolveTimeout(fetchPapers(batch, signal), "Semantic Scholar resolve");
            papers.forEach((paper, index) => {
                if (!paper) return;
                const doi = paper.externalIds?.DOI;
                results.set(batch[index], doi ? normaliseDOI(doi) : null);
            });
        } catch (err) {
            debugWarn(`Semantic Scholar resolve: batch of ${batch.length} failed —`, err);
        }
    }
    debugLog(
        `Semantic Scholar resolve: ${[...results.values()].filter(Boolean).length}/${ids.length} id(s) mapped to a DOI`
    );
    return results;
}
