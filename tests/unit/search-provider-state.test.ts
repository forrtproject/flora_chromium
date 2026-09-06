import {afterEach, beforeEach, expect, it, vi} from "vitest";
import type {SearchSiteAdapter} from "../../src/content-search/sites/types";
import type {DoiString} from "../../src/shared/types";

const DOI = "10.1234/paper" as DoiString;
const send = vi.fn();
const badges = vi.fn();
const retraction = vi.fn();
let navigationEvents: EventTarget;
const NativeMutationObserver = MutationObserver;
const observers: MutationObserver[] = [];
const adapter: SearchSiteAdapter = {
    id: "test", label: "Test", hostnames: [], css: "", resultRow: ".result", panelPlacement: [],
    extractRow: () => ({doi: DOI, confident: true, title: "Paper", firstAuthor: null, year: null, sourceUrl: null}),
};
beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("MutationObserver", class extends NativeMutationObserver {
        constructor(callback: MutationCallback) { super(callback); observers.push(this); }
    });
    document.body.innerHTML = '<div class="result"></div>';
    navigationEvents = new EventTarget();
    vi.stubGlobal("navigation", navigationEvents);
    send.mockReset();
    badges.mockClear();
    retraction.mockReset().mockResolvedValue([]);
    vi.doMock("../../src/shared/messages", () => ({safeSendMessage: send, augmentDOIsViaWorker: vi.fn()}));
    vi.doMock("../../src/shared/openaccess", () => ({fetchOpenAccess: vi.fn().mockResolvedValue(null)}));
    vi.doMock("../../src/shared/doi-retraction", () => ({retractionCheck: retraction}));
    vi.doMock("../../src/shared/indicator-pill", () => ({
        updateIndicatorPillBadges: badges,
        createIndicatorPanel: () => {const panel = document.createElement("div"); panel.setAttribute("data-flora-panel", ""); return panel;},
    }));
});

afterEach(() => {
    for (const observer of observers.splice(0)) observer.disconnect();
    vi.unstubAllGlobals();
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

it.each(["success", "failure", "same-URL entry"])("ignores stale notice %s after navigation without an intervening scan", async (outcome) => {
    send.mockResolvedValue({type: "FLORA_LOOKUP_RESULT", results: {}, errors: {}});
    let resolveOld!: (value: unknown) => void;
    let rejectOld!: (reason: Error) => void;
    retraction.mockImplementationOnce(() => new Promise((resolve, reject) => {resolveOld = resolve; rejectOld = reject;}));
    const {processSearchResults, setSearchHidden} = await import("../../src/content-search/pipeline");
    await processSearchResults(adapter, document);
    const initialUrl = location.href;
    if (outcome === "same-URL entry") {
        (navigationEvents as EventTarget & {currentEntry: {key: string}}).currentEntry = {key: "new-entry"};
        navigationEvents.dispatchEvent(new Event("currententrychange"));
    } else {
        history.pushState({}, "", "/another-search");
        navigationEvents.dispatchEvent(new Event("currententrychange"));
        history.replaceState({}, "", initialUrl);
        navigationEvents.dispatchEvent(new Event("currententrychange"));
    }
    // The SPA reuses its result nodes; navigation must release our old processing marker.
    expect(document.querySelector(".result")?.hasAttribute("data-flora-processed")).toBe(false);
    const currentNotice = {originDoi: DOI, doi: "10.1234/current-notice", kind: "concern"};
    retraction.mockResolvedValueOnce([currentNotice]);
    await processSearchResults(adapter, document);
    await vi.waitFor(() => expect(badges.mock.lastCall![2]).toEqual([currentNotice]));
    if (outcome !== "failure") resolveOld([{originDoi: DOI, doi: "10.1234/obsolete-notice", kind: "retraction"}]);
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


it("ignores a duplicate Retry while recovery is running, even when recovery fails", async () => {
    send.mockResolvedValue({type: "FLORA_LOOKUP_RESULT", results: {}, errors: {}});
    let fail!: (reason: Error) => void;
    retraction.mockRejectedValueOnce(new Error("Unavailable"))
        .mockImplementationOnce(() => new Promise((_resolve, reject) => {fail = reject;}));
    const {processSearchResults} = await import("../../src/content-search/pipeline");
    await processSearchResults(adapter, document);
    await vi.waitFor(() => expect(document.querySelector("#flora-alert-toast button")).not.toBeNull());
    document.querySelector<HTMLButtonElement>("#flora-alert-toast button")!.click();
    await vi.waitFor(() => expect(retraction).toHaveBeenCalledTimes(2));
    document.querySelector<HTMLButtonElement>("#flora-alert-toast button")!.click();
    fail(new Error("Still unavailable"));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(retraction).toHaveBeenCalledTimes(2);
    expect(document.querySelector("#flora-alert-toast button")?.textContent).toBe("Retry");
});

it("refreshes same-URL new history entries but ignores unchanged-entry state updates", async () => {
    const navigation = navigationEvents as EventTarget & {currentEntry: {key: string}};
    navigation.currentEntry = {key: "first"};
    send.mockResolvedValue({type: "FLORA_LOOKUP_RESULT", results: {}, errors: {}});
    const {processSearchResults} = await import("../../src/content-search/pipeline");
    const {observeSearchResults} = await import("../../src/content-search/observer");
    await processSearchResults(adapter, document);
    observeSearchResults(adapter);
    navigation.dispatchEvent(new Event("currententrychange"));
    await new Promise(resolve => setTimeout(resolve, 180));
    expect(retraction).toHaveBeenCalledTimes(1);
    navigation.currentEntry = {key: "second"};
    navigation.dispatchEvent(new Event("currententrychange"));
    await vi.waitFor(() => expect(retraction).toHaveBeenCalledTimes(2));
    expect(document.querySelectorAll("[data-flora-panel]")).toHaveLength(1);
});
