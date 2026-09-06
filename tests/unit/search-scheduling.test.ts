import {afterEach, beforeEach, expect, it, vi} from "vitest";
import type {DoiString} from "../../src/shared/types";
import type {SearchSiteAdapter} from "../../src/content-search/sites/types";

let visible = true;
const send = vi.fn();
const adapter: SearchSiteAdapter = {
    id: "test", label: "Test", hostnames: [], css: "", resultRow: ".result", panelPlacement: [],
    extractRow: row => ({doi: row.dataset.doi as DoiString, confident: true, title: "Paper", firstAuthor: null, year: null, sourceUrl: null}),
};
const addRow = (id: string) => document.body.insertAdjacentHTML("beforeend", `<div class="result" data-doi="10.1234/${id}"></div>`);

beforeEach(() => {
    vi.resetModules();
    visible = true;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible ? "visible" : "hidden");
    document.body.innerHTML = "";
    send.mockReset().mockResolvedValue({results: {}, errors: {}});
    vi.doMock("../../src/shared/messages", () => ({safeSendMessage: send, augmentDOIsViaWorker: vi.fn()}));
    vi.doMock("../../src/shared/openaccess", () => ({fetchOpenAccess: vi.fn().mockResolvedValue(null)}));
    vi.doMock("../../src/shared/doi-retraction", () => ({retractionCheck: vi.fn().mockResolvedValue([])}));
    vi.doMock("../../src/shared/indicator-pill", () => ({
        updateIndicatorPillBadges: vi.fn(),
        createIndicatorPanel: () => {const panel = document.createElement("div"); panel.setAttribute("data-flora-panel", ""); return panel;},
    }));
});
afterEach(() => { vi.restoreAllMocks(); });

it("coalesces background mutation passes and sends no provider requests until visible", async () => {
    const {processSearchResults} = await import("../../src/content-search/pipeline");
    visible = false;
    addRow("first");
    const pending = processSearchResults(adapter, document);
    await Promise.resolve();
    addRow("second");
    expect(processSearchResults(adapter, document)).toBe(pending);
    expect(send).not.toHaveBeenCalled();
    visible = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await pending;
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].dois).toEqual(["10.1234/first", "10.1234/second"]);
});

it("keeps queued and later mutation passes stopped after Cancel, until resume or navigation", async () => {
    const {processSearchResults, setSearchHidden} = await import("../../src/content-search/pipeline");
    const {cancelWork} = await import("../../src/shared/work-cancellation");
    const originalUrl = location.href;
    const {SCHOLAR} = await import("../../src/content-search/sites/scholar");
    const scholarAdapter = {...adapter, preparePanelTarget: SCHOLAR.preparePanelTarget, panelPlacement: SCHOLAR.panelPlacement};
    let settle!: (value: unknown) => void;
    send.mockImplementationOnce(() => new Promise(resolve => {settle = resolve;}));
    addRow("first");
    addRow("native");
    const nativeTarget = document.createElement("div");
    nativeTarget.className = "gs_ggs";
    document.querySelector('[data-doi="10.1234/native"]')!.appendChild(nativeTarget);
    const active = processSearchResults(scholarAdapter, document);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    addRow("second");
    const queued = processSearchResults(scholarAdapter, document);
    expect(processSearchResults(scholarAdapter, document)).toBe(queued);
    cancelWork();
    settle({results: {}, errors: {}});
    await Promise.all([active, queued]);
    await processSearchResults(scholarAdapter, document);
    expect(send).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-doi="10.1234/first"] .gs_ggs')).toBeNull();
    expect(nativeTarget.isConnected).toBe(true);
    expect(nativeTarget.childNodes).toHaveLength(0);
    expect(document.querySelector('[data-doi="10.1234/second"]')?.hasAttribute("data-flora-processed")).toBe(false);
    setSearchHidden(false);
    await processSearchResults(scholarAdapter, document);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].dois).toEqual(["10.1234/first", "10.1234/native", "10.1234/second"]);
    expect(document.querySelectorAll("[data-flora-panel]")).toHaveLength(3);
    cancelWork();
    addRow("third");
    history.replaceState(null, "", "/next-search");
    await processSearchResults(scholarAdapter, document);
    expect(send).toHaveBeenCalledTimes(3);
    history.replaceState(null, "", originalUrl);
    addRow("fourth");
    await processSearchResults(scholarAdapter, document);
    expect(send).toHaveBeenCalledTimes(4);
});


it("releases a hidden pending pass after cancellation or page teardown", async () => {
    const {processSearchResults, setSearchHidden} = await import("../../src/content-search/pipeline");
    const {beginCancellableWork, endCancellableWork, cancelWork} = await import("../../src/shared/work-cancellation");
    visible = false;
    addRow("waiting");
    beginCancellableWork();
    const cancelled = processSearchResults(adapter, document);
    await Promise.resolve();
    cancelWork();
    await cancelled;
    endCancellableWork();
    expect(send).not.toHaveBeenCalled();
    setSearchHidden(false);
    const discarded = processSearchResults(adapter, document);
    await Promise.resolve();
    await Promise.resolve();
    window.dispatchEvent(new PageTransitionEvent("pagehide", {persisted: false}));
    await discarded;
    expect(send).not.toHaveBeenCalled();
    visible = true;
    await processSearchResults(adapter, document);
    expect(send).toHaveBeenCalledTimes(1);
});
