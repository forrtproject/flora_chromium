import {fetchWithDeadline} from "./work-cancellation";
// EBSCOhost record id → DOI, one request per record, four in flight. Runs in
// the content script: the endpoint is same-origin on research.ebsco.com and
// authenticated by the session cookie, so no host permission and no worker hop
// are needed.
//
// Endpoint (checked 2026-08), the one the Cite dialog uses:
//   GET /api/search/v5/citation/records/<recordId>
//       ?profileIdentifier=<profile>&citationStyle=apa
//   (both query parameters are required; without them it answers 400)
//   → [{"citeStyleId":"apa", …, "data":"Forestier, C., … <i>Motivation
//      Science</i>, <i>8</i>(1), 19–32. https://doi.org/10.1037/mot0000262"}]
// Records without a DOI (books, dissertations) carry no doi.org URL.

import type {DoiString} from "./types";
import {normaliseDOI} from "./doi-normalise";
import {debugLog, debugWarn} from "./debug";
import {withResolveTimeout} from "./resolve-timeout";

const CITATION_API = "/api/search/v5/citation/records";
// One request per record, so keep the site's own page load in mind.
const MAX_IN_FLIGHT = 4;

/** The profile segment of a research.ebsco.com path (`/c/<profile>/…`). */
export function ebscoProfileFromPath(pathname: string): string | null {
    return /^\/c\/([^/]+)/.exec(pathname)?.[1] ?? null;
}

/** Canonical record id, or null. Accepts a bare id or a
 *  `/c/<profile>/search/details/<recordId>` href. */
export function normaliseEbscoRecordId(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const path = raw.trim().split(/[?#]/)[0] ?? "";
    const segment = path.split("/").filter(Boolean).pop() ?? "";
    return /^[A-Za-z0-9._-]+$/.test(segment) ? segment : null;
}

/** The DOI at the end of an APA citation string, if it carries one. */
export function doiFromCitation(citation: string): DoiString | null {
    const matches = [...citation.matchAll(/https?:\/\/(?:dx\.)?doi\.org\/(\S+)/gi)];
    const last = matches[matches.length - 1];
    if (!last) return null;
    return normaliseDOI(last[1].replace(/[).,;]+$/, ""));
}

async function fetchDoi(recordId: string, profile: string, fetchImpl: typeof fetch): Promise<DoiString | null> {
    const params = new URLSearchParams({profileIdentifier: profile, citationStyle: "apa"});
    const response = await fetchImpl(`${CITATION_API}/${encodeURIComponent(recordId)}?${params.toString()}`, {
        credentials: "include",
        headers: {accept: "application/json"},
    });
    if (!response.ok) throw new Error(`EBSCO HTTP ${response.status}`);
    const data = (await response.json()) as Array<{data?: string}> | null;
    return doiFromCitation(data?.[0]?.data ?? "");
}

/**
 * Resolve EBSCOhost record ids to DOIs, keyed by record id. A record whose
 * citation carries no DOI maps to null; an id absent from the map failed, and
 * the pipeline falls back to a title search for it.
 */
export async function resolveEbscoIds(
    rawIds: string[],
    profile: string | null = ebscoProfileFromPath(location.pathname),
    fetchImpl: typeof fetch = fetchWithDeadline
): Promise<Map<string, DoiString | null>> {
    const results = new Map<string, DoiString | null>();
    const ids = [...new Set(rawIds.map(normaliseEbscoRecordId).filter((id): id is string => id !== null))];
    if (ids.length === 0 || !profile) {
        if (!profile) debugWarn("EBSCO resolve: no profile in the page path, skipping citation lookups");
        return results;
    }

    let next = 0;
    const worker = async (): Promise<void> => {
        for (let i = next++; i < ids.length; i = next++) {
            const id = ids[i];
            try {
                results.set(id, await withResolveTimeout(fetchDoi(id, profile, fetchImpl), `EBSCO resolve ${id}`));
            } catch (err) {
                debugWarn(`EBSCO resolve: ${id} failed —`, err);
            }
        }
    };
    await Promise.all(Array.from({length: Math.min(MAX_IN_FLIGHT, ids.length)}, worker));

    debugLog(`EBSCO resolve: ${[...results.values()].filter(Boolean).length}/${ids.length} record(s) mapped to a DOI`);
    return results;
}
