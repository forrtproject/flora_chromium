import { normaliseDOI } from "../shared/doi-normalise";
import { augmentDOIs } from "../shared/doi-augment";
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
  if (rows.length === 0) {
    console.log("[FLoRA] No unprocessed Scholar rows found");
    return;
  }

  console.log(`[FLoRA] Processing ${rows.length} Scholar rows`);

  const rowDois: { row: HTMLElement; doi: DoiString }[] = [];
  const rowsWithoutDoi: { row: HTMLElement; title: string }[] = [];

  for (const row of rows) {
    row.setAttribute(PROCESSED_ATTR, "true");
    const doi = extractDoiFromScholarRow(row);
    if (doi) {
      rowDois.push({ row, doi });
      injectDebugLabel(row, `DOI: ${doi}`, "#2e7d32");
    } else {
      // No DOI found directly — extract title for OpenAlex augmentation
      const titleEl = row.querySelector(".gs_rt");
      const title = titleEl?.textContent?.trim();
      if (title) {
        rowsWithoutDoi.push({ row, title });
        injectDebugLabel(row, "no DOI — resolving…", "#e65100");
      } else {
        injectDebugLabel(row, "no DOI, no title", "#b71c1c");
      }
    }
  }

  // Augment missing DOIs via OpenAlex
  if (rowsWithoutDoi.length > 0) {
    try {
      const titles = rowsWithoutDoi.map((r) => r.title);
      const augmented = await augmentDOIs(titles);

      for (const { row, title } of rowsWithoutDoi) {
        const doi = augmented.get(title);
        if (doi) {
          rowDois.push({ row, doi });
          updateDebugLabel(row, `DOI (resolved): ${doi}`, "#1565c0");
        } else {
          updateDebugLabel(row, "no DOI found", "#b71c1c");
        }
      }
    } catch {
      // Augmentation failed — continue with what we have
    }
  }

  console.log(`[FLoRA] DOIs found: ${rowDois.length}, titles without DOI: ${rowsWithoutDoi.length}`);

  if (rowDois.length === 0) return;

  const uniqueDois = [...new Set(rowDois.map((rd) => rd.doi))];
  console.log("[FLoRA] Looking up DOIs:", uniqueDois);
  const request: LookupRequest = { type: "FLORA_LOOKUP", dois: uniqueDois };

  try {
    const response: LookupResponse =
      await chrome.runtime.sendMessage(request);

    console.log("[FLoRA] Lookup response:", response);

    for (const { row, doi } of rowDois) {
      if (response.results[doi]) {
        renderScholarBadge(row, {
          status: "matched",
          result: response.results[doi],
        });
        appendDebugLabel(row, "FLoRA: MATCH ✓", "#2e7d32");
      } else if (response.errors[doi]) {
        appendDebugLabel(row, `FLoRA: error — ${response.errors[doi]}`, "#b71c1c");
      } else {
        appendDebugLabel(row, "FLoRA: no replication data", "#757575");
      }
    }
  } catch (err) {
    console.error("[FLoRA] Lookup failed:", err);
    for (const { row } of rowDois) {
      appendDebugLabel(row, "FLoRA: lookup failed", "#b71c1c");
    }
  }
}

const DEBUG_LABEL_CLASS = "flora-debug-label";

function injectDebugLabel(row: HTMLElement, text: string, color: string): void {
  const titleEl = row.querySelector(".gs_rt");
  if (!titleEl) return;

  const label = document.createElement("span");
  label.className = DEBUG_LABEL_CLASS;
  label.textContent = `[FLoRA] ${text}`;
  label.style.cssText = `
    display: inline-block;
    font-size: 11px;
    font-family: monospace;
    color: white;
    background: ${color};
    padding: 1px 6px;
    border-radius: 3px;
    margin-left: 6px;
    vertical-align: middle;
  `;
  titleEl.appendChild(label);
}

function appendDebugLabel(row: HTMLElement, text: string, color: string): void {
  const titleEl = row.querySelector(".gs_rt");
  if (!titleEl) return;

  const label = document.createElement("span");
  label.className = "flora-debug-flora-status";
  label.textContent = `[${text}]`;
  label.style.cssText = `
    display: inline-block;
    font-size: 11px;
    font-family: monospace;
    color: white;
    background: ${color};
    padding: 1px 6px;
    border-radius: 3px;
    margin-left: 4px;
    vertical-align: middle;
  `;
  titleEl.appendChild(label);
}

function updateDebugLabel(row: HTMLElement, text: string, color: string): void {
  const existing = row.querySelector(`.${DEBUG_LABEL_CLASS}`);
  if (existing) {
    existing.textContent = `[FLoRA] ${text}`;
    (existing as HTMLElement).style.background = color;
  } else {
    injectDebugLabel(row, text, color);
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
