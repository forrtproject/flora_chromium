import type { DoiString, ClassifiedDois, PageType } from "./types";
import { normaliseDOI } from "./doi-normalise";
import { debugLog } from "./debug";
import { FLORA_UI_SELECTOR } from "./flora-ui";

// DOI suffixes may contain parens, semicolons, and slashes (e.g. SICI DOIs),
// but a trailing slash followed by a bare word (e.g. /full, /abstract) is
// journal URL routing, not part of the DOI.
const SUFFIX_CHARS = `[^\\s,/\\]}>'"<#?&\\\\]`;
const EXTRA_SLASH = `(?:\\/(?![a-zA-Z-]+(?:[/\\s,#?&<>{}\\[\\]]|$))${SUFFIX_CHARS}+)*`;
const DOI_REGEX = new RegExp(`(10\\.\\d{4,}(?:\\.\\d+)*\\/${SUFFIX_CHARS}+${EXTRA_SLASH})`, "g");

// innerText renders &lt;/&gt; as literal < >, which SICI DOIs use — allow them
// here so e.g. 10.1002/(SICI)...18:4<303::AID-SMJ869>3.0.CO;2-G isn't truncated.
const TEXT_SUFFIX_CHARS = `[^\\s,/\\]'"#?&\\\\]`;
const TEXT_EXTRA_SLASH = `(?:\\/(?![a-zA-Z-]+(?:[/\\s,#?&<>{}\\[\\]]|$))${TEXT_SUFFIX_CHARS}+)*`;
export const DOI_TEXT_REGEX = new RegExp(`(10\\.\\d{4,}(?:\\.\\d+)*\\/${TEXT_SUFFIX_CHARS}+${TEXT_EXTRA_SLASH})`, "g");

// Zero-width chars sites insert inside DOIs for line-wrapping — stripped so a
// wrapped DOI rejoins. U+FEFF stays: JAMA uses it as a separator *after* a
// DOI (no real whitespace), and stripping it would glue the DOI to "PubMed".
const WORD_BREAK_CHARS = /[\u200B\u200C\u200D\u00AD\u2060]/g;

const ENCODED_DOI_REGEX = /(10\.\d{4,}(?:\.\d+)*%2[fF][^\s,/\]}>'"<#?&\\]+)/g;

function decodeEncodedDois(text: string): string {
  return text.replace(ENCODED_DOI_REGEX, (match) => {
    try {
      return decodeURIComponent(match);
    } catch {
      return match;
    }
  });
}

// Real DOI suffixes are almost never 1 char — "10.1016/j" is HTML splitting
// a DOI across elements, not a real DOI.
function isValidDoiSuffix(doi: string): boolean {
  const slashIdx = doi.indexOf("/");
  if (slashIdx === -1) return false;
  const suffix = doi.slice(slashIdx + 1);
  return suffix.length >= 2;
}

function cleanDoiTrailing(raw: string): string {
  let cleaned = raw.replace(/[.,;:]+$/, "");
  // An unbalanced trailing ')' is sentence punctuation, not part of the DOI.
  let opens = 0;
  let lastBalanced = cleaned.length;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === "(") opens++;
    else if (cleaned[i] === ")") {
      if (opens > 0) {
        opens--;
      } else {
        lastBalanced = i;
        break;
      }
    }
  }
  cleaned = cleaned.slice(0, lastBalanced);
  cleaned = cleaned.replace(/[.,;:]+$/, "");
  let prev: string;
  do {
    prev = cleaned;
    cleaned = cleaned.replace(/\([^()]*\)$/, "").replace(/[.,;:]+$/, "");
  } while (cleaned !== prev);
  return cleaned;
}

const CITED_DOI_PARAMS = new Set(["refdoi", "doioflink"]);

// Reference-list links are often publisher landing pages, not doi.org, so the
// DOI has to be dug out of a query param or the URL path.
export function extractDoiFromHref(href: string): DoiString | null {
  if (!href) return null;

  const direct = normaliseDOI(href);
  if (direct) return direct;

  try {
    const url = new URL(href);
    const params = url.searchParams;
    for (const key of params.keys()) {
      if (CITED_DOI_PARAMS.has(key.toLowerCase())) {
        const fromCitedParam = normaliseDOI(params.get(key) ?? "");
        if (fromCitedParam) return fromCitedParam;
      }
    }
    for (const key of params.keys()) {
      if (key.toLowerCase() === "doi") {
        const fromParam = normaliseDOI(params.get(key) ?? "");
        if (fromParam) return fromParam;
      }
    }
    const idName = (params.get("identifierName") ?? params.get("identifier_name") ?? "").toLowerCase();
    if (idName === "doi") {
      const val = params.get("identifierValue") ?? params.get("identifier_value") ?? "";
      const fromIdParam = normaliseDOI(val);
      if (fromIdParam) return fromIdParam;
    }
  } catch {
    // invalid URL — fall through to path-embedded match
  }

  try {
    const decoded = decodeURIComponent(href);
    const m = decoded.match(/\b(10\.\d{4,}(?:\.\d+)*\/[^\s&"'#?]+)/);
    if (m) {
      const cleaned = cleanDoiTrailing(m[1]);
      if (isValidDoiSuffix(cleaned)) {
        const fromPath = normaliseDOI(cleaned);
        if (fromPath) return fromPath;
      }
    }
  } catch {
    // invalid percent-encoding — give up
  }

  return null;
}

export function extractDOIs(doc: Document): DoiString[] {
  const found = new Set<DoiString>();

  const sizeBefore = (layer: string) => {
    const s = found.size;
    return () => {
      if (found.size > s) debugLog(`Extractor: ${layer} added ${found.size - s} DOI(s)`);
    };
  };

  let after = sizeBefore("URL");
  extractFromUrl(doc, found);
  after();

  after = sizeBefore("meta");
  extractFromMeta(doc, found);
  after();

  after = sizeBefore("JSON-LD");
  extractFromJsonLd(doc, found);
  after();

  after = sizeBefore("DOI links");
  extractFromDoiLinks(doc, found);
  after();

  after = sizeBefore("visible text");
  extractFromVisibleText(doc, found);
  after();

  // Google Sheets renders cells on canvas — text lives only in innerHTML.
  if (isGoogleSheets(doc) && doc.body) {
    after = sizeBefore("Sheets innerHTML");
    const html = doc.body.innerHTML;
    const cleaned = decodeEncodedDois(html.replace(WORD_BREAK_CHARS, ""));
    for (const match of cleaned.matchAll(DOI_REGEX)) {
      const raw = cleanDoiTrailing(match[1]);
      if (!isValidDoiSuffix(raw)) continue;
      const doi = normaliseDOI(raw);
      if (doi) found.add(doi);
    }
    after();
  }

  const result = [...found];
  debugLog(`Extractor: ${result.length} unique DOI(s) found`, result);
  return result;
}

function withoutNestedUrls(href: string): string {
  try {
    const url = new URL(href);
    const kept = new URLSearchParams();
    for (const [key, value] of url.searchParams) {
      if (/^https?:\/\//i.test(value)) continue;
      kept.append(key, value);
    }
    const query = kept.toString();
    return `${url.origin}${url.pathname}${query ? `?${query}` : ""}${url.hash}`;
  } catch {
    return href;
  }
}

function extractFromUrl(doc: Document, found: Set<DoiString>): void {
  const url = decodeEncodedDois(withoutNestedUrls(doc.location?.href ?? ""));
  const matches = url.matchAll(DOI_REGEX);
  for (const match of matches) {
    const cleaned = cleanDoiTrailing(match[1]);
    if (!isValidDoiSuffix(cleaned)) continue;
    const doi = normaliseDOI(cleaned);
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
      // invalid JSON-LD
    }
  }
}

function extractFromDoiLinks(doc: Document, found: Set<DoiString>): void {
  const links = doc.querySelectorAll<HTMLAnchorElement>("a[href]");
  for (const link of links) {
    const href = link.href;
    if (!href) continue;
    const doi = normaliseDOI(href);
    if (doi) found.add(doi);
  }
}

/** Where a DOI was found on the page — drives where UI is anchored. */
export type DoiOccurrenceKind =
  | "link-text"
  | "link-doi-org"
  | "link-embedded"
  | "text";

export interface DoiOccurrence {
  doi: DoiString;
  source: HTMLElement;
  /** UI anchor: the containing reference entry when there is one, else `source`. */
  anchor: HTMLElement;
  kind: DoiOccurrenceKind;
}

export function extractDoiOccurrences(doc: Document): DoiOccurrence[] {
  const occurrences: DoiOccurrence[] = [];
  if (!doc.body || !pageMightContainDoi(doc)) return occurrences;

  // Anchor DOIs to their reference entry, not a per-link "Crossref" button.
  const entrySet = new Set<HTMLElement>(
    findReferenceEntries(doc).map((e) => e.element)
  );
  const pickAnchor = (el: HTMLElement): HTMLElement => {
    let cur: HTMLElement | null = el;
    while (cur) {
      if (entrySet.has(cur)) return cur;
      cur = cur.parentElement;
    }
    return el;
  };

  for (const link of doc.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (link.closest(FLORA_UI_SELECTOR)) continue;
    const textDois = new Set<DoiString>();
    const linkText = link.innerText || link.textContent || "";
    const cleaned = decodeEncodedDois(linkText.replace(WORD_BREAK_CHARS, ""));
    for (const match of cleaned.matchAll(DOI_TEXT_REGEX)) {
      const raw = cleanDoiTrailing(match[1]);
      if (!isValidDoiSuffix(raw)) continue;
      const doi = normaliseDOI(raw);
      if (doi) textDois.add(doi);
    }
    for (const doi of textDois) {
      occurrences.push({ doi, source: link, anchor: pickAnchor(link), kind: "link-text" });
    }

    const direct = normaliseDOI(link.href);
    if (direct && !textDois.has(direct)) {
      occurrences.push({ doi: direct, source: link, anchor: pickAnchor(link), kind: "link-doi-org" });
    } else if (!direct) {
      const embedded = extractDoiFromHref(link.href);
      if (embedded && !textDois.has(embedded)) {
        occurrences.push({ doi: embedded, source: link, anchor: pickAnchor(link), kind: "link-embedded" });
      }
    }
  }

  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
        return NodeFilter.FILTER_REJECT;
      }
      if (parent.closest("a")) return NodeFilter.FILTER_REJECT;
      if (parent.closest(FLORA_UI_SELECTOR)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const raw = (node as Text).data;
    if (!raw || raw.length < 12) continue;
    const parent = node.parentElement;
    if (!parent) continue;
    const cleaned = decodeEncodedDois(raw.replace(WORD_BREAK_CHARS, ""));
    const seen = new Set<DoiString>();
    for (const match of cleaned.matchAll(DOI_TEXT_REGEX)) {
      const trimmed = cleanDoiTrailing(match[1]);
      if (!isValidDoiSuffix(trimmed)) continue;
      const doi = normaliseDOI(trimmed);
      if (!doi || seen.has(doi)) continue;
      seen.add(doi);
      occurrences.push({ doi, source: parent, anchor: pickAnchor(parent), kind: "text" });
    }
  }

  return occurrences;
}

const DOI_PROBE_REGEX = /10\.\d{4,}/;

/** Cheap, over-inclusive test for whether a subtree could contain a DOI. */
export function containsDoiCandidate(el: Element): boolean {
  const text = el.textContent ?? "";
  if (text.length >= 12 && DOI_PROBE_REGEX.test(text)) return true;
  if (el.matches?.('a[href*="10."]')) return true;
  return el.querySelector?.('a[href*="10."]') !== null;
}

function extractFromVisibleText(doc: Document, found: Set<DoiString>): void {
  if (!pageMightContainDoi(doc)) return;
  const rawText = doc.body?.innerText || doc.body?.textContent || "";
  const bodyText = decodeEncodedDois(rawText.replace(WORD_BREAK_CHARS, ""));
  const matches = bodyText.matchAll(DOI_TEXT_REGEX);
  for (const match of matches) {
    const cleaned = cleanDoiTrailing(match[1]);
    if (!isValidDoiSuffix(cleaned)) continue;
    const doi = normaliseDOI(cleaned);
    if (doi) found.add(doi);
  }
}

// Authoritative sources only — body text/links would pick up cited DOIs.
let _primaryDoiCache: { epoch: number; doc: Document; result: DoiString | null } | null = null;

export function extractPrimaryDOI(doc: Document): DoiString | null {
  if (
    _primaryDoiCache &&
    _primaryDoiCache.epoch === _scanEpoch &&
    _primaryDoiCache.doc === doc
  ) {
    return _primaryDoiCache.result;
  }
  const found = new Set<DoiString>();
  extractFromUrl(doc, found);
  extractFromMeta(doc, found);
  extractFromJsonLd(doc, found);
  const result = found.size > 0 ? [...found][0] : null;
  _primaryDoiCache = { epoch: _scanEpoch, doc, result };
  return result;
}

export function extractDOIsFromText(text: string): DoiString[] {
  const found = new Set<DoiString>();
  const cleaned = decodeEncodedDois(text.replace(WORD_BREAK_CHARS, ""));
  for (const match of cleaned.matchAll(DOI_REGEX)) {
    const raw = cleanDoiTrailing(match[1]);
    if (!isValidDoiSuffix(raw)) continue;
    const doi = normaliseDOI(raw);
    if (doi) found.add(doi);
  }
  debugLog(`extractDOIsFromText: ${found.size} DOI(s) from ${text.length} chars`);
  return [...found];
}

// Plural/list forms only: singular `citation`/`reference` is also Wiley's
// whole-article-body class, and matching it would treat the entire article
// as one giant reference list. `rlist` is excluded too — it's Wiley's generic
// <ul> reset, used for nav/footer lists having nothing to do with citations.
const REFERENCE_SECTION_RE = /(?:^|[-_\s])(?:cites|citations|bibliograph(?:y|ies)|references|reflist|ref-list|works-cited|footnotes|cited-by)(?:$|[-_\s])/i;

// For publishers (e.g. techscience.com) with no reference-section class/id at
// all — just a plain "References" heading among the article's other headings.
const REFERENCE_HEADING_RE = /^(?:\d+\.?\s*)?(?:references|bibliography|works\s+cited|literature\s+cited)\s*:?$/i;

function isReferenceContainer(el: Element): boolean {
  const cls = typeof el.className === "string" ? el.className : "";
  if (cls && REFERENCE_SECTION_RE.test(cls)) return true;
  if (el.id && REFERENCE_SECTION_RE.test(el.id)) return true;
  return false;
}

/** True when `el` sits inside, is, or contains a reference section. */
export function touchesReferenceSection(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (isReferenceContainer(node)) return true;
  }
  for (const descendant of el.querySelectorAll("[class],[id]")) {
    if (isReferenceContainer(descendant)) return true;
  }
  return false;
}

// Per-pass memo: findReferenceContainers runs several times per handler pass
// and a full-document scan is expensive. beginDomScanPass() bumps the epoch.
let _scanEpoch = 0;
let _refContainerCache: { epoch: number; doc: Document; result: Element[] } | null = null;
let _doiProbeCache: { epoch: number; doc: Document; result: boolean } | null = null;

export function pageMightContainDoi(doc: Document): boolean {
  if (
    _doiProbeCache &&
    _doiProbeCache.epoch === _scanEpoch &&
    _doiProbeCache.doc === doc
  ) {
    return _doiProbeCache.result;
  }
  const result = !!doc.body && containsDoiCandidate(doc.body);
  _doiProbeCache = { epoch: _scanEpoch, doc, result };
  return result;
}

export function beginDomScanPass(): void {
  _scanEpoch++;
}

export function findReferenceContainers(doc: Document): Element[] {
  if (
    _refContainerCache &&
    _refContainerCache.epoch === _scanEpoch &&
    _refContainerCache.doc === doc
  ) {
    return _refContainerCache.result;
  }

  const matched: Element[] = [];
  for (const el of doc.querySelectorAll<Element>("[class],[id]")) {
    if (isReferenceContainer(el)) matched.push(el);
  }
  const result = matched.filter(
    (el) => !matched.some((other) => other !== el && other.contains(el))
  );

  _refContainerCache = { epoch: _scanEpoch, doc, result };
  return result;
}

export interface ReferenceEntry {
  element: HTMLElement;
  /** null when the entry needs DOI augmentation. */
  doi: DoiString | null;
  /** Canonical `PMC…` id, set only when the entry cites one and has no DOI. */
  pmcid: string | null;
  text: string;
}

// Trailing action-link labels publishers glue after a citation (Crossref |
// PubMed | Google Scholar | ...) — stripped so they don't pollute augmentation
// queries or the rendered panel.
const REFERENCE_BUTTON_LABEL_RE =
  /[\s|·•,]+(?:Cross\s?Ref|PubMed(?:\s+Central)?|Web\s+of\s+Science|Google\s+Scholar|ISI|Medline|Scopus|CAS|View\s+(?:Article|in\s+Article|on\s+Publisher\s+Site)|Full[\s-]?Text|PDF|Free\s+Article|Open\s+Access|Find\s+in\s+Worldcat|ChemPort|Bing(?:\s+Scholar)?|OpenURL|DOI|Direct\s+Link|ADS|ProQuest|Show\s+Abstract|Read\s+(?:Article|Abstract))\b[\s.,;|·•®™]*$/i;

const LINK_ANNOTATION_RE = /\(\s*Open(?:s)?\s+in\s+a\s+new\s+(?:window|tab)\s*\)/gi;

function cleanReferenceText(text: string): string {
  let cleaned = text.replace(LINK_ANNOTATION_RE, " ").replace(/[^\S\n]+/g, " ").trim();
  let prev: string;
  do {
    prev = cleaned;
    cleaned = cleaned.replace(REFERENCE_BUTTON_LABEL_RE, "").trim();
  } while (cleaned !== prev);
  return cleaned;
}

function extractDoiFromEntry(
  entry: HTMLElement,
  hostDoi: DoiString | null
): DoiString | null {
  // Text wins over links: an entry's links are often "View"/"Cite" buttons
  // pointing at the *host* article, not the cited paper — using them first
  // made every Wiley cited-by row resolve to the host's own DOI.
  const text = entry.innerText ?? entry.textContent ?? "";
  const cleaned = decodeEncodedDois(text.replace(WORD_BREAK_CHARS, ""));
  for (const match of cleaned.matchAll(DOI_TEXT_REGEX)) {
    const raw = cleanDoiTrailing(match[1]);
    if (!isValidDoiSuffix(raw)) continue;
    const doi = normaliseDOI(raw);
    if (doi) return doi;
  }
  for (const link of entry.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const doi = extractDoiFromHref(link.href);
    if (doi && doi !== hostDoi) return doi;
  }
  return null;
}

// Entries that cite a PubMed Central id and no DOI — either spelled out
// ("PMCID: PMC12638941") or only as the href of a "PubMed Central" link.
// Wikipedia's citation template and several publishers render the id as
// "PMC 3741663", so the separator has to be optional.
const PMCID_TEXT_REGEX = /\bPMC[:\s]{0,2}(\d{3,9})\b/i;
const PMCID_HREF_REGEX = /ncbi\.nlm\.nih\.gov\/(?:pmc\/)?articles\/PMC(\d{3,9})/i;

function extractPmcIdFromEntry(entry: HTMLElement, text: string): string | null {
  const inText = PMCID_TEXT_REGEX.exec(text);
  if (inText) return `PMC${inText[1]}`;
  for (const link of entry.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const inHref = PMCID_HREF_REGEX.exec(link.href);
    if (inHref) return `PMC${inHref[1]}`;
  }
  return null;
}

// Reference lists almost always render as a sibling group of one tag
// (<li>, <p>, or <div>); the biggest such group is the entry list. `owner`
// says which element a node belongs to — its parent for ordinary siblings,
// its table for rows, whose entries are split across <tbody> sections.
function findLargestGroup(
  container: Element,
  selector: string,
  owner: (node: HTMLElement) => Element | null = (node) => node.parentElement,
): HTMLElement[] {
  const byOwner = new Map<Element, HTMLElement[]>();
  for (const node of container.querySelectorAll<HTMLElement>(selector)) {
    const key = owner(node);
    if (!key) continue;
    const group = byOwner.get(key) ?? [];
    group.push(node);
    byOwner.set(key, group);
  }
  let best: HTMLElement[] = [];
  for (const group of byOwner.values()) {
    if (group.length > best.length) best = group;
  }
  return best;
}

function entriesFromContainer(container: Element): HTMLElement[] {
  // Outermost <li>s only: a reference <li> can wrap its own nested action-link
  // <li>s (e.g. Frontiers' "Pubmed | CrossRef | ..."), which must not be
  // mistaken for separate entries.
  const allLis = Array.from(container.querySelectorAll<HTMLElement>("li"));
  const lis = allLis.filter(
    (li) => !allLis.some((other) => other !== li && other.contains(li))
  );
  const pGroup = findLargestGroup(container, "p");
  const divGroup = findLargestGroup(container, "div");
  // A tabular bibliography: one citation per body row. Without this the only
  // children of the <table> are <thead>/<tbody>, so the whole table counts as
  // a single entry — one DOI gets a pill and every later row is skipped.
  // Rows group by their own table, so a table split across several <tbody>
  // sections keeps all its entries and a nested table stays separate.
  const rowGroup = findLargestGroup(container, "tbody > tr, table > tr", (row) =>
    row.closest("table")
  );

  // Largest group wins, not just the first past the threshold: Oxford
  // Academic's per-reference <div> group otherwise loses to a single
  // reference's own 2-3 <p> link buttons.
  const best = [lis, pGroup, divGroup, rowGroup].reduce((a, b) => (b.length > a.length ? b : a));
  if (best.length >= 2) return best;

  let scope: Element = container;
  while (
    scope.children.length === 1 &&
    scope.firstElementChild &&
    /^(div|section|article)$/i.test(scope.firstElementChild.tagName)
  ) {
    scope = scope.firstElementChild;
  }
  const result: HTMLElement[] = [];
  for (const child of scope.children) {
    if (child instanceof HTMLElement && (child.textContent ?? "").trim().length > 0) {
      result.push(child);
    }
  }
  return result;
}

function collectSiblingsUntilHeading(heading: HTMLElement): HTMLElement[] {
  const siblings: HTMLElement[] = [];
  for (
    let node = heading.nextElementSibling as HTMLElement | null;
    node;
    node = node.nextElementSibling as HTMLElement | null
  ) {
    if (/^H[1-6]$/.test(node.tagName)) break;
    if ((node.textContent ?? "").trim().length > 0) {
      siblings.push(node);
    }
  }
  return siblings;
}

// Some SPA templates (researchsquare.com) render every section as an
// accordion with identical utility classes; the content panel is a cousin of
// the heading, not a sibling. Walk up looking for that cousin.
const MIN_ACCORDION_PANEL_TEXT = 100;
const MAX_ACCORDION_ANCESTOR_HOPS = 8;
function findAccordionPanel(heading: HTMLElement): Element | null {
  let node: Element | null = heading;
  for (let hop = 0; hop < MAX_ACCORDION_ANCESTOR_HOPS && node; hop++) {
    const sibling = node.nextElementSibling;
    if (sibling && (sibling.textContent ?? "").trim().length >= MIN_ACCORDION_PANEL_TEXT) {
      return sibling;
    }
    node = node.parentElement;
  }
  return null;
}

// Last resort, only when findReferenceContainers finds nothing: locate a
// "References" heading and use its siblings, or (accordion layouts) an
// ancestor's content-bearing cousin.
function findHeadingReferenceSiblings(doc: Document): HTMLElement[] {
  const headings = doc.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6");
  for (const heading of headings) {
    const text = (heading.textContent ?? "").trim();
    if (!REFERENCE_HEADING_RE.test(text)) continue;

    const siblings = collectSiblingsUntilHeading(heading);
    if (siblings.length >= 2) return siblings;

    const panel = findAccordionPanel(heading);
    if (panel) {
      const entries = entriesFromContainer(panel);
      if (entries.length >= 2) return entries;
    }
  }
  return [];
}

export function findReferenceEntries(doc: Document): ReferenceEntry[] {
  const elements: HTMLElement[] = [];

  for (const container of findReferenceContainers(doc)) {
    elements.push(...entriesFromContainer(container));
  }

  if (elements.length === 0) {
    elements.push(...findHeadingReferenceSiblings(doc));
  }

  const hostDoi = extractPrimaryDOI(doc);
  return elements.map((element) => {
    const doi = extractDoiFromEntry(element, hostDoi);
    const text = cleanReferenceText(element.innerText ?? element.textContent ?? "");
    return {
      element,
      doi,
      pmcid: doi === null ? extractPmcIdFromEntry(element, text) : null,
      text,
    };
  });
}

function extractFromReferenceContainers(doc: Document, found: Set<DoiString>): void {
  for (const container of findReferenceContainers(doc)) {
    for (const link of container.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const doi = extractDoiFromHref(link.href);
      if (doi) found.add(doi);
    }
    const text = (container as HTMLElement).innerText ?? container.textContent ?? "";
    const cleaned = decodeEncodedDois(text.replace(WORD_BREAK_CHARS, ""));
    for (const match of cleaned.matchAll(DOI_TEXT_REGEX)) {
      const raw = cleanDoiTrailing(match[1]);
      if (!isValidDoiSuffix(raw)) continue;
      const doi = normaliseDOI(raw);
      if (doi) found.add(doi);
    }
  }
}

function pageTypeFromPath(doc: Document): PageType {
  const path = doc.location?.pathname?.toLowerCase() ?? "";
  if (/\/(toc|issues?|volumes?|search|browse|list|results?|catalog|archive|index)(\/|$)/.test(path)) {
    return "listing";
  }
  return "unknown";
}

export function classifyPageDois(doc: Document): ClassifiedDois {
  const articleFound = new Set<DoiString>();
  extractFromUrl(doc, articleFound);
  extractFromMeta(doc, articleFound);
  extractFromJsonLd(doc, articleFound);

  const referenceFound = new Set<DoiString>();
  extractFromReferenceContainers(doc, referenceFound);
  for (const doi of articleFound) referenceFound.delete(doi);

  const pageWide = new Set<DoiString>(articleFound);
  extractFromDoiLinks(doc, pageWide);
  extractFromVisibleText(doc, pageWide);

  const otherFound = new Set<DoiString>();
  for (const doi of pageWide) {
    if (!articleFound.has(doi) && !referenceFound.has(doi)) otherFound.add(doi);
  }

  const pageType: PageType = articleFound.size > 0 ? "article" : pageTypeFromPath(doc);

  debugLog(
    `classifyPageDois: pageType=${pageType}`,
    `article=${articleFound.size}`,
    `references=${referenceFound.size}`,
    `other=${otherFound.size}`
  );

  return {
    pageType,
    articleDois: [...articleFound],
    referenceDois: [...referenceFound],
    otherDois: [...otherFound],
    allDois: [...new Set([...articleFound, ...referenceFound, ...otherFound])],
  };
}

function isGoogleSheets(doc: Document): boolean {
  try {
    const url = (doc.location?.href ?? "");
    return url.includes("docs.google.com/spreadsheets") ||
      doc.querySelector('meta[name="google"]')?.getAttribute("content") === "notranslate" &&
      !!doc.querySelector('[role="grid"]');
  } catch {
    return false;
  }
}
