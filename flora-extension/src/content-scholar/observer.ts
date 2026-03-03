import { normaliseDOI } from "../shared/doi-normalise";
import type { DoiString } from "../shared/types";
import type { LookupRequest, LookupResponse } from "../shared/messages";
import { renderScholarBadge } from "./badge";

const RESULT_CONTAINER = "#gs_res_ccl";
const RESULT_ROW = ".gs_r.gs_or.gs_scl";
const PROCESSED_ATTR = "data-flora-processed";

export function observeScholarResults(): void {
  const container = document.querySelector(RESULT_CONTAINER);
  if (!container) return;

  const observer = new MutationObserver((mutations) => {
    let hasNewRows = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (
          node instanceof HTMLElement &&
          (node.matches(RESULT_ROW) || node.querySelector(RESULT_ROW))
        ) {
          hasNewRows = true;
          break;
        }
      }
      if (hasNewRows) break;
    }

    if (hasNewRows) {
      processScholarResults(document);
    }
  });

  observer.observe(container, { childList: true, subtree: true });
}

export async function processScholarResults(doc: Document): Promise<void> {
  const rows = doc.querySelectorAll<HTMLElement>(
    `${RESULT_ROW}:not([${PROCESSED_ATTR}])`
  );
  if (rows.length === 0) return;

  const rowDois: { row: HTMLElement; doi: DoiString }[] = [];

  for (const row of rows) {
    row.setAttribute(PROCESSED_ATTR, "true");
    const doi = extractDoiFromScholarRow(row);
    if (doi) {
      rowDois.push({ row, doi });
    }
  }

  if (rowDois.length === 0) return;

  const uniqueDois = [...new Set(rowDois.map((rd) => rd.doi))];
  const request: LookupRequest = { type: "FLORA_LOOKUP", dois: uniqueDois };

  try {
    const response: LookupResponse =
      await chrome.runtime.sendMessage(request);

    for (const { row, doi } of rowDois) {
      if (response.results[doi]) {
        renderScholarBadge(row, {
          status: "matched",
          result: response.results[doi],
        });
      }
    }
  } catch {
    // Silently fail — don't break Scholar
  }
}

function extractDoiFromScholarRow(row: HTMLElement): DoiString | null {
  // 1. Title link href
  const titleLink = row.querySelector<HTMLAnchorElement>(".gs_rt a");
  if (titleLink?.href) {
    const doi = normaliseDOI(titleLink.href);
    if (doi) return doi;
  }

  // 2. Author/source line text
  const authorLine = row.querySelector(".gs_a");
  if (authorLine?.textContent) {
    const match = authorLine.textContent.match(
      /\b(10\.\d{4,}(?:\.\d+)*\/\S+)\b/
    );
    if (match) {
      const doi = normaliseDOI(match[1]);
      if (doi) return doi;
    }
  }

  // 3. Any link containing doi.org
  const links = row.querySelectorAll<HTMLAnchorElement>("a[href]");
  for (const link of links) {
    if (link.href.includes("doi.org/")) {
      const doi = normaliseDOI(link.href);
      if (doi) return doi;
    }
  }

  return null;
}
