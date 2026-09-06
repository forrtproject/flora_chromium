// Content script for search-results sites (Google Scholar, OpenAlex, …). The
// site adapter chosen by hostname supplies selectors, row reading and panel
// placement; pipeline.ts does everything else.

import {resolveSearchSite} from "./sites";
import {observeSearchResults} from "./observer";
import {isSearchHidden, processSearchResults, retryUnansweredSearchResults, setSearchHidden} from "./pipeline";
import {debugError, debugLog} from "@shared/debug";
import {installErrorReporting, reportCodeError} from "@shared/error-report";
import {isSetupComplete} from "@shared/settings";
import {isDomainBlocked, isDomainSnoozed} from "@shared/domains";
import {renderSetupPrompt, hideAllFloraUI, showAllFloraUI} from "../content-general/injector";

const SITE_STYLE_ID = "flora-search-site-style";

// Tell the service worker whether FLoRA is active on this tab (toolbar icon).
function reportActiveState(active: boolean): void {
    try {
        chrome.runtime.sendMessage({type: "FLORA_ACTIVE_STATE", active}).catch(() => {});
    } catch {
        // extension context unavailable — ignore
    }
}

function injectSiteStyle(css: string): void {
    if (document.getElementById(SITE_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = SITE_STYLE_ID;
    style.textContent = css;
    (document.head ?? document.documentElement).appendChild(style);
}

(async () => {
    try {
        if (window !== window.top) return;
        installErrorReporting();

        const adapter = resolveSearchSite(location.hostname);
        if (!adapter) {
            debugLog("Search content script: no adapter for", location.hostname);
            return;
        }

        if (await isDomainBlocked(location.hostname)) {
            debugLog("Domain is blocked:", location.hostname);
            reportActiveState(false);
            return;
        }

        if (await isDomainSnoozed(location.hostname)) {
            debugLog("Domain is snoozed:", location.hostname);
            reportActiveState(false);
            return;
        }
        reportActiveState(true);

        if (!(await isSetupComplete())) {
            renderSetupPrompt();
        }

        debugLog(`${adapter.label} content script loaded`);
        injectSiteStyle(adapter.css);

        // Process any results already on the page
        void processSearchResults(adapter, document).catch((err) =>
            debugError(`${adapter.label}: initial pass failed —`, err)
        );

        // Start observing for dynamically loaded results
        observeSearchResults(adapter);

        chrome.storage.onChanged.addListener((changes, area) => {
            const settings = changes.flora_settings;
            if (area !== "sync" || !settings?.newValue?.email?.trim()
                || settings.newValue.email === settings.oldValue?.email) return;
            void retryUnansweredSearchResults(adapter, document).catch(err =>
                debugError(`${adapter.label}: DOI matching after settings change failed —`, err));
        });
    } catch (err) {
        reportCodeError("ORE failed to start on search page", err);
        reportActiveState(false);
    }
})();

// hideAllFloraUI/showAllFloraUI already sweep the indicator panels, which are
// the only per-result UI search rows carry.
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (typeof message !== "object" || message === null) return;
    const type = (message as { type?: string }).type;

    if (type === "FLORA_HIDE_UI") {
        setSearchHidden(true);
        hideAllFloraUI();
        reportActiveState(false);
        sendResponse({ ok: true });
    } else if (type === "FLORA_SHOW_UI") {
        setSearchHidden(false);
        showAllFloraUI();
        reportActiveState(true);
        // Rows that loaded while the site was paused were left unprocessed, so
        // showing the UI again has nothing to show for them until a pass runs.
        const adapter = resolveSearchSite(location.hostname);
        if (adapter) {
            void processSearchResults(adapter, document).catch((err) =>
                debugError(`${adapter.label}: pass after unhide failed —`, err)
            );
        }
        sendResponse({ ok: true });
    } else if (type === "FLORA_GET_STATE") {
        sendResponse({ hidden: isSearchHidden() });
    }
});

// The pause control on the work toast writes the snooze (or block) to storage
// itself, then announces it here so this page clears immediately instead of
// waiting for a reload.
document.addEventListener("flora-pause-site", () => {
    setSearchHidden(true);
    hideAllFloraUI();
    reportActiveState(false);
});
