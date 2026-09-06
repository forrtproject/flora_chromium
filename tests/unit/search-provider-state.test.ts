import {beforeEach, expect, it, vi} from "vitest";
import type {SearchSiteAdapter} from "../../src/content-search/sites/types";
import type {DoiString} from "../../src/shared/types";

const DOI = "10.1234/paper" as DoiString;
const send = vi.fn();
const badges = vi.fn();
const retraction = vi.fn();
const adapter: SearchSiteAdapter = {
    id: "test", label: "Test", hostnames: [], css: "", resultRow: ".result", panelPlacement: [],
    extractRow: () => ({doi: DOI, confident: true, title: "Paper", firstAuthor: null, year: null, sourceUrl: null}),
};
beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '<div class="result"></div>';
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
    const {beginWorkIndicator, endWorkIndicator} = await import("../../src/shared/progress-toast");
    const {cancelWork} = await import("../../src/shared/work-cancellation");
    beginWorkIndicator(); // An older pass has not unwound its last work item yet.
    cancelWork();
    retry.click();
    await vi.waitFor(() => expect(badges.mock.lastCall![2]).toEqual([notice]));
    expect(retraction).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    endWorkIndicator();
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
