import {activeWorkSignal, abortableDelay} from "./work-cancellation";
import type {DoiString, DoiAugmentRequest, ReplicationResult, RetractionResponse} from "./types";
import type {AugmentSource} from "./doi-augment";
import type {NcbiIdType} from "./pmc-resolve";
import {debugLog} from "./debug";
import type {DebugLogEntry} from "./debug";

/** Any context → service worker: captured debug entries to persist. */
export interface DebugEntriesRequest {
    type: "FLORA_DEBUG_ENTRIES";
    entries: DebugLogEntry[];
}

export function isDebugEntriesRequest(msg: unknown): msg is DebugEntriesRequest {
    return (
        typeof msg === "object" &&
        msg !== null &&
        (msg as Record<string, unknown>).type === "FLORA_DEBUG_ENTRIES" &&
        Array.isArray((msg as Record<string, unknown>).entries)
    );
}

/**
 * Popup/options → service worker: hold this report until the GitHub issue form
 * asks for it. It's parked in the worker rather than passed through the tab URL
 * because GitHub rejects issue links long enough to carry a log.
 */
export interface StashReportRequest {
    type: "FLORA_STASH_REPORT";
    report: string;
}

/**
 * Issue-form content script → service worker: hand over the parked report
 * ("take", which consumes it) or just ask whether one is waiting ("peek",
 * which leaves it for a later attempt).
 */
export interface TakeReportRequest {
    type: "FLORA_TAKE_REPORT" | "FLORA_PEEK_REPORT";
}

/** Service worker → issue-form content script: the report, or null if none. */
export interface TakeReportResponse {
    type: "FLORA_TAKE_REPORT_RESULT";
    report: string | null;
}

export function isStashReportRequest(msg: unknown): msg is StashReportRequest {
    return (
        typeof msg === "object" &&
        msg !== null &&
        (msg as Record<string, unknown>).type === "FLORA_STASH_REPORT" &&
        typeof (msg as Record<string, unknown>).report === "string"
    );
}

export function isTakeReportRequest(msg: unknown): msg is TakeReportRequest {
    if (typeof msg !== "object" || msg === null) return false;
    const type = (msg as Record<string, unknown>).type;
    return type === "FLORA_TAKE_REPORT" || type === "FLORA_PEEK_REPORT";
}

/** Content script → service worker: request DOI lookups */
export interface LookupRequest {
    type: "FLORA_LOOKUP";
    dois: DoiString[];
}

/** Service worker → content script: lookup results */
export interface LookupResponse {
    type: "FLORA_LOOKUP_RESULT";
    results: Record<string, ReplicationResult>;
    errors: Record<string, string>;
}

export interface CreateSetRequest {
    type: "FLORA_CREATE_SET";
    dois: DoiString[];
}

export interface CreateSetResponse {
    type: "FLORA_CREATE_SET_RESULT";
    setId: string | null;
}

export function isCreateSetRequest(msg: unknown): msg is CreateSetRequest {
    return (
        typeof msg === "object" &&
        msg !== null &&
        (msg as Record<string, unknown>).type === "FLORA_CREATE_SET" &&
        Array.isArray((msg as Record<string, unknown>).dois)
    );
}

export async function createDoiSetViaWorker(dois: DoiString[]): Promise<string | null> {
    try {
        const response = await safeSendMessage<CreateSetResponse>({
            type: "FLORA_CREATE_SET",
            dois,
        });
        return response?.setId ?? null;
    } catch (err) {
        debugLog("Atlas set request failed:", err);
        return null;
    }
}

/** Content script → service worker: request retraction status for DOI(s) */
export interface RetractionCheckRequest {
    type: "FLORA_RET_CHECK";
    dois: DoiString[];
}

/** Service worker → content script: retraction lookup results */
export interface RetractionCheckResponse {
    type: "FLORA_RET_CHECK_RESULT";
    results: RetractionResponse[];
    error?: string;
}

/** Content script → service worker: fetch Google Sheet CSV for DOI extraction */
export interface SheetFetchRequest {
    type: "FLORA_SHEET_FETCH";
    spreadsheetId: string;
    gid: string;
}

/** Service worker → content script: raw CSV text */
export interface SheetFetchResponse {
    type: "FLORA_SHEET_FETCH_RESULT";
    csv: string | null;
    error: string | null;
}

/** Content script → service worker: resolve DOIs from article titles */
export interface AugmentRequest {
    type: "FLORA_AUGMENT";
    requests: DoiAugmentRequest[];
}

/** Service worker → content script: title → resolved DOI (or null) */
export interface AugmentResponse {
    type: "FLORA_AUGMENT_RESULT";
    results: Record<string, string | null>;
    /** title → which platform resolved it, so the page log can name it. */
    sources?: Record<string, AugmentSource | null>;
    unanswered?: string[];
}

export function isAugmentRequest(msg: unknown): msg is AugmentRequest {
    return (
        typeof msg === "object" &&
        msg !== null &&
        (msg as Record<string, unknown>).type === "FLORA_AUGMENT" &&
        Array.isArray((msg as Record<string, unknown>).requests)
    );
}

/** Content script → service worker: resolve PMC ids (or PMIDs) to DOIs */
export interface PmcResolveRequest {
    type: "FLORA_PMC_RESOLVE";
    pmcids: string[];
    /** Which id type `pmcids` holds; defaults to "pmcid". */
    idtype?: NcbiIdType;
}

/** Service worker → content script: id → DOI (or null when NCBI has none) */
export interface PmcResolveResponse {
    type: "FLORA_PMC_RESOLVE_RESULT";
    results: Record<string, string | null>;
}

export function isPmcResolveRequest(msg: unknown): msg is PmcResolveRequest {
    if (typeof msg !== "object" || msg === null) return false;
    const record = msg as Record<string, unknown>;
    return (
        record.type === "FLORA_PMC_RESOLVE" &&
        Array.isArray(record.pmcids) &&
        // resolvePmcIds looks the id type up in a fixed table, so anything else
        // would leave it without a normaliser.
        (record.idtype === undefined || record.idtype === "pmcid" || record.idtype === "pmid")
    );
}

/** Content script → service worker: resolve OpenAlex work ids to DOIs */
export interface OpenAlexResolveRequest {
    type: "FLORA_OPENALEX_RESOLVE";
    ids: string[];
}

/** Service worker → content script: OpenAlex id → DOI (or null when the work has none) */
export interface OpenAlexResolveResponse {
    type: "FLORA_OPENALEX_RESOLVE_RESULT";
    results: Record<string, string | null>;
}

export function isOpenAlexResolveRequest(msg: unknown): msg is OpenAlexResolveRequest {
    return (
        typeof msg === "object" &&
        msg !== null &&
        (msg as Record<string, unknown>).type === "FLORA_OPENALEX_RESOLVE" &&
        Array.isArray((msg as Record<string, unknown>).ids)
    );
}

/** Ask the service worker to run resolveOpenAlexIds. */
export async function resolveOpenAlexIdsViaWorker(
    ids: string[]
): Promise<Map<string, DoiString | null>> {
    const response = await safeSendMessage<OpenAlexResolveResponse>({
        type: "FLORA_OPENALEX_RESOLVE",
        ids,
    });
    const result = new Map<string, DoiString | null>();
    for (const [id, doi] of Object.entries(response?.results ?? {})) {
        result.set(id, doi as DoiString | null);
    }
    return result;
}

/** Content script → service worker: resolve Semantic Scholar paper ids to DOIs */
export interface SemanticScholarResolveRequest {
    type: "FLORA_S2_RESOLVE";
    ids: string[];
}

/** Service worker → content script: paper id → DOI (or null when the paper has none) */
export interface SemanticScholarResolveResponse {
    type: "FLORA_S2_RESOLVE_RESULT";
    results: Record<string, string | null>;
}

export function isSemanticScholarResolveRequest(msg: unknown): msg is SemanticScholarResolveRequest {
    return (
        typeof msg === "object" &&
        msg !== null &&
        (msg as Record<string, unknown>).type === "FLORA_S2_RESOLVE" &&
        Array.isArray((msg as Record<string, unknown>).ids)
    );
}

/** Ask the service worker to run resolveSemanticScholarIds. */
export async function resolveSemanticScholarIdsViaWorker(
    ids: string[]
): Promise<Map<string, DoiString | null>> {
    const response = await safeSendMessage<SemanticScholarResolveResponse>({
        type: "FLORA_S2_RESOLVE",
        ids,
    });
    const result = new Map<string, DoiString | null>();
    for (const [id, doi] of Object.entries(response?.results ?? {})) {
        result.set(id, doi as DoiString | null);
    }
    return result;
}

/**
 * Ask the service worker to run resolvePmcIds — NCBI's converter sends no CORS
 * headers, so the fetch has to happen in the background context.
 */
export async function resolvePmcIdsViaWorker(
    pmcids: string[],
    idtype: NcbiIdType = "pmcid"
): Promise<Map<string, DoiString | null>> {
    const response = await safeSendMessage<PmcResolveResponse>({
        type: "FLORA_PMC_RESOLVE",
        pmcids,
        idtype,
    });
    const result = new Map<string, DoiString | null>();
    for (const [pmcid, doi] of Object.entries(response?.results ?? {})) {
        result.set(pmcid, doi as DoiString | null);
    }
    return result;
}

/**
 * Ask the service worker to run augmentDOIs, routing all Crossref/OpenAlex
 * fetches through the extension background context (no CORS restrictions).
 * Unanswered titles are omitted; an invalidated extension context throws so callers can offer reload.
 */
export async function augmentDOIsViaWorker(
    inputs: Array<string | DoiAugmentRequest>
): Promise<Map<string, DoiString | null>> {
    const requests: DoiAugmentRequest[] = inputs.map((input) =>
        typeof input === "string" ? { title: input } : input
    );
    const response = await safeSendMessage<AugmentResponse>({
        type: "FLORA_AUGMENT",
        requests,
    });
    if (!response) throw new Error("Extension context invalidated");
    const unanswered = new Set(response.unanswered ?? []);
    const result = new Map<string, DoiString | null>();
    for (const [title, doi] of Object.entries(response?.results ?? {})) {
        if (unanswered.has(title)) {
            debugLog(`Augment: "${title.slice(0, 80)}" — no platform answered, leaving it unresolved`);
            continue;
        }
        result.set(title, doi as DoiString | null);
        // Resolution happens in the service worker, so without this the page
        // console never says which platform answered.
        const source = response?.sources?.[title];
        debugLog(
            `Augment: "${title.slice(0, 80)}" → ${doi ?? "no match"}`
            + (source ? ` via ${source.toUpperCase()}` : "")
        );
    }
    return result;
}

/**
 * True when an error is Chrome's "Extension context invalidated" — raised when
 * a page still holds a content script from a previous extension instance after
 * the extension was reloaded, updated, or disabled. Such errors are benign: the
 * old script can no longer reach the service worker and should quietly stop.
 */
export function isContextInvalidated(err: unknown): boolean {
    return err instanceof Error && /Extension context invalidated/i.test(err.message);
}

/**
 * Chrome rejects a message with this when no listener received it — typically
 * while an idle worker is being torn down, or right after an extension update.
 * The worker comes up for the next message, so the call is worth repeating.
 *
 * Do not include "message port/channel closed" here: those errors can occur
 * after a listener has started handling the request, so replaying them could
 * duplicate network calls or non-idempotent work.
 */
export function isWorkerUnreachable(err: unknown): boolean {
    return err instanceof Error &&
        /Receiving end does not exist/i.test(err.message);
}

/** Back-off between attempts; the total wait stays under 5 s. */
export const SEND_RETRY_DELAYS_MS = [300, 1000, 3000];


/**
 * `chrome.runtime.sendMessage` wrapper that (1) retries when the worker was
 * unreachable, and (2) swallows "Extension context invalidated" rejections
 * (resolving to `undefined`) so stale content scripts don't surface uncaught
 * promise errors after an extension reload. All other errors still reject so
 * genuine failures stay visible.
 */
const CANCELLABLE_TYPES = new Set([
    "FLORA_LOOKUP", "FLORA_CREATE_SET", "FLORA_RET_CHECK", "FLORA_SHEET_FETCH",
    "FLORA_AUGMENT", "FLORA_PMC_RESOLVE", "FLORA_OPENALEX_RESOLVE", "FLORA_S2_RESOLVE",
]);

export async function safeSendMessage<T = unknown>(message: unknown): Promise<T | undefined> {
    const record = message as {type?: string};
    const signal = CANCELLABLE_TYPES.has(record?.type ?? "") ? activeWorkSignal() : undefined;
    const requestId = signal ? Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-") : undefined;
    const payload = requestId ? {...record, requestId} : message;
    let rejectAbort: ((reason: unknown) => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const cancel = () => {
        try { void chrome.runtime.sendMessage({type: "FLORA_CANCEL_REQUEST", requestId}).catch(() => {}); } catch {}
        rejectAbort?.(signal?.reason);
    };
    signal?.throwIfAborted();
    signal?.addEventListener("abort", cancel, {once: true});
    try {
        for (let attempt = 0; ; attempt++) {
            signal?.throwIfAborted();
            try {
                return await Promise.race([chrome.runtime.sendMessage(payload) as Promise<T>, aborted]);
            } catch (err) {
                signal?.throwIfAborted();
                if (isContextInvalidated(err)) return undefined;
                const delay = SEND_RETRY_DELAYS_MS[attempt];
                if (delay === undefined || !isWorkerUnreachable(err)) throw err;
                await abortableDelay(delay, signal);
            }
        }
    } finally {
        signal?.removeEventListener("abort", cancel);
    }
}

export function isLookupRequest(msg: unknown): msg is LookupRequest {
    return (
        typeof msg === "object" &&
        msg !== null &&
        (msg as Record<string, unknown>).type === "FLORA_LOOKUP" &&
        Array.isArray((msg as Record<string, unknown>).dois)
    );
}

export function isRetractionCheckRequest(msg: unknown): msg is RetractionCheckRequest {
    return (
        typeof msg === "object" &&
        msg !== null &&
        (msg as Record<string, unknown>).type === "FLORA_RET_CHECK" &&
        Array.isArray((msg as Record<string, unknown>).dois)
    );
}

export function isSheetFetchRequest(msg: unknown): msg is SheetFetchRequest {
    return (
        typeof msg === "object" &&
        msg !== null &&
        (msg as Record<string, unknown>).type === "FLORA_SHEET_FETCH" &&
        typeof (msg as Record<string, unknown>).spreadsheetId === "string" &&
        typeof (msg as Record<string, unknown>).gid === "string"
    );
}
