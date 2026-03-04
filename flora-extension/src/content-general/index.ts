import { extractDOIs } from "../shared/doi-extractor";
import { augmentDOIs } from "../shared/doi-augment";
import { debounce } from "../shared/debounce";
import type { DoiString, LookupState } from "../shared/types";
import type { LookupRequest, LookupResponse } from "../shared/messages";
import { renderLoadingBanner, renderErrorBanner, renderMatchedBanner, removeBanner, renderInlineBadges } from "./injector";

const pageState = new Map<DoiString, LookupState>();

async function run(): Promise<void> {
  let dois = extractDOIs(document);

  // If no DOIs found directly, try augmenting from page title
  if (dois.length === 0) {
    const pageTitle =
      document.querySelector<HTMLHeadingElement>("h1")?.textContent?.trim() ||
      document.title?.trim();

    if (pageTitle) {
      try {
        const augmented = await augmentDOIs([pageTitle]);
        const resolvedDoi = augmented.get(pageTitle);
        if (resolvedDoi) {
          dois = [resolvedDoi];
        }
      } catch {
        // Augmentation failed — nothing to show
      }
    }
  }

  if (dois.length === 0) return;

  const primaryDoi = dois[0];

  // Mark all as loading
  for (const doi of dois) {
    pageState.set(doi, { status: "loading" });
  }
  renderLoadingBanner();

  const request: LookupRequest = { type: "FLORA_LOOKUP", dois };

  try {
    const response: LookupResponse =
      await chrome.runtime.sendMessage(request);

    for (const doi of dois) {
      if (response.errors[doi]) {
        pageState.set(doi, { status: "error", message: response.errors[doi] });
      } else if (response.results[doi]) {
        pageState.set(doi, { status: "matched", result: response.results[doi] });
      } else {
        pageState.set(doi, { status: "no-match" });
      }
    }

    // Collect all matched DOIs for the banner
    const matched = dois
      .filter((doi) => pageState.get(doi)?.status === "matched")
      .map((doi) => ({
        doi,
        result: (pageState.get(doi) as { status: "matched"; result: import("../shared/types").ReplicationResult }).result,
      }));

    if (matched.length > 0) {
      renderMatchedBanner(matched);
    } else {
      removeBanner();
    }

    // Inline badges for all matched DOIs
    renderInlineBadges(pageState);
  } catch {
    renderErrorBanner("Failed to contact FLoRA service");
  }
}

const debouncedRun = debounce(run, 300);
debouncedRun();
