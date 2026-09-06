import {describe, it, expect, beforeEach, afterEach, vi} from "vitest";
import {scanAddedNodes, startDomListener} from "../../src/content-general/dom-listener";

const DEBOUNCE_MS = 300;

function add(html: string): Element {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = html;
    const el = wrapper.firstElementChild!;
    document.body.appendChild(el);
    return el;
}

describe("scanAddedNodes", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
    });

    it("is false when added subtrees carry no DOI", () => {
        const nodes = [add(`<div class="cookie-banner">We use cookies</div>`), add(`<aside>Ad slot</aside>`)];
        expect(scanAddedNodes(nodes)).toBe(false);
    });

    it("is true when an added subtree carries a DOI", () => {
        const nodes = [add(`<div>Ad slot</div>`), add(`<li>Ref. 10.1038/nature12373</li>`)];
        expect(scanAddedNodes(nodes)).toBe(true);
    });

    it("ignores nodes already detached from the document", () => {
        const detached = document.createElement("li");
        detached.textContent = "10.1038/nature12373";
        expect(scanAddedNodes([detached])).toBe(false);
    });
});

describe("startDomListener", () => {
    let observer: MutationObserver | undefined;
    let scanWholePage: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = "<main><p>Article body</p></main>";
        scanWholePage = vi.fn();
    });

    afterEach(() => {
        observer?.disconnect();
        observer = undefined;
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    function listen(getLastUrl = () => location.href): void {
        observer = startDomListener({scanWholePage, getLastUrl});
    }

    it("coalesces new same-URL history entries and skips unchanged entry state updates", () => {
        const navigation = Object.assign(new EventTarget(), {currentEntry: {key: "first"}});
        vi.stubGlobal("navigation", navigation);
        listen();
        navigation.dispatchEvent(new Event("currententrychange"));
        vi.advanceTimersByTime(DEBOUNCE_MS);
        expect(scanWholePage).not.toHaveBeenCalled();
        navigation.currentEntry = {key: "second"};
        navigation.dispatchEvent(new Event("currententrychange"));
        navigation.currentEntry = {key: "third"};
        navigation.dispatchEvent(new Event("currententrychange"));
        vi.advanceTimersByTime(DEBOUNCE_MS);
        expect(scanWholePage).toHaveBeenCalledTimes(1);
    });

    it("skips the full scan for mutations with no DOI content", async () => {
        listen();
        document.querySelector("main")!.appendChild(
            Object.assign(document.createElement("div"), {textContent: "Accept cookies?"})
        );

        await Promise.resolve();
        vi.advanceTimersByTime(DEBOUNCE_MS);
        expect(scanWholePage).not.toHaveBeenCalled();
    });

    it("runs a full scan when a mutation brings a DOI onto the page", async () => {
        listen();
        document.querySelector("main")!.appendChild(
            Object.assign(document.createElement("li"), {textContent: "Ref. 10.1038/nature12373"})
        );

        await Promise.resolve();
        vi.advanceTimersByTime(DEBOUNCE_MS);
        expect(scanWholePage).toHaveBeenCalledTimes(1);
    });

    it("runs a full scan when a DOI arrives only in an href", async () => {
        listen();
        const link = document.createElement("a");
        link.href = "https://doi.org/10.1038/nature12373";
        link.textContent = "Full text";
        document.querySelector("main")!.appendChild(link);

        await Promise.resolve();
        vi.advanceTimersByTime(DEBOUNCE_MS);
        expect(scanWholePage).toHaveBeenCalledTimes(1);
    });

    it("falls back to a full scan when the page shell itself is re-rendered", async () => {
        listen();
        document.body.appendChild(
            Object.assign(document.createElement("div"), {textContent: "New shell, no DOIs"})
        );

        await Promise.resolve();
        vi.advanceTimersByTime(DEBOUNCE_MS);
        expect(scanWholePage).toHaveBeenCalledTimes(1);
    });

    it("falls back to a full scan on a large structural change", async () => {
        listen();
        const main = document.querySelector("main")!;
        for (let i = 0; i < 60; i++) {
            main.appendChild(
                Object.assign(document.createElement("div"), {textContent: `row ${i}`})
            );
        }

        await Promise.resolve();
        vi.advanceTimersByTime(DEBOUNCE_MS);
        expect(scanWholePage).toHaveBeenCalledTimes(1);
    });

    it("runs a full scan when the URL changed since the last scan", async () => {
        listen(() => "https://example.com/previous-route");
        document.querySelector("main")!.appendChild(
            Object.assign(document.createElement("div"), {textContent: "SPA route content"})
        );

        await Promise.resolve();
        vi.advanceTimersByTime(DEBOUNCE_MS);
        expect(scanWholePage).toHaveBeenCalledTimes(1);
    });

    it("ignores FLoRA's own injected nodes", async () => {
        listen();
        const pill = document.createElement("span");
        pill.className = "flora-indicator-pill";
        pill.textContent = "10.1038/nature12373";
        document.querySelector("main")!.appendChild(pill);

        await Promise.resolve();
        vi.advanceTimersByTime(DEBOUNCE_MS);
        expect(scanWholePage).not.toHaveBeenCalled();
    });
});
