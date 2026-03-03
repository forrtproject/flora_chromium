import { extractDOIs } from "../shared/doi-extractor";
import { debounce } from "../shared/debounce";
import type { DoiString, LookupState } from "../shared/types";
import type { LookupRequest, LookupResponse } from "../shared/messages";
import { renderBanner, removeBanner, renderInlineBadges } from "./injector";

const pageState = new Map<DoiString, LookupState>();

async function run(): Promise<void> {
  const dois = extractDOIs(document);
  if (dois.length === 0) return;

  const primaryDoi = dois[0];

  // Mark all as loading
  for (const doi of dois) {
    pageState.set(doi, { status: "loading" });
  }
  renderBanner(primaryDoi, { status: "loading" });

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

    // Update banner for primary DOI
    const primaryState = pageState.get(primaryDoi)!;
    if (primaryState.status === "no-match") {
      removeBanner();
    } else {
      renderBanner(primaryDoi, primaryState);
    }

    // Inline badges for all matched DOIs
    renderInlineBadges(pageState);
  } catch {
    pageState.set(primaryDoi, {
      status: "error",
      message: "Failed to contact FLoRA service",
    });
    renderBanner(primaryDoi, pageState.get(primaryDoi)!);
  }
}

const debouncedRun = debounce(run, 300);
debouncedRun();
