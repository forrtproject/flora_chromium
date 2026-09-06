// Result-row pipeline shared by every search site: read rows → resolve each
// row's DOI → look the DOIs up → place one indicator panel per row.
//
// DOI resolution, in order of trust:
//   1. a DOI the row prints or links confidently (doi.org URL, DOI field)
//   2. the site's own record id, resolved through the site's API (adapter.resolveSiteIds)
//   3. a DOI embedded elsewhere in the row, confirmed by doi.org
//   4. a title/author/year search via Crossref/OpenAlex (rendered as unconfirmed)

import type {DoiAugmentRequest} from "@shared/doi-augment";
import {augmentDOIsViaWorker, safeSendMessage} from "@shared/messages";
import {retractionCheck} from "@shared/doi-retraction";
import {validateDOIs} from "@shared/doi-validate";
import type {DoiString, DoiSource, LookupState, RetractionResponse} from "@shared/types";
import type {LookupRequest, LookupResponse} from "@shared/messages";
import {createIndicatorPanel, updateIndicatorPillBadges} from "@shared/indicator-pill";
import {applyPlacement} from "@shared/site-adapters";
import {fetchOpenAccess} from "@shared/openaccess";
import {activeWorkSignal, canStartAutomaticWork, resumeAutomaticWork} from "@shared/work-cancellation";
import {waitUntilVisible} from "@shared/page-visibility";
import {
    beginWorkIndicator,
    count,
    endWorkIndicator,
    isWorkCancelled,
    reportWorkStage,
    setWorkItems,
    updateWorkItem,
    type WorkItem,
} from "@shared/progress-toast";
import {debugError, debugLog, debugWarn} from "@shared/debug";
import type {RowExtraction, SearchSiteAdapter} from "./sites/types";

// One colour for every provenance — an unconfirmed DOI is marked by the
// underline inside the panel, not by a different colour.
const PILL_COLOR = "#853953";

export const PROCESSED_ATTR = "data-flora-processed";

// Replication results and retraction notices arrive from two independent async
// paths. Both accumulate here and re-render together: updating the badges from
// only one source would drop whatever the other had already resolved.
const lookupState = new Map<DoiString, LookupState>();
const retractions = new Map<DoiString, RetractionResponse>();

function refreshBadges(): void {
    updateIndicatorPillBadges(document, lookupState, [...retractions.values()], "panels");
}

// Set by the popup's hide command and by the work toast's pause control (both
// handled in index.ts). The pass reads it to stop marking up rows.
let searchHidden = false;

export function setSearchHidden(hidden: boolean): void {
    searchHidden = hidden;
    if (!hidden) resumeAutomaticWork();
}

export function isSearchHidden(): boolean {
    return searchHidden;
}

// The work toast holds one set of stages and items at a time, so two passes
// running together would overwrite each other's progress. Passes queue here
// instead; each one reads the page when its turn comes, so it picks up every
// row the earlier passes left unprocessed.
let passQueue: Promise<void> = Promise.resolve();
const pendingPasses = new Map<SearchSiteAdapter, Map<ParentNode, Promise<void>>>();

/** Process every not-yet-processed row under `root`, holding one work
 *  indicator across the batch — extraction through to badges. Passes run one
 *  at a time, in call order. */
export function processSearchResults(adapter: SearchSiteAdapter, root: ParentNode): Promise<void> {
    if (!canStartAutomaticWork()) return Promise.resolve();
    let pending = pendingPasses.get(adapter);
    if (!pending) pendingPasses.set(adapter, pending = new Map());
    const existing = pending.get(root);
    if (existing) return existing;
    const next = passQueue.then(async () => {
        try {
            if (!canStartAutomaticWork() || !await waitUntilVisible(activeWorkSignal())) return;
            pending!.delete(root);
            await runQueuedPass(adapter, root);
        } finally {
            if (pending!.get(root) === next) pending!.delete(root);
            if (pending!.size === 0 && pendingPasses.get(adapter) === pending) pendingPasses.delete(adapter);
        }
    });
    pending.set(root, next);
    // Keep the queue itself clean: a rejected pass is reported to its own
    // caller, and must not fail every pass scheduled after it.
    passQueue = next.catch(() => {});
    return next;
}

async function runQueuedPass(adapter: SearchSiteAdapter, root: ParentNode): Promise<void> {
    if (searchHidden || !canStartAutomaticWork()) {
        debugLog(`${adapter.label}: paused on this site — skipping the pass`);
        return;
    }
    const rows = root.querySelectorAll<HTMLElement>(`${adapter.resultRow}:not([${PROCESSED_ATTR}])`);
    debugLog(`${adapter.label}: ${rows.length} new result row(s) to process`);
    if (rows.length === 0) return;

    beginWorkIndicator({stages: ["scan", "validate", "augment", "lookup", "report"]});
    try {
        await runPass(adapter, rows);
    } finally {
        if (isWorkCancelled()) {
            // A panel is placed before its lookup completes; it is not evidence of completion.
            for (const row of rows) {
                row.querySelectorAll("[data-flora-panel]").forEach(panel => panel.remove());
                row.removeAttribute(PROCESSED_ATTR);
            }
        }
        endWorkIndicator();
    }
}

interface RowInfo extends RowExtraction {
    row: HTMLElement;
}

interface ResolvedRow {
    row: HTMLElement;
    title: string;
    doi: DoiString;
    source: DoiSource;
}

async function runPass(adapter: SearchSiteAdapter, rows: NodeListOf<HTMLElement>): Promise<void> {
    const {label} = adapter;
    reportWorkStage("scan", `Reading ${count(rows.length, `${label} result`)}…`);

    const resolved: ResolvedRow[] = [];
    const place = (info: RowInfo, doi: DoiString, source: DoiSource, isAugmented: boolean, provenanceLabel?: string): void => {
        resolved.push({row: info.row, title: info.title, doi, source});
        void placePanel(adapter, info.row, doi, isAugmented, provenanceLabel);
    };

    // Phase 1: read every row. Confident DOIs are placed immediately; the rest
    // queue for site-id resolution, validation and augmentation.
    let pending: RowInfo[] = [];
    for (const row of rows) {
        row.setAttribute(PROCESSED_ATTR, "true");
        let extraction: RowExtraction | null;
        try {
            extraction = adapter.extractRow(row);
        } catch (err) {
            debugWarn(`${label}: could not read a result row —`, err);
            continue;
        }
        if (!extraction) continue;
        const info: RowInfo = {...extraction, row};
        if (info.doi && info.confident) {
            debugLog(`${label} resolve [confident] "${info.title}" → ${info.doi}`);
            place(info, info.doi, "extracted", false);
        } else {
            pending.push(info);
        }
    }

    // Phase 2: the site's own ids → DOIs, one batched call.
    const withSiteId = pending.filter((r) => r.siteId);
    if (withSiteId.length > 0 && adapter.resolveSiteIds) {
        reportWorkStage("validate", `Resolving ${count(withSiteId.length, `${label} record`)} to DOIs…`);
        setWorkItems(withSiteId.map((r) => workItem(r.siteId!, r.title, rowByline(r))));
        let bySiteId = new Map<string, DoiString | null>();
        try {
            bySiteId = await adapter.resolveSiteIds(withSiteId.map((r) => r.siteId!));
        } catch (err) {
            debugWarn(`${label}: id resolution failed for ${withSiteId.length} row(s) —`, err);
        }
        for (const info of withSiteId) {
            const doi = bySiteId.get(info.siteId!) ?? null;
            updateWorkItem(info.siteId!, doi ? "done" : "failed", doi ?? "no DOI on record");
        }
        if (isWorkCancelled()) return;
        pending = pending.filter((info) => {
            const doi = info.siteId ? bySiteId.get(info.siteId) : undefined;
            if (!doi) return true;
            debugLog(`${label} resolve [site-id] "${info.title}" → ${doi} (${info.siteId})`);
            place(info, doi, "extracted", false, `Taken from ${label}'s own record of this work`);
            return false;
        });
    }

    // Phase 3: DOIs found in the row but not confidently — confirm with doi.org.
    const withDoi = pending.filter((r) => r.doi);
    const doisToValidate = withDoi.map((r) => r.doi!);
    let validated = new Map<DoiString, boolean>();
    if (doisToValidate.length > 0) {
        reportWorkStage("validate", `Checking ${count(doisToValidate.length, "DOI")} resolve…`);
        setWorkItems(withDoi.map((r) => workItem(r.doi!, r.title, r.doi!)));
        try {
            validated = await validateDOIs(doisToValidate);
        } catch (err) {
            debugWarn(`${label}: validation failed for ${doisToValidate.length} DOI(s) —`, err);
        }
        for (const doi of doisToValidate) {
            updateWorkItem(doi, validated.get(doi) ? "done" : "failed");
        }
        if (isWorkCancelled()) return;
    }
    pending = pending.filter((info) => {
        if (!(info.doi && validated.get(info.doi))) return true;
        debugLog(`${label} resolve [doi.org-validated] "${info.title}" → ${info.doi}`);
        place(info, info.doi, "extracted", false);
        return false;
    });

    // Phase 4: title search for whatever is still unresolved. The worker keys
    // its answers by title, so rows that print the same title share one search:
    // ask once per distinct title, and give the toast one item for it.
    if (pending.length > 0) {
        const byTitle = new Map<string, RowInfo>();
        for (const info of pending) {
            if (info.title && !byTitle.has(info.title)) byTitle.set(info.title, info);
        }
        const titled = [...byTitle.values()];
        const requests: DoiAugmentRequest[] = titled
            .map((r) => ({title: r.title, firstAuthor: r.firstAuthor, year: r.year, sourceUrl: r.sourceUrl}));
        let augmented = new Map<string, DoiString | null>();
        if (requests.length > 0) {
            reportWorkStage("augment", `Augmenting ${count(requests.length, "result")} without a DOI…`);
            setWorkItems(titled.map((r) => workItem(r.title, r.title, rowByline(r))));
            try {
                augmented = await augmentDOIsViaWorker(requests);
            } catch (err) {
                debugWarn(`${label}: augmentation failed for ${requests.length} row(s) —`, err);
            }
            for (const info of titled) {
                const doi = augmented.get(info.title) ?? null;
                updateWorkItem(info.title, doi ? "done" : "failed", doi ?? "no DOI found");
            }
            if (isWorkCancelled()) return;
        }

        // Rows whose extracted DOI the title search neither matched nor
        // replaced get one last doi.org check — batched, so a page of them
        // costs one round of requests rather than one per row.
        const toRevalidate = [
            ...new Set(
                pending
                    .filter((info) => info.doi && !augmented.get(info.title))
                    .map((info) => info.doi!)
            ),
        ];
        let revalidated = new Map<DoiString, boolean>();
        if (toRevalidate.length > 0) {
            try {
                revalidated = await validateDOIs(toRevalidate);
            } catch (err) {
                debugWarn(`${label}: revalidation failed for ${toRevalidate.length} DOI(s) —`, err);
            }
        }

        for (const info of pending) {
            const augmentedDoi = augmented.get(info.title) ?? null;
            const extractedDoi = info.doi;

            if (extractedDoi && augmentedDoi === extractedDoi) {
                // Cross-validated: row extraction matches the title search
                debugLog(`${label} resolve [cross-validated] "${info.title}" → ${extractedDoi} (extracted = augmented)`);
                place(info, extractedDoi, "extracted", false);
            } else if (extractedDoi && augmentedDoi) {
                // Conflict: prefer the augmented DOI (rendered as unconfirmed)
                debugLog(`${label} resolve [conflict] "${info.title}" → using augmented ${augmentedDoi} (extracted was ${extractedDoi})`);
                place(info, augmentedDoi, "augmented", true);
            } else if (extractedDoi) {
                // Extracted but the title search found nothing — last-resort
                // doi.org check. validateDOIs answers false only when doi.org
                // says the DOI is absent; a DOI it could not reach is left out
                // of the map entirely.
                const validity = revalidated.get(extractedDoi);
                if (validity === true) {
                    debugLog(`${label} resolve [extracted-revalidated] "${info.title}" → ${extractedDoi} (doi.org confirmed on retry)`);
                    place(info, extractedDoi, "extracted", false);
                } else if (validity === false) {
                    // The handle does not exist, so the DOI was never registered
                    // and this row's identity is unknown — no FLoRA UI at all.
                    // Not even a retraction notice: a notice must never outlive
                    // the identity check that produced it.
                    debugLog(`${label} resolve [extracted-invalid] "${info.title}" → ${extractedDoi} rejected (doi.org says invalid)`);
                } else {
                    // doi.org never answered. Hand the row back unprocessed so
                    // the next pass can try it, rather than calling a DOI
                    // invalid on a network failure.
                    info.row.removeAttribute(PROCESSED_ATTR);
                    debugLog(`${label} resolve [extracted-unresolved] "${info.title}" → ${extractedDoi} left for a later pass (doi.org did not answer)`);
                }
            } else if (augmentedDoi) {
                debugLog(`${label} resolve [augmented-only] "${info.title}" → ${augmentedDoi} (no extraction)`);
                place(info, augmentedDoi, "augmented", true);
            } else {
                debugLog(`${label} resolve [no-doi] "${info.title}" → no DOI from extraction or augmentation`);
            }
        }
    }

    const extractedCount = resolved.filter((r) => r.source === "extracted").length;
    debugLog(`${extractedCount} DOIs from ${label}, ${resolved.length - extractedCount} augmented via Crossref/OpenAlex`);
    if (resolved.length === 0) return;

    const uniqueDois = [...new Set(resolved.map((r) => r.doi))];
    debugLog(`${label}: Sending lookup for`, uniqueDois.length, "unique DOIs:", uniqueDois);
    reportWorkStage("lookup", `Found ${count(uniqueDois.length, "unique DOI")} — looking them up…`);
    const titleByDoi = new Map<DoiString, string>();
    for (const {doi, title} of resolved) {
        if (!titleByDoi.has(doi)) titleByDoi.set(doi, title);
    }
    setWorkItems(uniqueDois.map((doi) => workItem(doi, titleByDoi.get(doi) ?? doi, doi)));
    const request: LookupRequest = {type: "FLORA_LOOKUP", dois: uniqueDois};

    try {
        const response = await safeSendMessage<LookupResponse>(request);
        if (!response) return; // extension reloaded underneath this page — stop quietly
        debugLog(`${label}: Lookup response:`, Object.keys(response.results).length, "results,", Object.keys(response.errors).length, "errors");

        let badgedCount = 0;
        for (const {doi, source} of resolved) {
            if (response.results[doi]) {
                lookupState.set(doi, {status: "matched", result: response.results[doi], source});
                badgedCount++;
            }
        }
        for (const doi of uniqueDois) {
            if (response.errors[doi]) updateWorkItem(doi, "failed");
            else updateWorkItem(doi, response.results[doi] ? "flagged" : "done");
        }

        // Paused or cancelled while the lookup ran — the results stay in
        // lookupState for a later pass, but nothing goes on the page.
        if (searchHidden || isWorkCancelled()) return;

        reportWorkStage("report", `Marking up ${count(badgedCount, "result")}…`);
        refreshBadges();
        debugLog(`${label}: Rendered`, badgedCount, "badge(s)");
    } catch (err) {
        debugLog(`${label}: Lookup failed:`, err);
    }
}

/** Scholar prefixes headings with type tags ("[HTML]", "[PDF]"); the toast shows the title alone. */
function stripTypeTags(title: string): string {
    return title.replace(/^(\s*\[[A-Z]+\])+\s*/, "");
}

/** First author and year of a row, for the item's right-hand detail column. */
function rowByline(info: {firstAuthor: string | null; year: number | null}): string | undefined {
    const parts = [info.firstAuthor, info.year?.toString()].filter(Boolean);
    return parts.length > 0 ? parts.join(" ") : undefined;
}

/** One work-toast item, pending until its stage reports back on it. */
function workItem(id: string, label: string, detail?: string): WorkItem {
    return {id, label: stripTypeTags(label) || id, detail, status: "pending"};
}

/** Build the row's panel, place it per the adapter, then fetch its retraction status. */
async function placePanel(
    adapter: SearchSiteAdapter,
    row: HTMLElement,
    doi: DoiString,
    isAugmented: boolean,
    provenanceLabel?: string
): Promise<void> {
    try {
        const panel = createIndicatorPanel({
            doi,
            color: PILL_COLOR,
            isAugmented,
            provenanceLabel,
            oaStatus: fetchOpenAccess(doi),
            retraction: retractions.get(doi) ?? null,
        });
        adapter.preparePanelTarget?.(row);
        if (!applyPlacement(adapter.panelPlacement, row, panel, `${adapter.label} panel`)) {
            row.appendChild(panel);
        }
        const notices = await retractionCheck([doi]);
        if (notices?.[0]) {
            retractions.set(doi, notices[0]);
            refreshBadges();
        }
    } catch (err) {
        debugError(`${adapter.label}: could not label ${doi} —`, err);
    }
}
