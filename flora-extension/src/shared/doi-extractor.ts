import type { DoiString } from "./types";
import { normaliseDOI } from "./doi-normalise";

const DOI_REGEX = /\b(10\.\d{4,}(?:\.\d+)*\/\S+)\b/g;

/**
 * Extract DOIs from a document using a multi-layer approach:
 * 1. <meta> tags (citation_doi, DC.identifier, etc.)
 * 2. JSON-LD structured data
 * 3. Regex over visible text and links
 */
export function extractDOIs(doc: Document): DoiString[] {
  const found = new Set<DoiString>();

  extractFromMeta(doc, found);
  extractFromJsonLd(doc, found);
  extractFromRegex(doc, found);

  return [...found];
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
      const doi = normaliseDOI(match[1]);
      if (doi) found.add(doi);
    }
  }

  // Then visible body text
  const bodyText = doc.body?.innerText || doc.body?.textContent || "";
  const matches = bodyText.matchAll(DOI_REGEX);
  for (const match of matches) {
    const doi = normaliseDOI(match[1]);
    if (doi) found.add(doi);
  }
}
