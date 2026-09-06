import {describe, it, expect, beforeEach, vi} from "vitest";
import {renderSidePanel} from "../../src/content-general/injector";
import type {DoiContext, DoiString, LookupState} from "../../src/shared/types";
import {doi, mockResult} from "../helpers";

const ARTICLE = doi("10.1037/pspp0000136");

function render(articleTitle: string | null = null): void {
    const pageState = new Map<DoiString, LookupState>([
        [ARTICLE, {status: "matched", result: mockResult(), source: "extracted"}],
    ]);
    const doiContext = new Map<DoiString, DoiContext>([[ARTICLE, "article"]]);
    renderSidePanel([], [], pageState, doiContext, new Map(), [], articleTitle);
}

function panelTitle(): string {
    const link = document.querySelector<HTMLElement>("#flora-pubpeer-panel a[title='Open in FLoRA'] span");
    return link?.textContent ?? "";
}

describe("side panel article title", () => {
    beforeEach(() => {
        document.head.innerHTML = "";
        document.body.innerHTML = "";
        document.title = "";
    });

    it("keeps other findings visible when PubPeer is unavailable and retries without claiming no discussion", async () => {
        const state = new Map<DoiString, LookupState>([[ARTICLE, {status: "matched", result: mockResult(), source: "extracted"}]]);
        const context = new Map<DoiString, DoiContext>([[ARTICLE, "article"]]);
        const retry = vi.fn(async () => renderSidePanel([], [], state, context, new Map(), [], "Test article"));
        renderSidePanel([], [], state, context, new Map(), [], "Test article", retry);
        const panel = document.getElementById("flora-pubpeer-panel")!;
        expect(panel.textContent).toContain("PubPeer unavailable");
        expect(panel.textContent).not.toContain("hasn't been discussed");
        expect(panelTitle()).toBe("Test article");
        const button = [...panel.querySelectorAll("button")].find(node => node.textContent === "Retry")!;
        button.focus();
        button.click();
        await vi.waitFor(() => expect(document.getElementById("flora-pubpeer-panel")!.textContent).toContain("No PubPeer comments yet"));
        expect(retry).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(document.activeElement).toBe(
            document.querySelector('#flora-pubpeer-panel [aria-label="Close panel"]')));
    });

    it("does not steal focus moved elsewhere while PubPeer retry is pending", async () => {
        const other = document.createElement('button');
        document.body.appendChild(other);
        let finish!: () => void;
        const state = new Map<DoiString, LookupState>();
        const context = new Map<DoiString, DoiContext>([[ARTICLE, "article"]]);
        const retry = async () => {
            await new Promise<void>(resolve => {finish = resolve;});
            renderSidePanel([], [], state, context, new Map(), [], "Article");
        };
        renderSidePanel([], [], state, context, new Map(), [], "Article", retry);
        const button = [...document.querySelectorAll<HTMLButtonElement>('#flora-pubpeer-panel button')]
            .find(node => node.textContent === 'Retry')!;
        button.focus(); button.click(); other.focus(); finish();
        await vi.waitFor(() => expect(document.getElementById('flora-pubpeer-panel')?.textContent).toContain('No PubPeer comments yet'));
        expect(document.activeElement).toBe(other);
    });

    it("prefers the DOI-resolved title over the page's own metadata", () => {
        document.title = "APA PsycNet";
        render("The incremental validity of average state self-reports");

        expect(panelTitle()).toBe("The incremental validity of average state self-reports");
    });

    it("leaves FLoRA's injected pill text out of a heading-derived title", () => {
        document.body.innerHTML =
            `<h1>Real Article Title<span data-flora-ui>DOI 10.1037/pspp0000136 1 rep</span></h1>`;
        render();

        expect(panelTitle()).toBe("Real Article Title");
    });

    it("skips a masthead heading in favour of the article heading", () => {
        document.body.innerHTML =
            `<header><h1>APA PsycNet</h1></header><main><h1>Real Article Title</h1></main>`;
        render();

        expect(panelTitle()).toBe("Real Article Title");
    });

    it("re-renders when the title changes", () => {
        document.title = "APA PsycNet";
        render();
        expect(panelTitle()).toBe("APA PsycNet");

        render("The incremental validity of average state self-reports");
        expect(panelTitle()).toBe("The incremental validity of average state self-reports");
    });
});
