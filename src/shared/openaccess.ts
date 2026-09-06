import {activeWorkSignal} from "@shared/work-cancellation";
// Open Access status for a DOI via Unpaywall, cached in chrome.storage.local.
// Used to surface a lock/unlock icon next to the DOIs we inject on the page.

import { getSettings } from "./settings";
import { BlobCache } from "./blob-cache";
import { debugWarn } from "./debug";
import { RequestGate } from "./request-gate";

export interface OpenAccessLocation {
    /** Free full-text URL — the PDF when the location offers one. */
    url: string;
    /** Where the copy lives: publisher name, repository, or the bare host. */
    label: string;
    /** Author manuscript / published version, when Unpaywall states it. */
    version: string | null;
    isPdf: boolean;
}

export interface OpenAccessStatus {
    /** True when Unpaywall reports a free full-text location. */
    isOa: boolean;
    /** Unpaywall answered that this DOI is outside its index. */
    notIndexed?: boolean;
    /** Best free full-text URL (PDF preferred), or null. */
    url: string | null;
    /**
     * Every free copy Unpaywall lists, best first. Absent on entries cached by
     * an older version, which stored only `url`.
     */
    locations?: OpenAccessLocation[];
}

interface UnpaywallLocation {
    url?: string | null;
    url_for_pdf?: string | null;
    host_type?: string | null;
    version?: string | null;
    repository_institution?: string | null;
}

const VERSION_LABELS: Record<string, string> = {
    publishedVersion: "published",
    acceptedVersion: "accepted",
    submittedVersion: "submitted",
};

function hostLabel(url: string): string {
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return "Free copy";
    }
}

function toLocation(raw: UnpaywallLocation): OpenAccessLocation | null {
    const url = raw.url_for_pdf ?? raw.url ?? null;
    if (!url) return null;
    const institution = raw.repository_institution?.trim();
    return {
        url,
        label: institution || (raw.host_type === "publisher" ? "Publisher" : hostLabel(url)),
        version: raw.version ? VERSION_LABELS[raw.version] ?? null : null,
        isPdf: !!raw.url_for_pdf,
    };
}

/** Unpaywall lists the same copy under several locations; one row each is noise. */
function dedupeByUrl(locations: OpenAccessLocation[]): OpenAccessLocation[] {
    const seen = new Set<string>();
    return locations.filter((loc) => !seen.has(loc.url) && seen.add(loc.url));
}

const OA_CACHE = new BlobCache<OpenAccessStatus & {checkedAt?: number}>({
    storageKey: "flora_oa_blob",
    ttlMs: 30 * 24 * 60 * 60 * 1000, // 30 days — OA status changes rarely
});

// One gate per extension context; repeated DOI elements share the same lookup.
const UNPAYWALL_GATE = new RequestGate("Unpaywall", 4);
const pending = new Map<string, {signal?: AbortSignal; request: Promise<OpenAccessStatus | null>}>();

async function getUserEmail(): Promise<string> {
    const { email } = await getSettings();
    return email;
}

/**
 * Resolve a DOI's Open Access status via Unpaywall (cached). Returns null when
 * the lookup can't be performed (no email configured, or the request failed) so
 * callers can choose to render nothing rather than a misleading "no access".
 */
export async function fetchOpenAccess(doi: string): Promise<OpenAccessStatus | null> {
    const signal = activeWorkSignal();
    const cached = await OA_CACHE.get(doi);
    if (cached && (!cached.notIndexed || Date.now() - (cached.checkedAt ?? 0) < 5 * 60 * 1000)) return cached;

    const email = await getUserEmail();
    if (!email) return null;

    // Include email so correcting it can retry immediately while an older request
    // is still running. Provider results themselves are independent of email.
    const key = JSON.stringify([doi, email]);
    const existing = pending.get(key);
    if (existing && existing.signal === signal && !signal?.aborted) return existing.request;
    const request = requestOpenAccess(doi, email, signal).finally(() => {
        if (pending.get(key)?.request === request) pending.delete(key);
    });
    pending.set(key, {signal, request});
    return request;
}

async function requestOpenAccess(doi: string, email: string, signal?: AbortSignal): Promise<OpenAccessStatus | null> {
    try {
        const resp = await UNPAYWALL_GATE.fetch(
            `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`, {signal}
        );
        if (resp.status === 404) {
            const status = {isOa: false, url: null, notIndexed: true, checkedAt: Date.now()};
            void OA_CACHE.set(doi, status);
            return status;
        }
        if (!resp.ok) return null;
        const data = (await resp.json()) as {
            is_oa?: boolean;
            best_oa_location?: UnpaywallLocation | null;
            oa_locations?: UnpaywallLocation[] | null;
        };
        if (typeof data.is_oa !== "boolean") return null;
        const best = data.best_oa_location ? toLocation(data.best_oa_location) : null;
        const rest = (data.oa_locations ?? [])
            .map(toLocation)
            .filter((loc): loc is OpenAccessLocation => loc !== null);
        const locations = dedupeByUrl(best ? [best, ...rest] : rest);
        const status: OpenAccessStatus = {
            isOa: !!data.is_oa,
            url: locations[0]?.url ?? null,
            locations,
        };
        void OA_CACHE.set(doi, status);
        return status;
    } catch (err) {
        debugWarn(`Open access: Unpaywall lookup failed for ${doi} —`, err);
        return null;
    }
}

/** Test-only: drop in-memory cache state so each case starts fresh. */
export function _resetOpenAccessCacheForTesting(): void {
    OA_CACHE.resetForTesting();
}
