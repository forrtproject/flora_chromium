import {containsDoiCandidate, touchesReferenceSection} from "@shared/doi-extractor";
import {isExternalMutation, isFloraOwnedNode, owningElement} from "@shared/flora-ui";
import {debugLog} from "@shared/debug";

const MAX_INCREMENTAL_NODES = 50;

const DEBOUNCE_MS = 300;

/** True when any added subtree introduces DOI-like content or reference entries. */
export function scanAddedNodes(nodes: Element[]): boolean {
    for (const el of nodes) {
        if (!el.isConnected) continue;
        if (containsDoiCandidate(el)) return true;
        if (touchesReferenceSection(el)) return true;
    }
    return false;
}

export interface DomListenerOptions {
    scanWholePage: () => void;
    /** Current URL as of the last full scan — a change means SPA navigation. */
    getLastUrl: () => string;
}
export function startDomListener({scanWholePage, getLastUrl}: DomListenerOptions): MutationObserver {
    let debounceTimer: ReturnType<typeof setTimeout>;
    let pendingNodes: Element[] = [];
    let pendingFullScan = false;
    let missedWhileHidden = false;

    const flush = (): void => {
        const nodes = pendingNodes;
        const full = pendingFullScan;
        pendingNodes = [];
        pendingFullScan = false;
        if (full || location.href !== getLastUrl() || scanAddedNodes(nodes)) {
            scanWholePage();
        } else {
            debugLog("General: mutation carried no DOI candidates — skipped full scan");
        }
    };

    const navigation = (window as Window & {navigation?: EventTarget & {currentEntry?: {key: string}}}).navigation;
    let observedUrl = location.href;
    let observedKey = navigation?.currentEntry?.key;
    navigation?.addEventListener("currententrychange", () => {
        const key = navigation.currentEntry?.key;
        if (observedUrl === location.href && observedKey === key) return;
        observedUrl = location.href;
        observedKey = key;
        pendingFullScan = true;
        if (document.hidden) { missedWhileHidden = true; return; }
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(flush, DEBOUNCE_MS);
    });

    const observer = new MutationObserver((mutations) => {
        // Do no work while this tab is in the background.
        if (document.hidden) {
            missedWhileHidden = true;
            return;
        }
        let hasExternalChange = false;
        for (const m of mutations) {
            if (!isExternalMutation(m)) continue;
            hasExternalChange = true;
            if (m.target === document.body || m.target === document.documentElement) {
                pendingFullScan = true;
            }
            for (const node of m.addedNodes) {
                if (isFloraOwnedNode(node)) continue;
                const el = owningElement(node);
                if (el) pendingNodes.push(el);
            }
        }
        if (!hasExternalChange) return;
        if (pendingNodes.length > MAX_INCREMENTAL_NODES) pendingFullScan = true;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(flush, DEBOUNCE_MS);
    });
    observer.observe(document.body, {childList: true, subtree: true});
    document.addEventListener("visibilitychange", () => {
        if (document.hidden || !missedWhileHidden) return;
        missedWhileHidden = false;
        clearTimeout(debounceTimer);
        pendingFullScan = false;
        pendingNodes = [];
        scanWholePage();
    });
    return observer;
}
