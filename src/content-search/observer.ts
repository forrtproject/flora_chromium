// Watches the page for result rows the site adds after load — Scholar's
// "show more", OpenAlex's client-side page changes — and runs the pipeline on
// each new batch. Observing the whole document (rather than a results
// container) keeps this working on single-page apps that replace the
// container itself.

import {debugError} from "@shared/debug";
import {processSearchResults} from "./pipeline";
import type {SearchSiteAdapter} from "./sites/types";

const SETTLE_MS = 150;

export function observeSearchResults(adapter: SearchSiteAdapter): void {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const queuePass = (): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            void processSearchResults(adapter, document).catch((err) =>
                debugError(`${adapter.label}: pass on changed search results failed —`, err)
            );
        }, SETTLE_MS);
    };
    // Same-document navigation may reuse every result node, so no added-row
    // mutation will arrive. Coalesce rapid history changes and read the final DOM.
    let observedUrl = location.href;
    (window as Window & {navigation?: EventTarget}).navigation?.addEventListener("currententrychange", () => {
        if (observedUrl === location.href) return;
        observedUrl = location.href;
        queuePass();
    });

    const observer = new MutationObserver((mutations) => {
        let hasNewRows = false;
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (
                    node instanceof HTMLElement &&
                    (node.matches(adapter.resultRow) || node.querySelector(adapter.resultRow))
                ) {
                    hasNewRows = true;
                    break;
                }
            }
            if (hasNewRows) break;
        }
        if (!hasNewRows) return;

        // Frameworks add rows one node at a time; wait for the batch to settle
        // so the pipeline sees them together (one toast, one lookup).
        queuePass();
    });

    observer.observe(document.documentElement, {childList: true, subtree: true});
}
