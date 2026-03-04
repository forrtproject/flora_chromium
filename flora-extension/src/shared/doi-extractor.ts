import type { DoiString } from "./types";
import { normaliseDOI } from "./doi-normalise";

// Allow parens inside DOIs (e.g. 10.1016/S0924-9338(98)80023-0)
// but stop at whitespace, commas, quotes, fragments, query strings, etc.
const DOI_REGEX = /(10\.\d{4,}(?:\.\d+)*\/[^\s,;\]}>'"<#?&]+)/g;

const LOG_PREFIX = "[FLoRA:extractor]";

function cleanDoiTrailing(raw: string): string {
  // Strip trailing punctuation
  let cleaned = raw.replace(/[.,;:]+$/, "");
  // Strip unbalanced trailing parentheses:
  // If there are more ')' than '(' the extras are sentence punctuation, not part of the DOI
  let opens = 0;
  let lastBalanced = cleaned.length;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === "(") opens++;
    else if (cleaned[i] === ")") {
      if (opens > 0) {
        opens--;
      } else {
        // Unbalanced ')' — DOI ends before this
        lastBalanced = i;
        break;
      }
    }
  }
  cleaned = cleaned.slice(0, lastBalanced);
  // Strip trailing punctuation again after paren trimming
  cleaned = cleaned.replace(/[.,;:]+$/, "");
  // Strip supplementary file paths (e.g. /suppl_file/..., /asset/..., /full, /abstract)
  cleaned = cleaned.replace(/\/(?:suppl_file|asset|supplementary|full|abstract|summary|pdf|epub)\/.*$/i, "");
  return cleaned;
}

/**
 * Extract DOIs from a document using a multi-layer approach:
 * 1. Page URL (catches DOIs in journal URLs like sagepub.com/doi/abs/10.xxx)
 * 2. <meta> tags (citation_doi, DC.identifier, etc.)
 * 3. JSON-LD structured data
 * 4. Regex over visible text and links
 * 5. Regex over raw HTML (catches DOIs in data attributes, table cells, hidden elements)
 */
export function extractDOIs(doc: Document): DoiString[] {
  const found = new Set<DoiString>();

  const before = found.size;
  extractFromUrl(doc, found);
  if (found.size > before)
    console.log(`${LOG_PREFIX} URL layer found ${found.size - before} DOI(s):`, [...found]);

  const beforeMeta = found.size;
  extractFromMeta(doc, found);
  if (found.size > beforeMeta)
    console.log(`${LOG_PREFIX} Meta tag layer found ${found.size - beforeMeta} new DOI(s)`);

  const beforeJsonLd = found.size;
  extractFromJsonLd(doc, found);
  if (found.size > beforeJsonLd)
    console.log(`${LOG_PREFIX} JSON-LD layer found ${found.size - beforeJsonLd} new DOI(s)`);

  const beforeRegex = found.size;
  extractFromRegex(doc, found);
  if (found.size > beforeRegex)
    console.log(`${LOG_PREFIX} Regex layer found ${found.size - beforeRegex} new DOI(s)`);

  const beforeHtml = found.size;
  extractFromRawHtml(doc, found);
  if (found.size > beforeHtml)
    console.log(`${LOG_PREFIX} Raw HTML layer found ${found.size - beforeHtml} new DOI(s)`);

  const result = [...found];
  if (result.length > 0) {
    console.log(`${LOG_PREFIX} Total DOIs extracted: ${result.length}`, result);
  } else {
    console.log(`${LOG_PREFIX} No DOIs found on page`);
  }

  return result;
}

function extractFromUrl(doc: Document, found: Set<DoiString>): void {
  const url = doc.location?.href ?? "";
  const matches = url.matchAll(DOI_REGEX);
  for (const match of matches) {
    const doi = normaliseDOI(cleanDoiTrailing(match[1]));
    if (doi) found.add(doi);
  }
}

function extractFromMeta(doc: Document, found: Set<DoiString>): void {
  const selectors = [
    'meta[name="citation_doi"]',
    'meta[name="DC.identifier"]',
    'meta[name="dc.identifier"]',
    'meta[name="DOI"]',
    'meta[property="citation_doi"]',
  ];

  for (const selector of selectors) {
    const el = doc.querySelector<HTMLMetaElement>(selector);
    if (el?.content) {
      const doi = normaliseDOI(el.content);
      if (doi) found.add(doi);
    }
  }
}

function extractFromJsonLd(doc: Document, found: Set<DoiString>): void {
  const scripts = doc.querySelectorAll<HTMLScriptElement>(
    'script[type="application/ld+json"]'
  );

  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent ?? "");
      const items = Array.isArray(data) ? data : [data];

      for (const item of items) {
        if (typeof item?.["@id"] === "string") {
          const doi = normaliseDOI(item["@id"]);
          if (doi) found.add(doi);
        }
        if (typeof item?.doi === "string") {
          const doi = normaliseDOI(item.doi);
          if (doi) found.add(doi);
        }
      }
    } catch {
      // Invalid JSON-LD, skip
    }
  }
}

function extractFromRegex(doc: Document, found: Set<DoiString>): void {
  // Search links first
  const links = doc.querySelectorAll<HTMLAnchorElement>("a[href]");
  for (const link of links) {
    const matches = link.href.matchAll(DOI_REGEX);
    for (const match of matches) {
      const doi = normaliseDOI(cleanDoiTrailing(match[1]));
      if (doi) found.add(doi);
    }
  }

  // Then visible body text
  const bodyText = doc.body?.innerText || doc.body?.textContent || "";
  const matches = bodyText.matchAll(DOI_REGEX);
  for (const match of matches) {
    const doi = normaliseDOI(cleanDoiTrailing(match[1]));
    if (doi) found.add(doi);
  }
}

function extractFromRawHtml(doc: Document, found: Set<DoiString>): void {
  const html = doc.body?.innerHTML ?? "";
  const matches = html.matchAll(DOI_REGEX);
  for (const match of matches) {
    const doi = normaliseDOI(cleanDoiTrailing(match[1]));
    if (doi) found.add(doi);
  }
}
