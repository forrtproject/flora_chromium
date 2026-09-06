import {beforeEach, expect, it, vi} from "vitest";
import type {SearchSiteAdapter} from "../../src/content-search/sites/types";
import type {DoiString} from "../../src/shared/types";

const DOI = "10.1234/paper" as DoiString;
const send = vi.fn();
const badges = vi.fn();
const adapter: SearchSiteAdapter = {
    id: "test", label: "Test", hostnames: [], css: "", resultRow: ".result", panelPlacement: [],
    extractRow: () => ({doi: DOI, confident: true, title: "Paper", firstAuthor: null, year: null, sourceUrl: null}),
};
beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '<div class="result"></div>';
    send.mockReset();
    badges.mockClear();
    (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockResolvedValue({flora_settings: {email: "reader@example.com"}});
    vi.doMock("../../src/shared/messages", () => ({safeSendMessage: send, augmentDOIsViaWorker: vi.fn()}));
    vi.doMock("../../src/shared/openaccess", () => ({fetchOpenAccess: vi.fn().mockResolvedValue(null)}));
    vi.doMock("../../src/shared/doi-retraction", () => ({retractionCheck: vi.fn().mockResolvedValue([])}));
    vi.doMock("../../src/shared/indicator-pill", () => ({
        updateIndicatorPillBadges: badges,
        createIndicatorPanel: () => {const panel = document.createElement("div"); panel.setAttribute("data-flora-panel", ""); return panel;},
    }));
});

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
