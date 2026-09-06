import {fetchWithDeadline} from "@shared/work-cancellation";
// Formatted citations for a DOI via content negotiation. Crossref's transform
// endpoint renders the CSL styles; doi.org's negotiation service is the fallback
// for DOIs Crossref doesn't own (DataCite: datasets, Zenodo, figshare).
//
// Nothing is fetched until a reader asks for a citation — one lookup per DOI per
// format, then cached — so a page full of references costs no extra requests.

import {debugWarn} from "./debug";

import {getSettings} from "./settings";
import {BlobCache} from "./blob-cache";

export interface CitationFormat {
    id: string;
    label: string;
    /** Content-negotiation Accept header. */
    accept: string;
    /** Reference-manager exports keep their own line breaks and field order. */
    verbatim?: boolean;
}

const csl = (style: string): string => `text/x-bibliography; style=${style}; locale=en-US`;

export const CITATION_FORMATS: readonly CitationFormat[] = [
    {id: "apa", label: "APA", accept: csl("apa")},
    {id: "modern-language-association", label: "MLA", accept: csl("modern-language-association")},
    {id: "chicago-author-date", label: "Chicago", accept: csl("chicago-author-date")},
    {id: "harvard-cite-them-right", label: "Harvard", accept: csl("harvard-cite-them-right")},
    {id: "elsevier-vancouver", label: "Vancouver", accept: csl("elsevier-vancouver")},
    {id: "ieee", label: "IEEE", accept: csl("ieee")},
    {id: "american-medical-association", label: "AMA", accept: csl("american-medical-association")},
    {id: "american-sociological-association", label: "ASA", accept: csl("american-sociological-association")},
    {id: "nature", label: "Nature", accept: csl("nature")},
    {id: "bibtex", label: "BibTeX", accept: "application/x-bibtex", verbatim: true},
    {id: "ris", label: "RIS (EndNote, Zotero)", accept: "application/x-research-info-systems", verbatim: true},
];

export const DEFAULT_CITATION_FORMAT_ID = CITATION_FORMATS[0].id;

/** Resolve a stored format id, falling back to the default for unknown ids. */
export function citationFormat(id: string | null | undefined): CitationFormat {
    return CITATION_FORMATS.find((format) => format.id === id) ?? CITATION_FORMATS[0];
}

/** The reader's preferred format from settings. */
export async function preferredCitationFormat(): Promise<CitationFormat> {
    try {
        const {citationStyle} = await getSettings();
        return citationFormat(citationStyle);
    } catch {
        return CITATION_FORMATS[0];
    }
}

export interface Citation {
    text: string;
    /** Inline HTML carrying the emphasis CSL renders. Null for BibTeX/RIS. */
    html: string | null;
}

const CITATION_CACHE = new BlobCache<{text: string; html?: string | null}>({
    storageKey: "flora_citation_blob",
    ttlMs: 90 * 24 * 60 * 60 * 1000, // 90 days — a published record's citation is stable
    maxEntries: 1500,
});

const inflight = new Map<string, Promise<CitationOutcome>>();

const ENTITIES: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    "#39": "'",
    nbsp: " ",
};

/** CSL output carries markup (`<i>`, `&amp;`); the clipboard wants plain text. */
function stripMarkup(raw: string): string {
    return raw
        .replace(/<[^>]*>/g, "")
        .replace(/&(#?[a-z0-9]+);/gi, (match, entity: string) => ENTITIES[entity.toLowerCase()] ?? match);
}

// Tags kept from CSL output; every other tag and every attribute is dropped,
// so nothing but plain emphasis reaches the clipboard.
const INLINE_TAGS = new Set(["i", "em", "b", "strong", "sub", "sup"]);

function keepInlineMarkup(raw: string): string {
    return raw.replace(/<(\/?)([a-z0-9]+)[^>]*>/gi, (_match, slash: string, name: string) => {
        const tag = name.toLowerCase();
        return INLINE_TAGS.has(tag) ? `<${slash}${tag}>` : "";
    });
}

interface CitationRange {
    start: number;
    end: number;
}

/** Add a CSL capture group's final occurrence to the ranges to italicise. */
function addMatchRange(ranges: CitationRange[], match: RegExpExecArray, group: number): void {
    const value = match[group];
    if (!value || match.index === undefined) return;
    const offset = match[0].lastIndexOf(value);
    if (offset < 0) return;
    ranges.push({start: match.index + offset, end: match.index + offset + value.length});
}

/**
 * Crossref's text/x-bibliography response is deliberately plain text. That is
 * useful for a terminal, but it means a rich clipboard write would otherwise
 * lose the italics required by journal styles. Recover the journal and volume
 * spans from the stable punctuation emitted by the CSL styles. This is only a
 * fallback: markup supplied by a resolver remains authoritative.
 */
function plainCitationRanges(text: string, format: CitationFormat): CitationRange[] {
    const ranges: CitationRange[] = [];
    let journalMatch: RegExpExecArray | null = null;

    switch (format.id) {
        case "apa":
            journalMatch = /^(.*\(\d{4}[a-z]?\)\.\s+).+\.\s+(.+?),\s+\d+(?=\(\d+\)|,|\s|\.|$)/.exec(text);
            break;
        case "modern-language-association":
            journalMatch = /^(.+?[”"](?:\s*,)?\s+)(.+?),\s+(?=vol\.)/.exec(text);
            break;
        case "chicago-author-date":
            journalMatch = /^(.+?[”"]\s+)(.+?)\s+\d+(?:\s+\(\d+\))?\s*:/.exec(text);
            break;
        case "harvard-cite-them-right":
            journalMatch = /^(.+?[”"](?:,|\.)?\s+)(.+?)\.\s+(?=\d+\(|\d{4})/.exec(text);
            break;
        case "ieee":
            journalMatch = /^(.+?[”"](?:\s*,)?\s+)(.+?),\s+vol\./.exec(text);
            break;
        case "elsevier-vancouver":
        case "american-medical-association":
            journalMatch = /^(.+)\.\s+(.+?)(?:\.)?\s+\d{4}[.;]/.exec(text);
            break;
        case "american-sociological-association":
            journalMatch = /^(.+?[”"](?:\s*,)?\s+)(.+?)\s+\d+(?:\(\d+\))?:/.exec(text);
            break;
        case "nature":
            journalMatch = /^(.+)\.\s+(.+?)\s+\d+,/.exec(text);
            break;
    }

    if (!journalMatch) return ranges;
    addMatchRange(ranges, journalMatch, 2);

    // APA, Chicago, Harvard, IEEE, Vancouver, AMA, ASA and Nature italicise
    // the volume alongside the journal. MLA is the exception in this list.
    const volumeStyles = new Set([
        "apa",
        "chicago-author-date",
        "harvard-cite-them-right",
        "elsevier-vancouver",
        "ieee",
        "american-medical-association",
        "american-sociological-association",
        "nature",
    ]);
    if (volumeStyles.has(format.id)) {
        const journalEnd = journalMatch.index! + journalMatch[0].lastIndexOf(journalMatch[2]) + journalMatch[2].length;
        const volumePattern = format.id === "elsevier-vancouver" || format.id === "american-medical-association"
            ? /\b\d{4}[.;]\s*(\d+)(?=\(\d+\)|\s*\(|[,;:]|\s*,)/
            : /\b\d+(?=\(\d+\)|\s*\(|[,;:]|\s*,)/;
        const volume = volumePattern.exec(text.slice(journalEnd));
        if (volume && volume.index !== undefined) {
            const volumeText = volume[1] ?? volume[0];
            const volumeOffset = volume[1] ? volume[0].lastIndexOf(volume[1]) : 0;
            const volumeStart = journalEnd + volume.index + volumeOffset;
            ranges.push({start: volumeStart, end: volumeStart + volumeText.length});
        }
    }
    return ranges;
}

/** Escape a plain-text citation before inserting it into clipboard HTML. */
function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    }[character] ?? character));
}

/** Reconstruct the inline emphasis omitted by plain text/x-bibliography output. */
function formatPlainCitationHtml(text: string, format: CitationFormat): string {
    const ranges = plainCitationRanges(text, format)
        .sort((a, b) => a.start - b.start)
        .filter((range, index, all) => index === 0 || range.start >= all[index - 1].end);
    if (ranges.length === 0) return escapeHtml(text);

    let html = "";
    let cursor = 0;
    for (const range of ranges) {
        html += escapeHtml(text.slice(cursor, range.start));
        html += `<i>${escapeHtml(text.slice(range.start, range.end))}</i>`;
        cursor = range.end;
    }
    return html + escapeHtml(text.slice(cursor));
}

/**
 * Crossref stores an empty editor list on many journal articles, which citeproc
 * renders as a dangling "edited by ," / ", ed." in the styles that name editors.
 */
function dropEmptyEditor(text: string): string {
    return text
        .replace(/\.\s*edited by\s*,\s*/gi, ". ")
        .replace(/,?\s*edited by\s*,\s*/gi, ", ")
        .replace(/\s*edited by\s*\.\s*/gi, " ")
        .replace(/\.\s*,\s*ed\.\s+/gi, ". ");
}

function polish(rendered: string): string {
    return dropEmptyEditor(rendered)
        // Numeric styles prefix the entry with its bibliography position.
        .replace(/^(?:\[\d+\]|\d+\.)\s*/, "")
        .replace(/\s+/g, " ")
        .trim();
}

export function tidyCitation(raw: string, format: CitationFormat): string {
    const text = stripMarkup(raw).trim();
    return format.verbatim ? text : polish(text);
}

/** The same entry with its emphasis intact, or null where the format has none. */
export function tidyCitationHtml(raw: string, format: CitationFormat): string | null {
    if (format.verbatim) return null;
    const hasInlineMarkup = /<(?:\/?)(?:i|em|b|strong|sub|sup)\b/i.test(raw);
    const hasMarkup = /<[^>]+>/i.test(raw);
    const html = hasInlineMarkup || hasMarkup
        ? polish(keepInlineMarkup(raw).trim())
        : formatPlainCitationHtml(polish(stripMarkup(raw)), format);
    return html || null;
}

function crossrefUrl(doi: string, email: string): string {
    const mailto = email ? `?mailto=${encodeURIComponent(email)}` : "";
    return `https://api.crossref.org/works/${encodeURIComponent(doi)}/transform${mailto}`;
}

function doiOrgUrl(doi: string): string {
    return `https://doi.org/${doi.split("/").map(encodeURIComponent).join("/")}`;
}

export interface CitationOutcome {
    citation: Citation | null;
    reachable: boolean;
}

async function requestCitation(doi: string, format: CitationFormat): Promise<CitationOutcome> {
    let email = "";
    try {
        email = (await getSettings()).email;
    } catch {
        // Polite-pool contact is optional for content negotiation.
    }

    let reachable = false;
    for (const url of [crossrefUrl(doi, email), doiOrgUrl(doi)]) {
        try {
            const response = await fetchWithDeadline(url, {headers: {Accept: format.accept}});
            if (response.status < 500) reachable = true;
            if (!response.ok) continue;
            const raw = await response.text();
            const text = tidyCitation(raw, format);
            if (text) return {citation: {text, html: tidyCitationHtml(raw, format)}, reachable: true};
        } catch (err) {
            debugWarn(`Citation: ${url} failed for ${doi} —`, err);
        }
    }
    return {citation: null, reachable};
}

/**
 * Render `doi` in the given format, cached in chrome.storage.local. Returns null
 * when neither Crossref nor doi.org can render the DOI — failures are not cached
 * so a transient outage doesn't suppress the citation for the cache TTL.
 */
export async function fetchCitationDetailed(doi: string, formatId: string): Promise<CitationOutcome> {
    const format = citationFormat(formatId);
    const key = `${doi}|${format.id}`;

    // Entries cached before rich text shipped carry no `html`.
    const cached = await CITATION_CACHE.get(key);
    if (cached) return {citation: {text: cached.text, html: cached.html ?? null}, reachable: true};

    const existing = inflight.get(key);
    if (existing) return existing;

    const pending = requestCitation(doi, format)
        .then(async (outcome) => {
            if (outcome.citation) await CITATION_CACHE.set(key, outcome.citation);
            return outcome;
        })
        .finally(() => inflight.delete(key));
    inflight.set(key, pending);
    return pending;
}

export async function fetchCitation(doi: string, formatId: string): Promise<Citation | null> {
    return (await fetchCitationDetailed(doi, formatId)).citation;
}

/** Test-only: drop in-memory cache state so each case starts fresh. */
export function _resetCitationCacheForTesting(): void {
    CITATION_CACHE.resetForTesting();
    inflight.clear();
}
