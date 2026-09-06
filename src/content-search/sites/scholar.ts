// Google Scholar results (scholar.google.*). DOM checked 2026-08 on
// /scholar?q=…: rows are `.gs_r.gs_or.gs_scl`; title in `.gs_rt`; byline in
// `.gs_a`; the right-hand PDF column is `.gs_ggs` (absent on rows without a
// full-text link).

import type {DoiString} from "@shared/types";
import {normaliseDOI} from "@shared/doi-normalise";
import {debugLog} from "@shared/debug";
import type {RowExtraction, SearchSiteAdapter} from "./types";
import css from "./scholar.css";

const RESULT_ROW = ".gs_r.gs_or.gs_scl";

export const SCHOLAR: SearchSiteAdapter = {
    id: "scholar",
    label: "Scholar",
    hostnames: [
        "scholar.google.com", "scholar.google.co.uk", "scholar.google.co.in",
        "scholar.google.co.jp", "scholar.google.co.kr", "scholar.google.co.za",
        "scholar.google.co.id", "scholar.google.co.th", "scholar.google.co.il",
        "scholar.google.ca", "scholar.google.de", "scholar.google.fr",
        "scholar.google.es", "scholar.google.it", "scholar.google.com.br",
        "scholar.google.com.au",
    ],
    resultRow: RESULT_ROW,
    css,
    extractRow,
    // Prefer Scholar's own right-hand PDF column so the panel lines up with it.
    panelPlacement: [{selector: ".gs_ggs", position: "append"}],
    preparePanelTarget(row) {
        if (row.querySelector(".gs_ggs")) return;
        const target = document.createElement("div");
        target.className = "gs_ggs gs_fl";
        target.setAttribute("data-flora-panel-target", "");
        row.insertBefore(target, row.querySelector(".gs_ri"));
    },
};

function extractRow(row: HTMLElement): RowExtraction | null {
    // Skip non-article entries like [CITATION] and [BOOK]
    const typeTag = row.querySelector(".gs_rt .gs_ctu, .gs_rt .gs_ctg2, .gs_rt .gs_ct1");
    const typeText = typeTag?.textContent?.trim().toLowerCase() ?? "";
    if (typeText.includes("citation") || typeText.includes("book")) return null;

    const extraction = extractDoiFromScholarRow(row);
    const {firstAuthor, year} = extractScholarRowMetadata(row);
    return {
        title: row.querySelector(".gs_rt")?.textContent?.trim() ?? "",
        firstAuthor,
        year,
        sourceUrl: row.querySelector<HTMLAnchorElement>(".gs_rt a")?.href ?? null,
        doi: extraction?.doi ?? null,
        confident: extraction?.confident ?? false,
    };
}

interface ExtractionResult {
    doi: DoiString;
    /** true when the DOI comes from a doi.org URL (inherently trustworthy) */
    confident: boolean;
}

export interface ScholarRowMetadata {
    firstAuthor: string | null;
    year: number | null;
}

/**
 * Pull a row's first-author surname and year from its `.gs_a` byline
 * (e.g. "MD Wilkinson, M Dumontier… - Scientific data, 2016 - nature.com")
 * so augmentDOIs can disambiguate between similarly-titled works.
 */
export function extractScholarRowMetadata(row: HTMLElement): ScholarRowMetadata {
    const authorLine = row.querySelector(".gs_a")?.textContent ?? "";
    const beforeSource = authorLine.split(" - ")[0] ?? "";
    const firstAuthorText = beforeSource.split(",")[0]?.replace(/…/g, "").trim() ?? "";
    const authorTokens = firstAuthorText
        .replace(/[^\p{L}\p{N}\s-]/gu, " ")
        .split(/\s+/)
        .filter((token) => token && !/^[A-Z]\.?$/i.test(token));
    const firstAuthor = authorTokens[authorTokens.length - 1] ?? null;
    const yearMatch = authorLine.match(/\b((?:19|20)\d{2})\b/);
    const year = yearMatch ? Number(yearMatch[1]) : null;
    return {firstAuthor, year};
}

function extractDoiFromScholarRow(row: HTMLElement): ExtractionResult | null {
    const title = row.querySelector(".gs_rt")?.textContent?.trim() ?? "(untitled)";

    // 1. Title link href — doi.org URL is inherently trustworthy
    const titleLink = row.querySelector<HTMLAnchorElement>(".gs_rt a");
    if (titleLink?.href) {
        const doi = normaliseDOI(titleLink.href);
        if (doi) {
            debugLog(`Scholar DOI [title-link doi.org] "${title}" → ${doi} (confident) from ${titleLink.href}`);
            return {doi, confident: true};
        }
        // DOI explicitly named in query params (e.g. ?doi=10.xxx/yyy, ?identifierName=doi&identifierValue=10.xxx)
        const doiFromParams = extractDoiFromQueryParams(titleLink.href);
        if (doiFromParams) {
            debugLog(`Scholar DOI [title-link query-param] "${title}" → ${doiFromParams} (confident) from ${titleLink.href}`);
            return {doi: doiFromParams, confident: true};
        }
        // DOI may be embedded in path (e.g. /edit/10.xxx/yyy/slug)
        try {
            const decoded = decodeURIComponent(titleLink.href);
            const m = decoded.match(/\b(10\.\d{4,}(?:\.\d+)*\/[^\s&"'#?/]+)/);
            if (m) {
                const embeddedDoi = normaliseDOI(m[1]);
                if (embeddedDoi) {
                    debugLog(`Scholar DOI [title-link embedded-path] "${title}" → ${embeddedDoi} (not confident) from ${titleLink.href}`);
                    return {doi: embeddedDoi, confident: false};
                }
            }
        } catch { /* invalid encoding — skip */
        }
    }

    // 2. Author/source line text
    const authorLine = row.querySelector(".gs_a");
    if (authorLine?.textContent) {
        const match = authorLine.textContent.match(
            /\b(10\.\d{4,}(?:\.\d+)*\/\S+)\b/
        );
        if (match) {
            const doi = normaliseDOI(match[1]);
            if (doi) {
                debugLog(`Scholar DOI [author-line text] "${title}" → ${doi} (confident) from "${authorLine.textContent.trim()}"`);
                return {doi, confident: true};
            }
        }
    }

    // 3. Any link containing doi.org — inherently trustworthy
    const links = row.querySelectorAll<HTMLAnchorElement>("a[href]");
    for (const link of links) {
        if (link.href.includes("doi.org/")) {
            const doi = normaliseDOI(link.href);
            if (doi) {
                debugLog(`Scholar DOI [doi.org link] "${title}" → ${doi} (confident) from ${link.href}`);
                return {doi, confident: true};
            }
        }
    }

    // 4. DOI in query params of any link (explicitly labelled → confident)
    for (const link of links) {
        const paramDoi = extractDoiFromQueryParams(link.href);
        if (paramDoi) {
            debugLog(`Scholar DOI [link query-param] "${title}" → ${paramDoi} (confident) from ${link.href}`);
            return {doi: paramDoi, confident: true};
        }
    }

    // 5. DOI embedded in any link URL path (e.g. /edit/10.xxx/yyy/slug)
    const doiInUrlRe = /\b(10\.\d{4,}(?:\.\d+)*\/[^\s&"'#?/]+)/;
    for (const link of links) {
        try {
            const decoded = decodeURIComponent(link.href);
            const m = decoded.match(doiInUrlRe);
            if (m) {
                const doi = normaliseDOI(m[1]);
                if (doi) {
                    debugLog(`Scholar DOI [link embedded-path] "${title}" → ${doi} (not confident) from ${link.href}`);
                    return {doi, confident: false};
                }
            }
        } catch { /* invalid encoding */
        }
    }

    debugLog(`Scholar DOI [none] "${title}" → no DOI extracted`);
    return null;
}

/** Extract a DOI from URL query params where the param name explicitly indicates a DOI. */
function extractDoiFromQueryParams(href: string): DoiString | null {
    try {
        const url = new URL(href);
        const params = url.searchParams;

        // Direct param: ?doi=10.xxx/yyy
        for (const key of params.keys()) {
            if (key.toLowerCase() === "doi") {
                const doi = normaliseDOI(params.get(key) ?? "");
                if (doi) return doi;
            }
        }

        // Indirect pattern: ?identifierName=doi&identifierValue=10.xxx/yyy
        const idName = params.get("identifierName") ?? params.get("identifier_name") ?? "";
        if (idName.toLowerCase() === "doi") {
            const val = params.get("identifierValue") ?? params.get("identifier_value") ?? "";
            const doi = normaliseDOI(val);
            if (doi) return doi;
        }
    } catch { /* invalid URL */
    }
    return null;
}
