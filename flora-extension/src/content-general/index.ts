import { extractDOIs } from "../shared/doi-extractor";
import { augmentDOIs } from "../shared/doi-augment";
import { debounce } from "../shared/debounce";
import type { DoiString, LookupState } from "../shared/types";
import type { LookupRequest, LookupResponse } from "../shared/messages";
import { renderErrorBanner, renderMatchedBanner, removeBanner, renderInlineBadges } from "./injector";

const LOG_PREFIX = "[FLoRA]";

/**
 * DEBUG: Highlight any text on the page that contains an extracted DOI.
 * Walks text nodes and wraps DOI matches with a bright background span.
 */
function highlightDoisOnPage(dois: string[]): void {
  if (dois.length === 0) return;

  // Build a regex matching any of the DOIs
  const escaped = dois.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(${escaped.join("|")})`, "gi");

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodesToReplace: { node: Text; html: string }[] = [];

  let textNode: Text | null;
  while ((textNode = walker.nextNode() as Text | null)) {
    if (!textNode.nodeValue || !pattern.test(textNode.nodeValue)) continue;
    pattern.lastIndex = 0; // reset after .test()
    const parent = textNode.parentElement;
    if (!parent || parent.tagName === "SCRIPT" || parent.tagName === "STYLE") continue;

    const html = textNode.nodeValue.replace(
      pattern,
      `<span style="background:#ffeb3b;outline:2px solid #f57f17;border-radius:2px;padding:0 2px" title="FLoRA DOI">$1</span>`
    );
    nodesToReplace.push({ node: textNode, html });
  }

  for (const { node, html } of nodesToReplace) {
    const wrapper = document.createElement("span");
    wrapper.innerHTML = html;
    node.parentNode?.replaceChild(wrapper, node);
  }

  console.log(`${LOG_PREFIX} DEBUG: Highlighted ${nodesToReplace.length} text occurrence(s) of ${dois.length} DOI(s)`);
}

const pageState = new Map<DoiString, LookupState>();
const processedDois = new Set<DoiString>();
let lastUrl = location.href;

async function run(): Promise<void> {
  console.log(`${LOG_PREFIX} Running on ${location.href}`);

  // Detect full URL change (SPA navigation) — clear state
  const currentUrl = location.href;
  if (currentUrl !== lastUrl) {
    console.log(`${LOG_PREFIX} URL changed: ${lastUrl} → ${currentUrl}`);
    lastUrl = currentUrl;
    processedDois.clear();
    pageState.clear();
    removeBanner();
  }

  let dois = extractDOIs(document);

  // If no DOIs found directly, try augmenting from page title
  if (dois.length === 0) {
    const pageTitle =
      document.querySelector<HTMLHeadingElement>("h1")?.textContent?.trim() ||
      document.title?.trim();

    if (pageTitle) {
      console.log(`${LOG_PREFIX} No DOIs extracted, augmenting from title: "${pageTitle}"`);
      try {
        const augmented = await augmentDOIs([pageTitle]);
        const resolvedDoi = augmented.get(pageTitle);
        if (resolvedDoi) {
          console.log(`${LOG_PREFIX} Title augmented to DOI: ${resolvedDoi}`);
          dois = [resolvedDoi];
        } else {
          console.log(`${LOG_PREFIX} Title augmentation found no DOI`);
        }
      } catch (err) {
        console.warn(`${LOG_PREFIX} Augmentation failed:`, err);
      }
    } else {
      console.log(`${LOG_PREFIX} No DOIs found and no page title available`);
    }
  }

  // Filter out already-processed DOIs
  const newDois = dois.filter((doi) => !processedDois.has(doi));
  if (newDois.length === 0) {
    console.log(`${LOG_PREFIX} No new DOIs to process (${processedDois.size} already processed)`);
    return;
  }

  console.log(`${LOG_PREFIX} Processing ${newDois.length} new DOI(s):`, newDois);

  // DEBUG: highlight extracted DOIs on the page
  highlightDoisOnPage(newDois);

  for (const doi of newDois) {
    processedDois.add(doi);
  }

  // Mark all as loading
  for (const doi of newDois) {
    pageState.set(doi, { status: "loading" });
  }

  const request: LookupRequest = { type: "FLORA_LOOKUP", dois: newDois };

  try {
    const response: LookupResponse =
      await chrome.runtime.sendMessage(request);

    for (const doi of newDois) {
      if (response.errors[doi]) {
        pageState.set(doi, { status: "error", message: response.errors[doi] });
        console.warn(`${LOG_PREFIX} Lookup error for ${doi}: ${response.errors[doi]}`);
      } else if (response.results[doi]) {
        pageState.set(doi, { status: "matched", result: response.results[doi] });
        console.log(`${LOG_PREFIX} MATCH: ${doi} has replication data`);
      } else {
        pageState.set(doi, { status: "no-match" });
        console.log(`${LOG_PREFIX} No replication data for ${doi}`);
      }
    }

    // Collect all matched DOIs for the banner (including previously found)
    const allDois = [...pageState.keys()];
    const matched = allDois
      .filter((doi) => pageState.get(doi)?.status === "matched")
      .map((doi) => ({
        doi,
        result: (pageState.get(doi) as { status: "matched"; result: import("../shared/types").ReplicationResult }).result,
      }));

    if (matched.length > 0) {
      console.log(`${LOG_PREFIX} Rendering banner for ${matched.length} matched DOI(s)`);
      renderMatchedBanner(matched);
    } else {
      removeBanner();
    }

    // Inline badges for all matched DOIs
    renderInlineBadges(pageState);
  } catch (err) {
    console.error(`${LOG_PREFIX} FLoRA lookup failed:`, err);
    renderErrorBanner("Failed to contact FLoRA service");
  }
}

const debouncedRun = debounce(run, 1000);
debouncedRun();

// SPA pagination detection: watch for significant DOM changes
const MIN_ADDED_NODES = 3;
const debouncedReRun = debounce(run, 2000);

if (document.body) {
  const observer = new MutationObserver((mutations) => {
    let addedCount = 0;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          addedCount++;
        }
      }
    }
    if (addedCount >= MIN_ADDED_NODES) {
      console.log(`${LOG_PREFIX} DOM mutation detected (${addedCount} elements added), re-running`);
      debouncedReRun();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// SPA URL-based navigation
window.addEventListener("popstate", () => {
  console.log(`${LOG_PREFIX} popstate event, re-running`);
  debouncedReRun();
});
window.addEventListener("hashchange", () => {
  console.log(`${LOG_PREFIX} hashchange event, re-running`);
  debouncedReRun();
});
