import {mockResult} from "../helpers";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import type {SearchSiteAdapter} from "../../src/content-search/sites/types";
import type {DoiString} from "../../src/shared/types";

const DOI = "10.1234/paper" as DoiString;
const send = vi.fn();
const badges = vi.fn();
const retraction = vi.fn();
let navigationEvents: EventTarget;
const adapter: SearchSiteAdapter = {
    id: "test", label: "Test", hostnames: [], css: "", resultRow: ".result", panelPlacement: [],
    extractRow: () => ({doi: DOI, confident: true, title: "Paper", firstAuthor: null, year: null, sourceUrl: null}),
};
beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '<div class="result"></div>';
    navigationEvents = new EventTarget();
    vi.stubGlobal("navigation", navigationEvents);
    send.mockReset();
    badges.mockClear();
    (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockResolvedValue({flora_settings: {email: "reader@example.com"}});
    retraction.mockReset().mockResolvedValue([]);
    vi.doMock("../../src/shared/messages", () => ({safeSendMessage: send, augmentDOIsViaWorker: vi.fn()}));
    vi.doMock("../../src/shared/openaccess", () => ({fetchOpenAccess: vi.fn().mockResolvedValue(null)}));
    vi.doMock("../../src/shared/doi-retraction", () => ({retractionCheck: retraction}));
    vi.doMock("../../src/shared/indicator-pill", () => ({
        updateIndicatorPillBadges: badges,
        createIndicatorPanel: () => {const panel = document.createElement("div"); panel.setAttribute("data-flora-panel", ""); return panel;},
    }));
});

afterEach(() => vi.unstubAllGlobals());

it("retains a failed hidden lookup and refreshes its unavailable state when shown", async () => {
    let reject!: (reason: Error) => void;
    send.mockImplementationOnce(() => new Promise((_resolve, fail) => {reject = fail;}));
    const {processSearchResults, setSearchHidden} = await import("../../src/content-search/pipeline");
    const pending = processSearchResults(adapter, document);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    setSearchHidden(true);
    badges.mockClear();
    reject(new Error("offline"));
    await pending;
    expect(badges).not.toHaveBeenCalled();
    setSearchHidden(false);
    expect(badges.mock.lastCall![1].get(DOI)).toEqual({status: "error", message: "FORRT unavailable"});
});

it("removes orphaned panels and requests page reload when the extension context disappears", async () => {
    send.mockResolvedValue(undefined);
    const {processSearchResults} = await import("../../src/content-search/pipeline");
    await processSearchResults(adapter, document);
    expect(badges.mock.lastCall![1].has(DOI)).toBe(false);
    expect(document.querySelector("[data-flora-panel]")).toBeNull();
    expect(document.getElementById("flora-alert-toast")?.textContent).toContain("ORE was updated");
    expect(document.getElementById("flora-alert-toast")?.textContent).toContain("Reload");
});

it("retries unanswered title-only rows explicitly without repeating confirmed misses on new-result passes", async () => {
    document.body.innerHTML = '<div class="result">Unanswered paper</div><div class="result">Confirmed missing paper</div>';
    const augment = vi.fn().mockResolvedValueOnce(new Map([["Confirmed missing paper", null]]))
        .mockResolvedValueOnce(new Map([["Unanswered paper", DOI]]));
    vi.doMock("../../src/shared/messages", () => ({safeSendMessage: send, augmentDOIsViaWorker: augment}));
    send.mockResolvedValue({results: {}, errors: {}});
    const titleAdapter = {...adapter, extractRow: (row: HTMLElement) => ({
        doi: null, confident: false, title: row.textContent!, firstAuthor: null, year: null, sourceUrl: null,
    })};
    const {processSearchResults, retryUnansweredSearchResults} = await import("../../src/content-search/pipeline");
    await processSearchResults(titleAdapter, document);
    expect(document.getElementById("flora-alert-toast")?.textContent).toContain("DOI matching unavailable for some results");
    expect(document.getElementById("flora-alert-toast")?.textContent).toContain("Retry");
    await processSearchResults(titleAdapter, document);
    expect(augment).toHaveBeenCalledTimes(1);
    await retryUnansweredSearchResults(titleAdapter, document);
    expect(augment.mock.calls[1][0]).toEqual([expect.objectContaining({title: "Unanswered paper"})]);
    expect(send).toHaveBeenCalledWith({type: "FLORA_LOOKUP", dois: [DOI]});
    expect(document.querySelectorAll("[data-flora-panel]")).toHaveLength(1);
    expect(document.getElementById("flora-alert-toast")).toBeNull();
});

it("allows settings-triggered retry to recover an initial lookup that is still finishing", async () => {
    let settle!: (result: Map<string, null>) => void;
    const augment = vi.fn().mockImplementationOnce(() => new Promise(resolve => {settle = resolve;}))
        .mockResolvedValueOnce(new Map([["Paper", DOI]]));
    vi.doMock("../../src/shared/messages", () => ({safeSendMessage: send, augmentDOIsViaWorker: augment}));
    send.mockResolvedValue({results: {}, errors: {}});
    const titleAdapter = {...adapter, extractRow: () => ({
        doi: null, confident: false, title: "Paper", firstAuthor: null, year: null, sourceUrl: null,
    })};
    const {processSearchResults, retryUnansweredSearchResults} = await import("../../src/content-search/pipeline");
    const initial = processSearchResults(titleAdapter, document);
    await vi.waitFor(() => expect(augment).toHaveBeenCalledOnce());
    const retry = retryUnansweredSearchResults(titleAdapter, document);
    settle(new Map());
    await Promise.all([initial, retry]);
    expect(augment).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll("[data-flora-panel]")).toHaveLength(1);
});


it("defers a settings retry while hidden, then processes those rows when shown", async () => {
    (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const augment = vi.fn().mockResolvedValueOnce(new Map()).mockResolvedValueOnce(new Map([["Paper", DOI]]));
    vi.doMock("../../src/shared/messages", () => ({safeSendMessage: send, augmentDOIsViaWorker: augment}));
    send.mockResolvedValue({results: {}, errors: {}});
    const titleAdapter = {...adapter, extractRow: () => ({
        doi: null, confident: false, title: "Paper", firstAuthor: null, year: null, sourceUrl: null,
    })};
    const {processSearchResults, retryUnansweredSearchResults, setSearchHidden} = await import("../../src/content-search/pipeline");
    await processSearchResults(titleAdapter, document);
    expect(document.getElementById("flora-alert-toast")).toBeNull();
    setSearchHidden(true);
    await retryUnansweredSearchResults(titleAdapter, document);
    expect(augment).toHaveBeenCalledOnce();
    setSearchHidden(false);
    await processSearchResults(titleAdapter, document);
    expect(augment).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll("[data-flora-panel]")).toHaveLength(1);
});


it("offers Reload instead of Retry when title matching belongs to a replaced extension", async () => {
    const actual = await vi.importActual<typeof import("../../src/shared/messages")>("../../src/shared/messages");
    vi.doMock("../../src/shared/messages", () => actual);
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Extension context invalidated"));
    const titleAdapter = {...adapter, extractRow: () => ({
        doi: null, confident: false, title: "Paper", firstAuthor: null, year: null, sourceUrl: null,
    })};
    const {processSearchResults} = await import("../../src/content-search/pipeline");
    await processSearchResults(titleAdapter, document);
    const alert = document.getElementById("flora-alert-toast")?.textContent;
    expect(alert).toContain("Reload");
    expect(alert).not.toContain("Retry");
    expect(document.querySelector("[data-flora-panel]")).toBeNull();
});

it("keeps rows usable when notices fail and retries the failed check without repeating FORRT", async () => {
    send.mockResolvedValue({type: "FLORA_LOOKUP_RESULT", results: {}, errors: {}});
    const notice = {originDoi: DOI, doi: "10.1234/notice", kind: "retraction"};
    retraction.mockRejectedValueOnce(new Error("Retraction data unavailable")).mockResolvedValueOnce([notice]);
    const {processSearchResults} = await import("../../src/content-search/pipeline");
    await processSearchResults(adapter, document);
    await vi.waitFor(() => expect(document.getElementById("flora-alert-toast")?.textContent).toContain("Retraction checks unavailable"));
    expect(document.querySelector("[data-flora-panel]")).not.toBeNull();
    const retry = document.querySelector<HTMLButtonElement>("#flora-alert-toast button")!;
    expect(retry.textContent).toBe("Retry");
    const {beginWorkIndicator, endWorkIndicator, isWorkCancelled} = await import("../../src/shared/progress-toast");
    beginWorkIndicator(); // An older pass has not unwound its last work item yet.
    await vi.waitFor(() => expect(document.querySelector("[data-flora-work-cancel]")).not.toBeNull());
    document.querySelector<HTMLButtonElement>("[data-flora-work-cancel]")!.click();
    retry.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(retraction).toHaveBeenCalledTimes(1);
    expect(isWorkCancelled()).toBe(true); // The older cancelled pass must not be resumed.
    endWorkIndicator();
    await vi.waitFor(() => expect(badges.mock.lastCall![2]).toEqual([notice]));
    expect(retraction).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
});

it("does not offer Retry for a cancelled notice check", async () => {
    send.mockResolvedValue({type: "FLORA_LOOKUP_RESULT", results: {}, errors: {}});
    let fail!: (reason: Error) => void;
    retraction.mockImplementationOnce(() => new Promise((_resolve, reject) => {fail = reject;}));
    const {processSearchResults} = await import("../../src/content-search/pipeline");
    await processSearchResults(adapter, document);
    const {cancelWork} = await import("../../src/shared/work-cancellation");
    cancelWork();
    fail(new DOMException("Work cancelled", "AbortError"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.getElementById("flora-alert-toast")).toBeNull();
});

it("keeps one Retry for both failed providers until each recovers", async () => {
    document.body.innerHTML = '<div class="result" data-doi="10.1234/paper">Known paper</div><div class="result">Unresolved paper</div>';
    const augment = vi.fn().mockResolvedValueOnce(new Map()).mockResolvedValueOnce(new Map())
        .mockResolvedValueOnce(new Map([["Unresolved paper", "10.1234/resolved"]]));
    vi.doMock("../../src/shared/messages", () => ({safeSendMessage: send, augmentDOIsViaWorker: augment}));
    send.mockResolvedValue({results: {}, errors: {}});
    const notice = {originDoi: DOI, doi: "10.1234/notice", kind: "retraction"};
    retraction.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([notice]);
    const mixedAdapter = {...adapter, extractRow: (row: HTMLElement) => ({
        doi: row.dataset.doi as DoiString ?? null, confident: !!row.dataset.doi,
        title: row.textContent!, firstAuthor: null, year: null, sourceUrl: null,
    })};
    const {processSearchResults} = await import("../../src/content-search/pipeline");
    await processSearchResults(mixedAdapter, document);
    await vi.waitFor(() => expect(document.getElementById("flora-alert-toast")?.textContent).toContain("DOI matching and retraction checks unavailable"));
    document.querySelector<HTMLButtonElement>("#flora-alert-toast button")!.click();
    await vi.waitFor(() => expect(badges.mock.lastCall![2]).toEqual([notice]));
    expect(augment).toHaveBeenCalledTimes(2);
    expect(retraction).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(document.getElementById("flora-alert-toast")?.textContent).toContain("DOI matching unavailable for some results");
    document.querySelector<HTMLButtonElement>("#flora-alert-toast button")!.click();
    await vi.waitFor(() => expect(document.querySelectorAll("[data-flora-panel]")).toHaveLength(2));
    await vi.waitFor(() => expect(document.getElementById("flora-alert-toast")).toBeNull());
    expect(retraction.mock.calls.map(call => call[0])).toEqual([[DOI], [DOI], ["10.1234/resolved"]]);
    expect(send).toHaveBeenCalledTimes(2);
});

it("does not resume a queued Retry after the user subsequently cancels", async () => {
    const augment = vi.fn().mockResolvedValue(new Map());
    vi.doMock("../../src/shared/messages", () => ({safeSendMessage: send, augmentDOIsViaWorker: augment}));
    send.mockResolvedValue({results: {}, errors: {}});
    const mixedAdapter = {...adapter, extractRow: (row: HTMLElement) => ({
        doi: row.dataset.doi as DoiString ?? null, confident: !!row.dataset.doi,
        title: "Unresolved paper", firstAuthor: null, year: null, sourceUrl: null,
    })};
    const {processSearchResults} = await import("../../src/content-search/pipeline");
    await processSearchResults(mixedAdapter, document);
    let settle!: (value: unknown) => void;
    send.mockImplementationOnce(() => new Promise(resolve => {settle = resolve;}));
    document.body.insertAdjacentHTML("beforeend", '<div class="result" data-doi="10.1234/next"></div>');
    const nextPass = processSearchResults(mixedAdapter, document);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    document.querySelector<HTMLButtonElement>("#flora-alert-toast button")!.click();
    const {canStartAutomaticWork} = await import("../../src/shared/work-cancellation");
    await vi.waitFor(() => expect(document.querySelector("[data-flora-work-cancel]")).not.toBeNull());
    document.querySelector<HTMLButtonElement>("[data-flora-work-cancel]")!.click();
    settle({results: {}, errors: {}});
    await nextPass;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(canStartAutomaticWork()).toBe(false);
    expect(augment).toHaveBeenCalledOnce();
});

it("clears the old warning and retries reused unresolved rows on SPA navigation", async () => {
    const augment = vi.fn().mockResolvedValueOnce(new Map()).mockResolvedValueOnce(new Map([["Paper", DOI]]));
    vi.doMock("../../src/shared/messages", () => ({safeSendMessage: send, augmentDOIsViaWorker: augment}));
    send.mockResolvedValue({results: {}, errors: {}});
    const titleAdapter = {...adapter, extractRow: () => ({
        doi: null, confident: false, title: "Paper", firstAuthor: null, year: null, sourceUrl: null,
    })};
    const {processSearchResults} = await import("../../src/content-search/pipeline");
    await processSearchResults(titleAdapter, document);
    expect(document.getElementById("flora-alert-toast")).not.toBeNull();
    const previousUrl = location.href;
    try {
        history.replaceState(null, "", "/next-page");
        await processSearchResults(titleAdapter, document);
        expect(augment).toHaveBeenCalledTimes(2);
        expect(document.getElementById("flora-alert-toast")).toBeNull();
        expect(document.querySelectorAll("[data-flora-panel]")).toHaveLength(1);
    } finally { history.replaceState(null, "", previousUrl); }
});

it("removes generated Scholar targets on title-context loss but preserves native targets", async () => {
    document.body.innerHTML = '<div class="result" data-doi="yes"></div><div class="result" data-doi="yes"><div class="gs_ggs"></div></div><div class="result">Title only</div>';
    const nativeTarget = document.querySelector('.gs_ggs')!;
    const actual = await vi.importActual<typeof import("../../src/shared/messages")>("../../src/shared/messages");
    vi.doMock("../../src/shared/messages", () => ({safeSendMessage: send,
        isContextInvalidated: actual.isContextInvalidated,
        augmentDOIsViaWorker: vi.fn().mockRejectedValue(new Error('Extension context invalidated'))}));
    const {SCHOLAR} = await import("../../src/content-search/sites/scholar");
    const scholarAdapter = {...adapter, preparePanelTarget: SCHOLAR.preparePanelTarget, panelPlacement: SCHOLAR.panelPlacement,
        extractRow: (row: HTMLElement) => ({doi: row.dataset.doi ? DOI : null, confident: !!row.dataset.doi,
            title: 'Paper', firstAuthor: null, year: null, sourceUrl: null})};
    const {processSearchResults} = await import("../../src/content-search/pipeline");
    await processSearchResults(scholarAdapter, document);
    expect(document.querySelector('[data-flora-panel-target]')).toBeNull();
    expect(nativeTarget.isConnected).toBe(true);
    expect(nativeTarget.childNodes).toHaveLength(0);
    expect(document.querySelector('[data-flora-panel]')).toBeNull();
    expect(document.getElementById('flora-alert-toast')?.textContent).toContain('Reload');
});

it("keeps Retry for remaining unanswered rows but clears it after results are replaced", async () => {
    document.body.innerHTML = '<main><div class="result">Unavailable</div></main>';
    const augment = vi.fn().mockResolvedValue(new Map());
    vi.doMock("../../src/shared/messages", () => ({safeSendMessage: send, augmentDOIsViaWorker: augment}));
    send.mockResolvedValue({results: {}, errors: {}});
    const titleAdapter = {...adapter, extractRow: (row: HTMLElement) => ({
        doi: row.dataset.doi ? DOI : null, confident: !!row.dataset.doi, title: row.textContent!,
        firstAuthor: null, year: null, sourceUrl: null,
    })};
    const {processSearchResults} = await import("../../src/content-search/pipeline");
    await processSearchResults(titleAdapter, document);
    document.querySelector('main')!.insertAdjacentHTML('beforeend', '<div class="result" data-doi="yes">Available</div>');
    await processSearchResults(titleAdapter, document);
    expect(document.getElementById('flora-alert-toast')?.textContent).toContain('Retry');
    document.querySelector('main')!.outerHTML = '<main><div class="result" data-doi="yes">Replacement result</div></main>';
    await processSearchResults(titleAdapter, document);
    expect(document.getElementById('flora-alert-toast')).toBeNull();
    expect(document.querySelectorAll('[data-flora-panel]')).toHaveLength(1);
});

it("keeps cancellation stopped but restores recovery after cancelling a queued Retry", async () => {
    send.mockResolvedValue({type: "FLORA_LOOKUP_RESULT", results: {}, errors: {}});
    retraction.mockRejectedValueOnce(new Error("Unavailable"));
    const {processSearchResults} = await import("../../src/content-search/pipeline");
    await processSearchResults(adapter, document);
    await vi.waitFor(() => expect(document.querySelector("#flora-alert-toast button")).not.toBeNull());
    const {beginWorkIndicator, endWorkIndicator, isWorkCancelled} = await import("../../src/shared/progress-toast");
    beginWorkIndicator();
    await vi.waitFor(() => expect(document.querySelector("[data-flora-work-cancel]")).not.toBeNull());
    document.querySelector<HTMLButtonElement>("#flora-alert-toast button")!.click();
    document.querySelector<HTMLButtonElement>("[data-flora-work-cancel]")!.click();
    expect(isWorkCancelled()).toBe(true);
    endWorkIndicator();
    await vi.waitFor(() => expect(document.getElementById("flora-alert-toast")?.textContent).toContain("Retraction checks unavailable"));
    expect(retraction).toHaveBeenCalledTimes(1);
    const {canStartAutomaticWork} = await import("../../src/shared/work-cancellation");
    expect(canStartAutomaticWork()).toBe(false);
    document.querySelector<HTMLButtonElement>("#flora-alert-toast button")!.click();
    await vi.waitFor(() => expect(retraction).toHaveBeenCalledTimes(2));
    expect(document.getElementById("flora-alert-toast")).toBeNull();
});

it.each(["success", "failure"])("ignores stale notice %s after A → B → A without an intervening scan", async (outcome) => {
    send.mockResolvedValue({type: "FLORA_LOOKUP_RESULT", results: {}, errors: {}});
    let resolveOld!: (value: unknown) => void;
    let rejectOld!: (reason: Error) => void;
    retraction.mockImplementationOnce(() => new Promise((resolve, reject) => {resolveOld = resolve; rejectOld = reject;}));
    const {processSearchResults, setSearchHidden} = await import("../../src/content-search/pipeline");
    await processSearchResults(adapter, document);
    const initialUrl = location.href;
    history.pushState({}, "", "/another-search");
    navigationEvents.dispatchEvent(new Event("currententrychange"));
    history.replaceState({}, "", initialUrl);
    navigationEvents.dispatchEvent(new Event("currententrychange"));
    // The SPA reuses its result nodes; navigation must release our old processing marker.
    expect(document.querySelector(".result")?.hasAttribute("data-flora-processed")).toBe(false);
    const currentNotice = {originDoi: DOI, doi: "10.1234/current-notice", kind: "concern"};
    retraction.mockResolvedValueOnce([currentNotice]);
    await processSearchResults(adapter, document);
    await vi.waitFor(() => expect(badges.mock.lastCall![2]).toEqual([currentNotice]));
    if (outcome === "success") resolveOld([{originDoi: DOI, doi: "10.1234/obsolete-notice", kind: "retraction"}]);
    else rejectOld(new Error("Old page check failed"));
    await new Promise(resolve => setTimeout(resolve, 0));
    setSearchHidden(false); // Re-render from retained state to catch silent stale-map writes too.
    expect(badges.mock.lastCall![2]).toEqual([currentNotice]);
    expect(document.getElementById("flora-alert-toast")).toBeNull();
});

it("does not start notice checks from an old site-id resolution after A → B → A", async () => {
    let release!: (value: Map<string, DoiString>) => void;
    const siteAdapter: SearchSiteAdapter = {
        ...adapter,
        extractRow: () => ({doi: null, siteId: "record", confident: false, title: "Paper", firstAuthor: null, year: null, sourceUrl: null}),
        resolveSiteIds: () => new Promise(resolve => {release = resolve;}),
    };
    const {processSearchResults} = await import("../../src/content-search/pipeline");
    const pending = processSearchResults(siteAdapter, document);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const initialUrl = location.href;
    history.pushState({}, "", "/other-results");
    navigationEvents.dispatchEvent(new Event("currententrychange"));
    history.replaceState({}, "", initialUrl);
    navigationEvents.dispatchEvent(new Event("currententrychange"));
    document.body.innerHTML = '<div class="result"></div>';
    release(new Map([["record", DOI]]));
    await pending;
    expect(retraction).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(document.querySelector("[data-flora-panel]")).toBeNull();
});

it("refreshes reused rows after a hash navigation without an explicit pipeline call", async () => {
    send.mockResolvedValue({type: "FLORA_LOOKUP_RESULT", results: {}, errors: {}});
    const notice = {originDoi: DOI, doi: "10.1234/notice", kind: "concern"};
    retraction.mockResolvedValue([notice]);
    const {processSearchResults} = await import("../../src/content-search/pipeline");
    const {observeSearchResults} = await import("../../src/content-search/observer");
    await processSearchResults(adapter, document);
    await vi.waitFor(() => expect(badges.mock.lastCall![2]).toEqual([notice]));
    observeSearchResults(adapter);
    history.pushState({}, "", "#next-section");
    navigationEvents.dispatchEvent(new Event("currententrychange"));
    await vi.waitFor(() => expect(retraction).toHaveBeenCalledTimes(2));
    expect(document.querySelectorAll("[data-flora-panel]")).toHaveLength(1);
    expect(badges.mock.lastCall![2]).toEqual([notice]);
});

it("does not apply a queued shared Retry after A → B → A navigation", async () => {
    const augment = vi.fn().mockResolvedValue(new Map());
    vi.doMock("../../src/shared/messages", () => ({safeSendMessage: send, augmentDOIsViaWorker: augment}));
    const titleAdapter = {...adapter, extractRow: () => ({
        doi: null, confident: false, title: "Paper", firstAuthor: null, year: null, sourceUrl: null,
    })};
    const {processSearchResults} = await import("../../src/content-search/pipeline");
    await processSearchResults(titleAdapter, document);
    const {beginWorkIndicator, endWorkIndicator} = await import("../../src/shared/progress-toast");
    beginWorkIndicator();
    document.querySelector<HTMLButtonElement>("#flora-alert-toast button")!.click();
    const originalUrl = location.href;
    history.pushState({}, "", "/other-results");
    navigationEvents.dispatchEvent(new Event("currententrychange"));
    history.replaceState({}, "", originalUrl);
    navigationEvents.dispatchEvent(new Event("currententrychange"));
    endWorkIndicator();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(augment).toHaveBeenCalledOnce();
    expect(document.getElementById("flora-alert-toast")).toBeNull();
    expect(document.querySelector("[data-flora-panel]")).toBeNull();
});

it("lets the new page queue recovery while an older page Retry is still unwinding", async () => {
    send.mockResolvedValue({results: {}, errors: {}});
    retraction.mockRejectedValueOnce(new Error("Page A unavailable"))
        .mockRejectedValueOnce(new Error("Page B unavailable"));
    const {processSearchResults} = await import("../../src/content-search/pipeline");
    await processSearchResults(adapter, document);
    await vi.waitFor(() => expect(document.querySelector("#flora-alert-toast button")).not.toBeNull());
    const {beginWorkIndicator, endWorkIndicator} = await import("../../src/shared/progress-toast");
    beginWorkIndicator();
    document.querySelector<HTMLButtonElement>("#flora-alert-toast button")!.click();
    history.pushState({}, "", "/new-search");
    navigationEvents.dispatchEvent(new Event("currententrychange"));
    await processSearchResults(adapter, document);
    await vi.waitFor(() => expect(document.querySelector("#flora-alert-toast button")).not.toBeNull());
    document.querySelector<HTMLButtonElement>("#flora-alert-toast button")!.click();
    endWorkIndicator();
    await vi.waitFor(() => expect(retraction).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(document.getElementById("flora-alert-toast")).toBeNull());
    expect(send).toHaveBeenCalledTimes(2);
});


it.each(['resolve', 'reject'])("restores a previous row's confirmed DOI after a later pass is cancelled (%s)", async outcome => {
    const result = mockResult();
    send.mockResolvedValueOnce({results: {[DOI]: result}, errors: {}});
    const {processSearchResults} = await import("../../src/content-search/pipeline");
    await processSearchResults(adapter, document);
    const original = document.querySelector('.result')!;
    let settle!: () => void;
    send.mockImplementationOnce(() => new Promise((resolve, reject) => {
        settle = () => outcome === 'resolve' ? resolve({results: {}, errors: {}}) : reject(new Error('cancelled'));
    }));
    document.body.insertAdjacentHTML('beforeend', '<div class="result" id="later"></div>');
    const later = processSearchResults(adapter, document);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    const {cancelWork} = await import("../../src/shared/work-cancellation");
    cancelWork(); settle(); await later;
    expect(badges.mock.lastCall![1].get(DOI)).toEqual({status: 'matched', result, source: 'extracted'});
    expect(original.hasAttribute('data-flora-processed')).toBe(true);
    expect(original.querySelector('[data-flora-panel]')).not.toBeNull();
    expect(document.querySelector('#later')?.hasAttribute('data-flora-processed')).toBe(false);
    expect(document.querySelector('#later [data-flora-panel]')).toBeNull();
});
