import {activeWorkSignal} from "@shared/work-cancellation";
import {waitForWorkToFinish} from "@shared/progress-toast";
import {
    beginDomScanPass,
    classifyPageDois,
    extractDOIs,
    extractDOIsFromText,
    extractDoiOccurrences,
    extractPrimaryDOI
} from "@shared/doi-extractor";
import {fetchTitleByDoi, type DoiAugmentRequest} from "@shared/doi-augment";
import {validateDOIs} from "@shared/doi-validate";
import type {ClassifiedDois, DoiContext, DoiString, LookupState} from "@shared/types";
import {
    safeSendMessage,
    augmentDOIsViaWorker,
    type LookupRequest,
    type LookupResponse
} from "@shared/messages";
import {
    beginWorkIndicator,
    count,
    endWorkIndicator,
    isWorkCancelled,
    reportWorkStage,
    hideAllFloraUI,
    removeSidePanel,
    removeSheetsModal,
    renderErrorBanner,
    renderSidePanel,
    renderSetupPrompt,
    renderSheetsModal,
    type SheetsModalCallbacks,
    showAllFloraUI
} from "./injector";
import {lookupPubPeer, lookupPubPeerForDois, type PubPeerFeedback} from "@shared/pubpeer-api";
import {debugError, debugLog, debugWarn} from "@shared/debug";
import {installErrorReporting, reportCodeError} from "@shared/error-report";
import {isOwnRepoUrl} from "@shared/debug-report";
import {isSetupComplete} from "@shared/settings";
import {isDomainBlocked, isDomainSnoozed} from "@shared/domains";
import {isBotCheckPage} from "@shared/bot-check";
import {isAuthGatewayPage} from "@shared/auth-page";
import {injectInlineRetractionPills, injectRetractionInfo, resetRetractionPills, retractionCheck, RetractionResponse} from "@shared/doi-retraction"
import {createIndicatorPill, removeIndicatorPills, updateIndicatorPillBadges, INDICATOR_PILL_CLASS} from "@shared/indicator-pill";
import {applyPillStyle, applyPlacement, currentSiteAdapter} from "@shared/site-adapters";

import {fetchOpenAccess} from "@shared/openaccess";
import {showToast, dismissToast} from "@shared/toast";
import {resolveReferenceDois, renderResolvedReferences, releaseReferenceEntries, resetReferenceMarkers, type ResolvedReference} from "./references";
import {fetchSheetCsv, parseSheetsUrl, sheetTabKey} from "./sheets";
import {canStartAutomaticWork, resumeAutomaticWork} from "@shared/work-cancellation";
import {waitUntilVisible} from "@shared/page-visibility";
import {SeenDois} from "./seen-dois";
import {serializeWithRerun} from "./serial-scan";
import {startDomListener} from "./dom-listener";

const pageState = new Map<DoiString, LookupState>();
// Retraction notices for the page: `pageNotices` is replaced by each check of
// the page's own DOIs, `refNotices` accumulates those of resolved references
// (whose DOIs are not on the page), and `redacts` is the union everyone reads.
let redacts: RetractionResponse[] = [];
let pageNotices: RetractionResponse[] = [];
const refNotices = new Map<DoiString, RetractionResponse>();
const unavailableRetractionDois = new Set<DoiString>();
let retractionRetryToast: HTMLElement | null = null;
let retractionRetryQueued = false;
function dismissRetractionRetry(): void {
    // Other provider alerts reuse this host; do not dismiss their newer message.
    if (retractionRetryToast?.textContent?.includes("Retraction checks unavailable.")) retractionRetryToast.remove();
    retractionRetryToast = null;
}
function refreshRedacts(): void {
    const onPage = new Set(pageNotices.map((n) => n.originDoi));
    redacts = [...pageNotices, ...[...refNotices.values()].filter((n) => !onPage.has(n.originDoi))];
}
// Reference resolution still running after the pass that started it, and the
// "nothing to flag" verdict it must complete before that toast is shown.
let refsPending = 0;
let lastResolvedReferences: ResolvedReference[] = [];
let pendingNothingToFlag: {dois: DoiString[]; flagged: boolean} | null = null;
// Keep memory of detected DOIs to track dynamic page changes
const processedDois = new Set<DoiString>();
const seenDois = new SeenDois();
const doiContext = new Map<DoiString, DoiContext>();
let lastUrl = location.href;
let augmentAttempted = false;
let articleFeedbacksFetched = false;
let articlePubPeerUnavailable = false;
let lastReferenceDoiKey = "";
let lastArticleFeedbacks: PubPeerFeedback[] = [];
// Monotonically increments when FORRT lookup results land in pageState.
let pageStateVersion = 0;
let lastRenderedPageStateVersion = -1;
/** Monotonic counter — incremented on each sheet tab switch to discard stale CSV responses. */
let sheetFetchGen = 0;
// DOIs extracted from the full sheet CSV (populated asynchronously on Sheets)
let sheetCsvDois: DoiString[] = [];
// Sheet tabs where the user explicitly dismissed the modal (session only).
const dismissedSheets = new Set<string>();
// Timestamp until which all Sheets modals are snoozed.
let snoozeUntil = 0;
// Google sheets match condition
const isSheets = location.href.includes("docs.google.com/spreadsheets");
// Track whether the popup has hidden FLoRA UI on this page (session only)
let floraHidden = false;

// Tell the service worker whether FLoRA is active on this tab so it can swap the
// toolbar icon (maroon = active, gray = inactive).
function reportActiveState(active: boolean): void {
    try {
        chrome.runtime.sendMessage({type: "FLORA_ACTIVE_STATE", active}).catch(() => {});
    } catch {
        // extension context unavailable — ignore
    }
}

// Listen for popup messages (works regardless of gate checks above)
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (typeof message !== "object" || message === null) return;
    const type = (message as { type?: string }).type;

    if (type === "FLORA_HIDE_UI") {
        floraHidden = true;
        hideAllFloraUI();
        reportActiveState(false);
        sendResponse({ok: true});
    } else if (type === "FLORA_SHOW_UI") {
        floraHidden = false;
        resumeAutomaticWork();
        updateIndicatorPillBadges(document, pageState, redacts);
        showAllFloraUI();
        void scanWholePage().catch((err) => debugError("General: resumed pass failed —", err));
        reportActiveState(true);
        sendResponse({ok: true});
    } else if (type === "FLORA_GET_STATE") {
        sendResponse({hidden: floraHidden});
    }
});

// The pause control on the work toast writes the snooze (or block) to storage
// itself, then announces it here so this page clears immediately instead of
// waiting for a reload.
document.addEventListener("flora-pause-site", () => {
    floraHidden = true;
    hideAllFloraUI();
    reportActiveState(false);
});

async function primaryDoiFastPath(): Promise<void> {
    if (floraHidden || !canStartAutomaticWork()) return;
    const primary = extractPrimaryDOI(document);
    if (!primary) return;

    debugLog("General: primary DOI fast path —", primary);
    processedDois.add(primary);
    doiContext.set(primary, "article");
    pageState.set(primary, {status: "loading"});

    const rollback = (): void => {
        processedDois.delete(primary);
        pageState.delete(primary);
        doiContext.delete(primary);
    };

    beginWorkIndicator({stages: ["scan"]});
    try {
        // "scan", not "lookup": the bar only moves forward, and the full page
        // pass runs alongside this one.
        reportWorkStage("scan", "Looking up this article…");
        const request: LookupRequest = {type: "FLORA_LOOKUP", dois: [primary]};
        const response = await safeSendMessage<LookupResponse>(request);
        if (!response) {
            rollback();
            return;
        }
        if (response.errors[primary]) {
            pageState.set(primary, {status: "error", message: response.errors[primary]});
        } else if (response.results[primary]) {
            pageState.set(primary, {
                status: "matched",
                result: response.results[primary],
                source: "extracted"
            });
        } else {
            pageState.set(primary, {status: "no-match"});
        }
        pageStateVersion++;

        placeTitleIndicatorPill();
        updateIndicatorPillBadges(document, pageState, redacts);
    } catch (err) {
        debugError(`Primary DOI fast path failed for ${primary} —`, err);
        rollback();
    } finally {
        endWorkIndicator();
    }
}

function whenIdle(fn: () => void, timeout = 1000): void {
    const ric = (window as unknown as {
        requestIdleCallback?: (cb: () => void, opts?: {timeout: number}) => number;
    }).requestIdleCallback;
    if (typeof ric === "function") {
        ric(fn, {timeout});
    } else {
        setTimeout(fn, 0);
    }
}

// Coalesce repeated mutation callbacks, including while the tab is in the background.
const runScanPasses = serializeWithRerun(async () => {
    if (!canStartAutomaticWork() || !await waitUntilVisible(activeWorkSignal())) return;
    if (floraHidden || !canStartAutomaticWork()) return;
    beginWorkIndicator({stages: ["scan", "validate", "augment", "notices", "lookup", "report"]});
    try {
        await runScanPass();
    } finally {
        endWorkIndicator();
    }
});

async function scanWholePage(): Promise<void> {
    if (floraHidden || !canStartAutomaticWork()) return;
    await runScanPasses();
}

let nothingToFlagReportedFor: string | null = null;

function reportNothingToFlag(dois: DoiString[], flagged: boolean): void {
    const examined = new Set(dois).size;
    if (examined === 0 || flagged || unavailableRetractionDois.size > 0 || dois.some(doi => pageState.get(doi)?.status === "error")) return;
    if (nothingToFlagReportedFor === location.href) return;
    nothingToFlagReportedFor = location.href;
    showToast(`Checked ${count(examined, "paper")} — no flags in available results`, {tone: "success"});
}

/** Preserve unavailable checks for an explicit retry, independently of DOI scan markers. */
async function checkPageRetractions(dois: DoiString[]): Promise<RetractionResponse[]> {
    const passUrl = location.href;
    const generation = sheetFetchGen;
    const signal = activeWorkSignal();
    const stale = () => signal?.aborted || floraHidden || isWorkCancelled()
        || location.href !== passUrl || generation !== sheetFetchGen;
    try {
        const notices = await retractionCheck(dois);
        if (stale()) return [];
        for (const doi of dois) unavailableRetractionDois.delete(doi);
        if (unavailableRetractionDois.size === 0) dismissRetractionRetry();
        return notices;
    } catch (error) {
        if (stale()) return [];
        for (const doi of dois) unavailableRetractionDois.add(doi);
        if (error instanceof Error && error.message.includes("Extension context invalidated")) {
            showToast("ORE was updated — reload this page to run checks.", {
                action: {label: "Reload", onClick: () => location.reload()},
            });
            return [];
        }
        debugWarn("Retraction checks unavailable —", error);
        retractionRetryToast = showToast("Retraction checks unavailable. Other results are still shown.", {
            tone: "error", duration: 0,
            action: {label: "Retry", onClick: async () => {
                if (floraHidden || location.href !== passUrl || generation !== sheetFetchGen) { dismissRetractionRetry(); return; }
                if (retractionRetryQueued) return;
                const queuedSignal = activeWorkSignal();
                const wasCancelled = queuedSignal?.aborted;
                retractionRetryQueued = true;
                try { await waitForWorkToFinish(); }
                finally { retractionRetryQueued = false; }
                if (floraHidden || location.href !== passUrl || generation !== sheetFetchGen || (!wasCancelled && queuedSignal?.aborted)) return;
                resumeAutomaticWork();
                beginWorkIndicator({stages: ["notices"]});
                try {
                    const recovered = await checkPageRetractions([...unavailableRetractionDois]);
                    if (floraHidden || isWorkCancelled() || location.href !== passUrl || generation !== sheetFetchGen) return;
                    for (const notice of recovered) refNotices.set(notice.originDoi, notice);
                    refreshRedacts();
                    if (isSheets) {
                        const matched = [...pageState.entries()].flatMap(([doi, state]) =>
                            state.status === "matched" ? [{doi, result: state.result}] : []);
                        if (!isSheetsModalSuppressed()) renderSheetsModal(matched, redacts, sheetsModalCallbacks);
                    } else {
                        placeTitleNoticePill();
                        for (const pill of document.querySelectorAll<HTMLElement>(`.${INDICATOR_PILL_CLASS}`)) {
                            const notice = recovered.find(n => n.originDoi === pill.getAttribute("data-flora-doi"));
                            if (notice) injectRetractionInfo(pill, notice, {afterend: true});
                        }
                        injectInlineRetractionPills(extractDoiOccurrences(document), new Map(redacts.map(n => [n.originDoi, n])));
                        updateIndicatorPillBadges(document, pageState, redacts);
                        lastRenderedPageStateVersion = -1;
                        await checkPubPeer(Promise.resolve(lastResolvedReferences));
                    }
                } finally { endWorkIndicator(); }
            }},
        });
        return [];
    }
}

async function runScanPass(): Promise<void> {
    if (floraHidden || !canStartAutomaticWork()) return;
    // Detect full URL change (SPA navigation) — clear state
    const currentUrl = location.href;
    const sheetGeneration = sheetFetchGen;
    const sheetIdentity = isSheets ? currentSheetKey() : null;
    const sheetChanged = () => isSheets && (sheetGeneration !== sheetFetchGen || sheetIdentity !== currentSheetKey());
    if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        processedDois.clear();
        seenDois.clear();
        doiContext.clear();
        lastArticleFeedbacks = [];
        articleFeedbacksFetched = false;
        articlePubPeerUnavailable = false;
        lastReferenceDoiKey = "";
        lastRenderedPageStateVersion = -1;
        pageState.clear();
        redacts = [];
        pageNotices = [];
        refNotices.clear();
        lastResolvedReferences = [];
        unavailableRetractionDois.clear();
        dismissRetractionRetry();
        pendingNothingToFlag = null;
        augmentAttempted = false;
        resetRetractionPills();
        removeIndicatorPills();
        resetReferenceMarkers();
        if (isSheets) {
            removeSheetsModal();
        } else {
            removeSidePanel();
        }
    }
    // Fresh DOM scan pass — resets the per-pass findReferenceContainers memo.
    beginDomScanPass();
    reportWorkStage("scan", "Scanning this page for DOIs…");

    // Resolve reference-list DOIs in parallel with the FORRT lookup below.
    const refsPromise = isSheets ? Promise.resolve([]) : resolveReferenceDois();

    // Non-Sheets: one classification scan (allDois). Sheets: canvas extractDOIs + CSV.
    let dois: DoiString[];
    let classified: ClassifiedDois | null = null;
    if (isSheets) {
        dois = extractDOIs(document);
        if (sheetCsvDois.length > 0) {
            dois = [...new Set([...dois, ...sheetCsvDois])];
        }
    } else {
        classified = classifyPageDois(document);
        dois = classified.allDois;
    }

    // DOI occurrences with source + anchor, so badges place without re-scanning.
    const occurrences = extractDoiOccurrences(document);

    const hasDoiChange = seenDois.hasUnseen(dois);
    seenDois.mark(dois);

    // Populate per-DOI context only when the set changed (idempotent map sets).
    if (classified && hasDoiChange) {
        for (const doi of classified.articleDois) doiContext.set(doi, "article");
        for (const doi of classified.referenceDois) doiContext.set(doi, "reference");
        for (const doi of classified.otherDois) doiContext.set(doi, "other");
        debugLog("General: pageType =", classified.pageType);
        debugLog(classified.articleDois, "article DOIs,", classified.referenceDois, "reference DOIs,", classified.otherDois, "other DOIs");
    }
    debugLog(isSheets ? "Sheets:" : "General:", "Extracted DOIs:", dois.length, dois);
    reportWorkStage("scan", `Found ${count(dois.length, "DOI")} on this page`);

    // Validate extracted DOIs via doi.org — remove invalid ones
    if (hasDoiChange && !isSheets && dois.length > 0) {
        beginWorkIndicator();
        try {
            reportWorkStage("validate", `Checking ${count(dois.length, "DOI")} resolve…`);
            const validation = await validateDOIs(dois);
            const before = dois.length;
            dois = dois.filter((doi) => validation.get(doi) !== false);
            const removed = before - dois.length;
            if (removed > 0) {
                debugLog(`Validation: removed ${removed} invalid DOI(s)`);
            }
        } catch (err) {
            debugWarn(`Validation unavailable for ${dois.length} DOI(s) — keeping them all:`, err);
        } finally {
            endWorkIndicator();
        }
    }

    // Drop occurrences inside FLoRA's own UI so we don't pill our own panel rows.
    const FLORA_UI_IDS = ["flora-pubpeer-panel", "flora-banner-host", "flora-setup-prompt", "flora-sheets-modal"];
    const pageOccurrences = occurrences.filter(
        (occ) => !FLORA_UI_IDS.some((id) => occ.anchor.closest(`#${id}`) !== null)
    );

    // Retraction check for the page's own DOIs. Reference resolution (title
    // augmentation, PMC ids) can take many seconds against rate-limited APIs,
    // so the pass does not wait for it: finishReferences() pills those
    // references when their DOIs arrive.
    if (hasDoiChange && dois.length > 0) {
        reportWorkStage("notices", `Checking ${count(dois.length, "DOI")} for retractions…`);
        const notices = await checkPageRetractions(dois);
        if (sheetChanged()) return;
        pageNotices = notices;
        refreshRedacts();
        // A noticed DOI gets one labelled pill, at its most prominent
        // occurrence. The title outranks any mention in the body, so the
        // title claims its notice before the occurrence pass runs — the
        // per-DOI guard in injectRetractionInfo then skips the body mentions.
        if (!isSheets) {
            placeTitleIndicatorPill();
            placeTitleNoticePill();
        }
        injectInlineRetractionPills(
            pageOccurrences,
            new Map(redacts.map((r) => [r.originDoi, r] as const)),
        );
    }
    const refsDone = finishReferences(refsPromise);

    // Filter out already-processed DOIs
    const newDois = dois.filter((doi) => !processedDois.has(doi));

    // If no valid DOIs found, try augmenting from page title in the background
    if (newDois.length === 0 && dois.length === 0) {
        debugLog("No valid DOIs found on page, attempting title augmentation");
        if (!isSheets) placeTitleIndicatorPill();
        if (!isSheets) updateIndicatorPillBadges(document, pageState, redacts);
        if (!isSheets) augmentFromTitle().catch((err) => debugError("Title augmentation failed —", err));
        if (!isSheets) void checkPubPeer(refsDone);
        return;
    }

    if (newDois.length === 0) {
        debugLog("No new DOIs (all already processed)");
        // Re-place the title pills against the live DOM — hydrating SPAs (e.g.
        // Sage) re-render and wipe previously placed pills, and this pass
        // (triggered by that mutation) would otherwise return without restoring them.
        if (!isSheets) placeTitleIndicatorPill();
        if (!isSheets) placeTitleNoticePill();
        if (!isSheets) updateIndicatorPillBadges(document, pageState, redacts);
        if (!isSheets) void checkPubPeer(refsDone);
        return;
    }
    debugLog(isSheets ? "Sheets:" : "General:", "New DOIs to look up:", newDois.length, newDois);

    for (const doi of newDois) {
        processedDois.add(doi);
    }

    // Mark all as loading
    for (const doi of newDois) {
        pageState.set(doi, {status: "loading"});
    }

    const request: LookupRequest = {type: "FLORA_LOOKUP", dois: newDois};

    beginWorkIndicator();
    try {
        // Only the lookup itself gets the error banner. Everything after it is
        // our own rendering, and a throw there is a bug on this page's markup —
        // reporting that as a failed lookup sends the reader chasing an outage
        // that isn't happening.
        let response: LookupResponse | undefined;
        try {
            reportWorkStage("lookup", `Looking up ${count(newDois.length, "DOI")} in FLoRA…`);
            response = await safeSendMessage<LookupResponse>(request);
        } catch (err) {
            if (sheetChanged()) return;
            if (isWorkCancelled()) {
                for (const doi of newDois) {
                    processedDois.delete(doi);
                    pageState.delete(doi);
                }
                pageStateVersion++;
                return;
            }
            debugError("Replication lookup failed:", err);
            for (const doi of newDois) pageState.set(doi, {status: "error", message: "FORRT unavailable"});
            pageStateVersion++;
            if (floraHidden) return;
            if (!isSheets) placeTitleIndicatorPill();
            updateIndicatorPillBadges(document, pageState, redacts);
            renderErrorBanner("Couldn't load replication data for this page");
            return;
        }
        if (sheetChanged()) return;
        if (!response) {
            // Extension context invalidated (reload/update) — stale script, stop quietly.
            if (!isSheets) placeTitleIndicatorPill();
            return;
        }
        debugLog("Lookup response:", Object.keys(response.results).length, "results,", Object.keys(response.errors).length, "errors");

        for (const doi of newDois) {
            if (response.errors[doi]) {
                pageState.set(doi, {
                    status: "error",
                    message: response.errors[doi]
                });
            } else if (response.results[doi]) {
                pageState.set(doi, {
                    status: "matched",
                    result: response.results[doi],
                    source: "extracted"
                });
            } else {
                pageState.set(doi, {status: "no-match"});
            }
        }
        pageStateVersion++; // signal that replication data is now available

        // Paused, hidden or cancelled while the lookup ran — the results stay
        // in pageState for a later pass, but nothing goes on the page.
        if (floraHidden || isWorkCancelled()) return;

        try {
            reportWorkStage("report", "Generating report…");
            // Collect matched DOIs for display
            // On Sheets, skip the "still in DOM" re-check — the canvas DOM is unreliable
            const currentDois = isSheets ? null : new Set(dois);
            const matched = [...pageState.entries()]
                .filter(([doi, s]) => {
                    if (s.status !== "matched") return false;
                    if (!isSheets && !currentDois!.has(doi)) return false;
                    // Only include DOIs that actually have replication or reproduction data
                    const stats = s.result.record.stats;
                    return stats.n_replications_total > 0 || stats.n_reproductions_total > 0;
                })
                .map(([doi, s]) => ({
                    doi,
                    result: (s as {
                        status: "matched";
                        result: import("../shared/types").ReplicationResult;
                        source: "extracted"
                    }).result,
                }));

            debugLog("Matched DOIs with replication data:", matched.length, matched.map(m => m.doi));
            if (isSheets) {
                if (isSheetsModalSuppressed()) removeSheetsModal();
                else renderSheetsModal(matched, redacts, sheetsModalCallbacks);
            } else {
                void checkPubPeer(refsDone);
            }

            // Merged indicator pills (skip on Google Sheets — modal only).
            if (!isSheets) {
                placeTitleIndicatorPill();
                updateIndicatorPillBadges(document, pageState, redacts);
                const flagged = matched.length > 0 || redacts.length > 0;
                if (refsPending > 0) {
                    // Verdict waits for the references still being resolved.
                    pendingNothingToFlag = {dois, flagged};
                    reportWorkStage("report", "Resolving references without a DOI…");
                } else {
                    reportNothingToFlag(dois, flagged);
                }
            }
        } catch (err) {
            // Rendering failed after a successful lookup: log it for a bug
            // report rather than blaming the service the reader can't fix.
            reportCodeError("Rendering replication results failed", err);
        }
    } finally {
        endWorkIndicator();
    }
}

/**
 * Second half of a scan pass, off the pass's own timeline: once the DOI-less
 * references are resolved, check them for retractions, pill them, refresh the
 * badges, and settle the "nothing to flag" verdict the pass left open. Keeps
 * the work toast up while it runs. Never rejects — a failure releases the
 * reference entries so a later pass can retry them.
 */
function finishReferences(refsPromise: Promise<ResolvedReference[]>): Promise<ResolvedReference[]> {
    const passUrl = lastUrl;
    refsPending++;
    beginWorkIndicator();
    return refsPromise
        .then(async (resolvedRefs) => {
            if (floraHidden || isWorkCancelled()) {
                // Paused, hidden or cancelled while these were resolving — leave the page alone.
                releaseReferenceEntries(resolvedRefs);
                return [];
            }
            if (location.href !== passUrl) {
                // Navigated away while resolving — these entries belong to the old page.
                releaseReferenceEntries(resolvedRefs);
                return [];
            }
            lastResolvedReferences = resolvedRefs;
            let notices: RetractionResponse[] = [];
            if (resolvedRefs.length > 0) {
                try {
                    reportWorkStage("notices", `Checking ${count(resolvedRefs.length, "reference")} for retractions…`);
                    notices = await checkPageRetractions([...new Set(resolvedRefs.map((r) => r.doi))]);
                    for (const n of notices) refNotices.set(n.originDoi, n);
                    refreshRedacts();
                    reportWorkStage("notices", `Marking up ${count(resolvedRefs.length, "reference")}…`);
                    renderResolvedReferences(resolvedRefs, new Map(redacts.map((r) => [r.originDoi, r] as const)), pageState);
                    if (!isSheets) updateIndicatorPillBadges(document, pageState, redacts);
                } catch (err) {
                    releaseReferenceEntries(resolvedRefs);
                    reportCodeError(`References: marking up ${resolvedRefs.length} resolved reference(s) failed`, err);
                    return [];
                }
            }
            if (pendingNothingToFlag && refsPending === 1) {
                const {dois, flagged} = pendingNothingToFlag;
                pendingNothingToFlag = null;
                reportNothingToFlag([...dois, ...resolvedRefs.map(ref => ref.doi)], flagged || notices.length > 0);
            }
            return resolvedRefs;
        })
        .catch((err) => {
            debugError("References: resolution failed —", err);
            return [];
        })
        .finally(() => {
            refsPending--;
            endWorkIndicator();
        });
}

/**
 * Give the article's own retraction or expression of concern its labelled
 * pill, beside the title pill. Separate from placeTitleIndicatorPill because
 * the title pill is often placed before the retraction check has answered.
 * Idempotent: injectRetractionInfo shows one pill per DOI per page.
 */
function placeTitleNoticePill(): void {
    const titlePill = document.querySelector<HTMLElement>(
        `.${INDICATOR_PILL_CLASS}[data-flora-title-pill]`
    );
    const doi = titlePill?.getAttribute("data-flora-doi");
    if (!titlePill || !doi) return;
    const notice = redacts.find((r) => r.originDoi === doi);
    if (notice) injectRetractionInfo(titlePill, notice, {afterend: true});
}

/**
 * Place the merged FLoRA indicator pill (DOI + Open Access + PubPeer +
 * retraction/replication badge) beside the article title, keyed off the
 * primary DOI rather than the on-page occurrence scan so it still surfaces
 * when the primary DOI is only found via URL/meta tags. Idempotent — checks
 * the live DOM rather than a separate processed flag, so it self-heals if a
 * hydrating SPA wipes the title's children.
 */
function placeTitleIndicatorPill(): void {
    const titleEl = document.querySelector<HTMLHeadingElement>("h1");
    if (!titleEl || document.querySelector(`.${INDICATOR_PILL_CLASS}[data-flora-title-pill]`)) return;
    const primaryDoi = extractPrimaryDOI(document);
    if (!primaryDoi) return;

    const retraction = redacts.find((r) => r.originDoi === primaryDoi) ?? null;
    const state = pageState.get(primaryDoi);
    const stats = state?.status === "matched" ? state.result.record.stats : null;

    const pill = createIndicatorPill({
        doi: primaryDoi,
        oaStatus: fetchOpenAccess(primaryDoi),
        retraction,
        replicationsCount: stats?.n_replications_total ?? null,
        reproductionsCount: stats?.n_reproductions_total ?? null,
    });
    // Marks the title pill so the check above finds it wherever an adapter put it.
    pill.setAttribute("data-flora-title-pill", "");

    const adapter = currentSiteAdapter();
    applyPillStyle(pill, adapter, "title");
    if (!applyPlacement(adapter?.titlePill, document.documentElement, pill, "title pill")) {
        titleEl.appendChild(pill);
    }
}

// Gate augmentFromTitle to real article pages — avoids polluting the cache.
function isScholarlyArticlePage(): boolean {
    return document.querySelector(
        'meta[name="citation_title"],'
        + 'meta[name="citation_doi"],'
        + 'meta[name="citation_author"],'
        + 'meta[name="citation_journal_title"],'
        + 'meta[name="citation_publisher"],'
        + 'meta[name="prism.doi"],'
        + 'meta[name="prism.publicationName"],'
        + 'meta[name="dc.identifier" i],'
        + 'meta[name="dc.title" i],'
        + 'meta[name="DC.Identifier" i]'
    ) !== null;
}

/**
 * Silently try to resolve a DOI from the page title via Crossref/OpenAlex.
 * Runs in the background with no UI.
 */
async function augmentFromTitle(): Promise<void> {
    if (augmentAttempted) return;
    augmentAttempted = true;

    if (!isScholarlyArticlePage()) {
        debugLog("Title augmentation: skipped — page is not a scholarly article");
        return;
    }

    const titleEl = document.querySelector<HTMLHeadingElement>("h1");
    const pageTitle = titleEl?.textContent?.trim() || document.title?.trim();

    if (!pageTitle) return;

    try {
        const augmented = await augmentDOIsViaWorker([{
            title: pageTitle,
            sourceUrl: location.href,
            ...extractPageAugmentationMetadata(document),
        }]);
        const resolvedDoi = augmented.get(pageTitle);
        debugLog("Title augmentation:", resolvedDoi ? `resolved to ${resolvedDoi}` : "no match", `(title: "${pageTitle}")`);
        if (resolvedDoi) {
            processedDois.add(resolvedDoi);
            const request: LookupRequest = {
                type: "FLORA_LOOKUP",
                dois: [resolvedDoi]
            };
            await safeSendMessage(request);

            // Augmented DOI isn't in `dois` — extractPrimaryDOI won't find it either
            // (it was never on the page), so placeTitleIndicatorPill() never fires
            // for this path. Pill it beside the title here instead.
            if (titleEl && !document.querySelector(`.${INDICATOR_PILL_CLASS}[data-flora-title-pill]`)) {
                try {
                    const notices = await checkPageRetractions([resolvedDoi]);
                    // Same marker as placeTitleIndicatorPill so neither path double-pills.
                    const pill = createIndicatorPill({
                        doi: resolvedDoi,
                        oaStatus: fetchOpenAccess(resolvedDoi),
                        retraction: notices[0] ?? null,
                    });
                    pill.setAttribute("data-flora-title-pill", "");
                    const adapter = currentSiteAdapter();
                    applyPillStyle(pill, adapter, "title");
                    if (!applyPlacement(adapter?.titlePill, document.documentElement, pill, "title pill")) {
                        titleEl.appendChild(pill);
                    }
                } catch (err) {
                    debugWarn(`Title pill for augmented ${resolvedDoi} failed —`, err);
                }
            }
        }
    } catch (err) {
        debugWarn(`Title augmentation failed for "${pageTitle}" —`, err);
    }
}

function metaContent(doc: Document, selectors: string[]): string | null {
    for (const selector of selectors) {
        const value = doc.querySelector<HTMLMetaElement>(selector)?.content?.trim();
        if (value) return value;
    }
    return null;
}

function parseYear(value: string | null): number | null {
    const match = value?.match(/\b((?:19|20)\d{2})\b/);
    return match ? Number(match[1]) : null;
}

function readJsonLdObjects(doc: Document): unknown[] {
    const values: unknown[] = [];
    for (const script of doc.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')) {
        try {
            const parsed = JSON.parse(script.textContent ?? "");
            if (Array.isArray(parsed)) values.push(...parsed);
            else values.push(parsed);
        } catch {
            // Invalid publisher JSON-LD should not block title augmentation.
        }
    }
    return values;
}

function firstJsonLdAuthorName(value: unknown): string | null {
    if (!value || typeof value !== "object") return null;
    const author = (value as {author?: unknown}).author;
    const firstAuthor = Array.isArray(author) ? author[0] : author;
    if (typeof firstAuthor === "string") return firstAuthor;
    if (firstAuthor && typeof firstAuthor === "object") {
        const {familyName, name} = firstAuthor as {familyName?: unknown; name?: unknown};
        if (typeof familyName === "string") return familyName;
        if (typeof name === "string") return name;
    }
    return null;
}

function jsonLdDate(value: unknown): string | null {
    if (!value || typeof value !== "object") return null;
    const item = value as {datePublished?: unknown; dateCreated?: unknown; dateModified?: unknown};
    for (const date of [item.datePublished, item.dateCreated, item.dateModified]) {
        if (typeof date === "string") return date;
    }
    return null;
}

/**
 * Pull the article's first author and publication year from page metadata
 * (citation_/dc. meta tags, then JSON-LD) so augmentDOIs can disambiguate
 * between similarly-titled works.
 */
function extractPageAugmentationMetadata(doc: Document): Omit<DoiAugmentRequest, "title"> {
    const firstAuthor =
        metaContent(doc, [
            'meta[name="citation_author"]',
            'meta[name="dc.creator"]',
            'meta[name="DC.creator"]',
            'meta[name="author"]',
        ]) ??
        readJsonLdObjects(doc).map(firstJsonLdAuthorName).find((author): author is string => !!author) ??
        null;

    const date =
        metaContent(doc, [
            'meta[name="citation_publication_date"]',
            'meta[name="citation_online_date"]',
            'meta[name="dc.date"]',
            'meta[name="DC.date"]',
            'meta[property="article:published_time"]',
        ]) ??
        readJsonLdObjects(doc).map(jsonLdDate).find((value): value is string => !!value) ??
        null;

    return {
        firstAuthor,
        year: parseYear(date),
    };
}

async function checkPubPeer(refsPromise: Promise<ResolvedReference[]> | null): Promise<void> {
    const signal = activeWorkSignal() ?? null;
    if (isSheets || floraHidden || isWorkCancelled()) return;
    const passUrl = location.href;
    let indicatorStarted = false;
    const primaryDoi = extractPrimaryDOI(document);
    if (!primaryDoi) return;
    try {
        const resolvedRefs = refsPromise ? await refsPromise : [];
        if (signal?.aborted) return;

        // Union resolved refs with on-page reference DOIs for full PubPeer coverage.
        const seen = new Set<DoiString>();
        const referenceDois: DoiString[] = [];
        for (const r of resolvedRefs) {
            if (seen.has(r.doi)) continue;
            seen.add(r.doi);
            referenceDois.push(r.doi);
        }
        for (const [doi, ctx] of doiContext) {
            if (ctx !== "reference") continue;
            if (seen.has(doi)) continue;
            seen.add(doi);
            referenceDois.push(doi);
        }

        // Skip re-run when article is fetched, ref DOI set is unchanged, and no new FORRT data.
        const refKey = [...referenceDois].sort().join("|");
        if (articleFeedbacksFetched && refKey === lastReferenceDoiKey && lastRenderedPageStateVersion === pageStateVersion) return;

        if (floraHidden || isWorkCancelled() || location.href !== passUrl) return;
        // Keep detached article-provider work in this pass's cancellation/progress lifetime.
        beginWorkIndicator();
        indicatorStarted = true;
        // Article: URL lookup once/page. References: one batched, cached lookup.
        const articlePromise = articleFeedbacksFetched
            ? Promise.resolve({feedbacks: lastArticleFeedbacks, unavailable: articlePubPeerUnavailable})
            : lookupPubPeer([primaryDoi], [passUrl], signal).then(
                feedbacks => ({feedbacks, unavailable: false}),
                err => {
                    if (!signal?.aborted) debugWarn("Article PubPeer data unavailable —", err);
                    return {feedbacks: [] as PubPeerFeedback[], unavailable: true};
                },
            );
        const [article, refFeedbackByDoi, articleTitle] = await Promise.all([
            articlePromise,
            lookupPubPeerForDois(referenceDois, undefined, signal),
            fetchTitleByDoi(primaryDoi, signal),
        ]);
        if (signal?.aborted || floraHidden || isWorkCancelled() || location.href !== passUrl) return;
        articleFeedbacksFetched = true;
        articlePubPeerUnavailable = article.unavailable;
        lastArticleFeedbacks = article.feedbacks;
        lastReferenceDoiKey = refKey;

        // Panel lists only refs with PubPeer comments, a notice, or FORRT data.
        const noticeDois = new Set(redacts.map((r) => r.originDoi));
        const hasReplication = (doi: DoiString): boolean => {
            const s = pageState.get(doi);
            if (s?.status !== "matched") return false;
            const {n_replications_total, n_reproductions_total, n_originals_total} =
                s.result.record.stats;
            return n_replications_total > 0 || n_reproductions_total > 0 || n_originals_total > 0;
        };
        const flagged = referenceDois.filter((doi) => {
            const fb = refFeedbackByDoi.get(doi);
            return (fb !== undefined && fb.total_comments > 0)
                || noticeDois.has(doi)
                || hasReplication(doi);
        });
        const panelRefs = await Promise.all(flagged.map(async (doi) => {
            const title = refFeedbackByDoi.get(doi)?.title
                ?? (await fetchTitleByDoi(doi, signal))
                ?? doi;
            return {doi, title};
        }));

        if (signal?.aborted || floraHidden || isWorkCancelled() || location.href !== passUrl) return;
        lastRenderedPageStateVersion = pageStateVersion;
        renderSidePanel(article.feedbacks, panelRefs, pageState, doiContext, refFeedbackByDoi, redacts, articleTitle,
            article.unavailable ? async () => {
                if (floraHidden || location.href !== passUrl) return;
                resumeAutomaticWork();
                articleFeedbacksFetched = false;
                beginWorkIndicator({stages: ["scan"]});
                try { await checkPubPeer(Promise.resolve(resolvedRefs)); }
                finally { endWorkIndicator(); }
            } : undefined);

    } catch (err) {
        if (!signal?.aborted) debugWarn("PubPeer panel: lookup or render failed —", err);
    } finally {
        if (indicatorStarted) endWorkIndicator();
    }
}

function currentSheetKey(): string {
    return sheetTabKey(parseSheetsUrl(location.href));
}

function isSheetsModalSuppressed(): boolean {
    if (Date.now() < snoozeUntil) return true;
    if (dismissedSheets.has(currentSheetKey())) return true;
    return false;
}

const sheetsModalCallbacks: SheetsModalCallbacks = {
    onDismiss() {
        dismissedSheets.add(currentSheetKey());
        debugLog("Sheets modal dismissed for tab:", currentSheetKey());
    },
    onSnooze() {
        snoozeUntil = Date.now() + 10 * 60 * 1000; // 10 minutes
        debugLog("Sheets modal snoozed until", new Date(snoozeUntil).toLocaleTimeString());
    },
};

const SHEET_UNAVAILABLE = "Full sheet unavailable — only visible cells could be checked.";

/** Fetch the active tab in full, falling back to visible cells if export fails. */
async function fetchSheetDois(): Promise<void> {
    const parsed = parseSheetsUrl(location.href);
    if (!parsed) return;
    if (!canStartAutomaticWork() || !await waitUntilVisible(activeWorkSignal())) return;
    const current = parseSheetsUrl(location.href);
    if (floraHidden || !canStartAutomaticWork() || !current ||
        current.spreadsheetId !== parsed.spreadsheetId || current.gid !== parsed.gid) return;

    const alert = document.getElementById("flora-alert-toast");
    if (alert?.textContent?.includes(SHEET_UNAVAILABLE)) alert.remove();
    const myGen = sheetFetchGen;
    const isCurrent = () => myGen === sheetFetchGen &&
        sheetTabKey(parsed) === sheetTabKey(parseSheetsUrl(location.href));
    let unavailable = false;
    try {
        const csv = await fetchSheetCsv(parsed);
        if (!isCurrent()) return;
        sheetCsvDois = extractDOIsFromText(csv);
        debugLog(`Sheets: CSV export found ${sheetCsvDois.length} DOIs`);
    } catch (err) {
        if (!isCurrent()) return;
        sheetCsvDois = [];
        unavailable = true;
        debugWarn("Sheets: full-tab export unavailable — checking visible cells only", err);
    }
    if (isWorkCancelled()) return;
    await scanWholePage().catch((err) => debugError("Sheets: scan pass failed —", err));
    if (!isCurrent() || isWorkCancelled()) return;
    if (unavailable) {
        showToast(SHEET_UNAVAILABLE, {
            tone: "error",
            action: {label: "Retry", onClick: () => { resumeAutomaticWork(); return fetchSheetDois(); }},
        });
    } else if (sheetCsvDois.length === 0 && extractDOIs(document).length === 0) {
        showToast("No DOIs found in this sheet tab.");
    }
}


(async () => {
  try {
    if (window !== window.top) return;
    installErrorReporting();

    // A Cloudflare challenge is served at the article's own URL, so the DOI in
    // that URL resolves and FLoRA would pill an interstitial. Render nothing
    // and stop — clearing the challenge loads the real document, and the
    // content script starts over there.
    if (isOwnRepoUrl(location.href)) {
        reportActiveState(false);
        return;
    }

    if (isBotCheckPage()) {
        debugLog("Bot-check interstitial — FLoRA renders nothing on this page");
        reportActiveState(false);
        return;
    }

    if (isAuthGatewayPage()) {
        debugLog("Sign-in step — FLoRA renders nothing on this page");
        reportActiveState(false);
        return;
    }

    if (await isDomainBlocked(location.hostname)) {
        debugLog("Domain is blocked:", location.hostname);
        reportActiveState(false); // gray toolbar icon — disabled on this domain
        return;
    }

    if (await isDomainSnoozed(location.hostname)) {
        debugLog("Domain is snoozed:", location.hostname);
        reportActiveState(false); // gray toolbar icon — paused on this domain
        return;
    }
    // Applicable page — mark the toolbar icon active for this tab.
    reportActiveState(true);
    // Show setup prompt if email not configured (non-blocking — extension still runs)
    if (!(await isSetupComplete())) {
        renderSetupPrompt().catch((err) => debugError("Setup prompt failed to render —", err));
    }
    const startFlora = (): void => {
        if (isSheets) {
            // Fetch full sheet data via CSV export to get all DOIs regardless of scroll
            fetchSheetDois();
            // Poll for sheet tab switches — Sheets uses replaceState (no popstate).
            let lastSheet = sheetTabKey(parseSheetsUrl(location.href));
            setInterval(() => {
                const nowSheet = sheetTabKey(parseSheetsUrl(location.href));
                if (nowSheet !== lastSheet) {
                    lastSheet = nowSheet;
                    debugLog("Sheets: tab change detected:", nowSheet, "— re-fetching…");
                    sheetFetchGen++;
                    sheetCsvDois = [];
                    processedDois.clear();
                    seenDois.clear();
                    pageState.clear();
                    removeSheetsModal();
                    dismissToast();
                    fetchSheetDois();
                }
            }, 1500);
        } else {
            // Start the article's own lookup off URL/meta/JSON-LD, then let the
            // full scan wait for idle rather than competing with page render.
            void primaryDoiFastPath();
            whenIdle(() => void scanWholePage());
            // Defer the observer until full load so load-time mutations don't spam it.
            if (document.readyState === "complete") {
                startDomListener({scanWholePage, getLastUrl: () => lastUrl});
            } else {
                window.addEventListener("load", () => startDomListener({scanWholePage, getLastUrl: () => lastUrl}), { once: true });
            }
        }
    };

    // Only run on the active/visible tab. Content scripts auto-inject into every
    // matching tab (including background ones); defer all work until this tab is
    // shown so background tabs don't scan, look up, or render.
    if (document.visibilityState === "visible") {
        startFlora();
    } else {
        document.addEventListener("visibilitychange", function onVisible() {
            if (document.visibilityState === "visible") {
                document.removeEventListener("visibilitychange", onVisible);
                startFlora();
            }
        });
    }
  } catch (err) {
    reportCodeError(`ORE failed to start on ${location.hostname}`, err);
    reportActiveState(false);
  }
})();
