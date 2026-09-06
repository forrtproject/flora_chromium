import type {DoiString, DoiAugmentRequest} from "./types";
import {normaliseDOI} from "./doi-normalise";
import {getSettings} from "./settings";
import {BlobCache} from "./blob-cache";
import {debugLog, debugWarn, isDebugEnabled} from "./debug";
import {RequestGate} from "./request-gate";

const OPENALEX_BASE = "https://api.openalex.org/works";
const CROSSREF_BASE = "https://api.crossref.org/works";

// A reference list can hold dozens of titles without a DOI; fired all at once,
// both platforms answer 429 within the second. Crossref's polite pool allows
// 3 concurrent requests at 3/s; OpenAlex allows 10/s but charges a title
// search 10 credits against a free budget of 1000/day per client, and answers
// 429 with a Retry-After of "midnight UTC" once that is spent.
const crossrefGate = new RequestGate("Crossref", 3, 400);
const openalexGate = new RequestGate("OpenAlex", 3, 100);
const MATCH_THRESHOLD_TSR = 88; // token_set_ratio threshold (0–100)
// token_set_ratio scores 100 whenever one title's tokens are a subset of the
// other's, so a 3-word title matches a 7-word one perfectly. Coverage is the
// share of the *queried* title the candidate accounts for, which that ratio
// cannot express. Set below 100 so a candidate missing a subtitle still passes.
const MATCH_THRESHOLD_COVERAGE = 75;
const MIN_CITATION_TITLE_TOKENS = 4;
const CITATION_OVERLAP_TOKENS = 6;
// When page metadata (author/year) is available we accept candidates within this
// many points of the top title score, then let the metadata break the tie.
const METADATA_TITLE_BAND = 5;

const DOI_AUGMENT_CACHE = new BlobCache<CachedDoiResult>({
    storageKey: "flora_doi_blob",
    ttlMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    legacyPrefixes: ["flora_doi:"],
});

interface CachedDoiResult {
    found: boolean;
    doi: string | null;
}

// DoiAugmentRequest is defined in types.ts and re-exported for callers that
// import it from this module (preserves the public API surface).
export type { DoiAugmentRequest } from "./types";

interface DoiCandidate {
    doi: DoiString;
    title: string;
    score: number;
    source: "crossref" | "openalex";
    firstAuthor?: string | null;
    year?: number | null;
    urls?: string[];
}

async function getUserEmail(): Promise<string> {
    const {email} = await getSettings();
    return email;
}

/**
 * Normalize a title for comparison: lowercase, strip non-word chars, collapse spaces.
 */
export function normalizeTitle(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Clean a title for use in API search filters.
 * Strips characters that break filter syntax.
 */
function cleanTitleForSearch(title: string): string {
    return title
        .replace(/[:?!()\[\]&|\\,;'"]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Reduce an author string to a comparable surname: strip diacritics, drop
 * single-letter initials, and keep the last remaining token.
 */
function normalizeAuthorName(author: string | null | undefined): string {
    if (!author) return "";
    const ascii = author
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^\w\s-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!ascii) return "";
    const tokens = ascii.split(/\s+/).filter((token) => token && !/^[a-z]\.?$/.test(token));
    return tokens[tokens.length - 1] ?? "";
}

function normalizeRequest(input: string | DoiAugmentRequest): DoiAugmentRequest {
    if (typeof input === "string") return {title: input};
    return {
        title: input.title,
        firstAuthor: input.firstAuthor ?? null,
        year: input.year ?? null,
        sourceUrl: input.sourceUrl ?? null,
        titleIsFullCitation: input.titleIsFullCitation ?? false,
    };
}

function normalizeHostname(hostname: string): string {
    return hostname.toLowerCase().replace(/^www\./, "");
}

function urlHostname(rawUrl: string | null | undefined): string {
    try {
        return rawUrl ? normalizeHostname(new URL(rawUrl).hostname) : "";
    } catch {
        return "";
    }
}

/**
 * True when a candidate is corroborated by the request's source URL: either the
 * URL embeds the candidate's DOI, or the URL's host matches one of the
 * candidate's landing/PDF hosts (ignoring doi.org redirectors).
 */
function candidateMatchesSourceUrl(request: DoiAugmentRequest, candidate: DoiCandidate): boolean {
    if (!request.sourceUrl) return false;
    const sourceDoi = normaliseDOI(request.sourceUrl);
    if (sourceDoi && sourceDoi === candidate.doi) return true;

    const sourceHost = urlHostname(request.sourceUrl);
    if (!sourceHost || sourceHost === "doi.org" || sourceHost === "dx.doi.org") return false;
    return (candidate.urls ?? []).some((candidateUrl) => urlHostname(candidateUrl) === sourceHost);
}

function yearsMatch(expected: number | null | undefined, actual: number | null | undefined): boolean {
    return typeof expected === "number" && typeof actual === "number" && Math.abs(expected - actual) <= 1;
}

function authorsMatch(expected: string | null | undefined, actual: string | null | undefined): boolean {
    const expectedAuthor = normalizeAuthorName(expected);
    const actualAuthor = normalizeAuthorName(actual);
    return expectedAuthor.length > 0 && actualAuthor.length > 0 && expectedAuthor === actualAuthor;
}

/** Title score plus small bonuses for corroborating metadata. */
function candidateMerit(request: DoiAugmentRequest, candidate: DoiCandidate): number {
    let merit = candidate.score;
    if (candidateMatchesSourceUrl(request, candidate)) merit += 8;
    if (yearsMatch(request.year, candidate.year)) merit += 3;
    if (authorsMatch(request.firstAuthor, candidate.firstAuthor)) merit += 3;
    return merit;
}

/**
 * Pick the single best candidate, using page metadata to break ties between
 * similarly-titled works. Returns null when the field can't be narrowed to one
 * DOI — better to show nothing than to guess the wrong paper.
 */
function selectBestCandidate(request: DoiAugmentRequest, candidates: DoiCandidate[]): DoiCandidate | null {
    const eligible = candidates.filter((candidate) => candidate.score >= MATCH_THRESHOLD_TSR);
    if (eligible.length === 0) {
        debugLog(`Augment: no candidate cleared ${MATCH_THRESHOLD_TSR} for "${request.title.slice(0, 80)}"`);
        return null;
    }

    let contenders = eligible;
    if (request.titleIsFullCitation) {
        const overlaps = eligible.map((candidate) => citationTokenOverlap(request.title, candidate.title));
        const widest = Math.max(...overlaps);
        contenders = eligible.filter((_, index) => overlaps[index] === widest);
    }

    const highestScore = Math.max(...contenders.map((candidate) => candidate.score));
    const titleBand = request.firstAuthor || request.year
        ? contenders.filter((candidate) => candidate.score >= highestScore - METADATA_TITLE_BAND)
        : contenders.filter((candidate) => candidate.score === highestScore);

    let narrowed = titleBand;
    if (request.sourceUrl && narrowed.some((candidate) => candidateMatchesSourceUrl(request, candidate))) {
        narrowed = narrowed.filter((candidate) => candidateMatchesSourceUrl(request, candidate));
    }
    if (request.year && narrowed.some((candidate) => yearsMatch(request.year, candidate.year))) {
        narrowed = narrowed.filter((candidate) => yearsMatch(request.year, candidate.year));
    }
    if (request.firstAuthor && narrowed.some((candidate) => authorsMatch(request.firstAuthor, candidate.firstAuthor))) {
        narrowed = narrowed.filter((candidate) => authorsMatch(request.firstAuthor, candidate.firstAuthor));
    }

    const highestMerit = Math.max(...narrowed.map((candidate) => candidateMerit(request, candidate)));
    const best = narrowed.filter((candidate) => candidateMerit(request, candidate) === highestMerit);
    const bestDois = new Set(best.map((candidate) => candidate.doi));
    if (bestDois.size !== 1) {
        // Ambiguity resolves to no DOI, which otherwise looks like "not found".
        debugLog(
            `Augment: tie between ${[...bestDois].join(", ")} at merit ${highestMerit.toFixed(1)}`
            + ` for "${request.title.slice(0, 80)}" — resolving to no DOI`
        );
        return null;
    }

    const winner = best[0];
    const reasons = [
        candidateMatchesSourceUrl(request, winner) ? "source-url" : null,
        yearsMatch(request.year, winner.year) ? `year=${winner.year}` : null,
        authorsMatch(request.firstAuthor, winner.firstAuthor) ? `author=${winner.firstAuthor}` : null,
    ].filter(Boolean);
    debugLog(
        `Augment: "${request.title.slice(0, 80)}" → ${winner.doi} via ${winner.source.toUpperCase()}`
        + ` (title ${winner.score.toFixed(1)}, merit ${highestMerit.toFixed(1)}`
        + `${reasons.length > 0 ? ", corroborated by " + reasons.join(" + ") : ", title only"})`
        + ` from ${eligible.length} candidate(s) across ${new Set(eligible.map((c) => c.source)).size} platform(s)`
    );
    return winner;
}

function extractCrossrefYear(item: {
    issued?: {"date-parts"?: number[][]};
    "published-print"?: {"date-parts"?: number[][]};
    "published-online"?: {"date-parts"?: number[][]};
    published?: {"date-parts"?: number[][]};
}): number | null {
    const dateParts =
        item.issued?.["date-parts"] ??
        item["published-print"]?.["date-parts"] ??
        item["published-online"]?.["date-parts"] ??
        item.published?.["date-parts"];
    const year = dateParts?.[0]?.[0];
    return typeof year === "number" ? year : null;
}

function compactUrls(urls: Array<string | null | undefined>): string[] {
    return [...new Set(urls.filter((url): url is string => !!url))];
}

/**
 * Levenshtein-based similarity score between two strings (0 to 1).
 * 1.0 = identical, 0.0 = completely different.
 */
export function similarity(s1: string, s2: string): number {
    const longer = s1.length >= s2.length ? s1 : s2;

    if (longer.length === 0) return 1.0;

    const costs: number[] = [];
    for (let i = 0; i <= s1.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= s2.length; j++) {
            if (i === 0) {
                costs[j] = j;
            } else if (j > 0) {
                let newValue = costs[j - 1];
                if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
                    newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                }
                costs[j - 1] = lastValue;
                lastValue = newValue;
            }
        }
        if (i > 0) costs[s2.length] = lastValue;
    }

    return (longer.length - costs[s2.length]) / longer.length;
}

/**
 * Token-set-ratio fuzzy matching (pure JS port of fuzzywuzzy's token_set_ratio).
 * Tokenizes both strings, computes intersection/difference sets, and returns
 * the max Levenshtein similarity across three comparison pairs.
 * Returns a score from 0 to 100.
 */
export function tokenSetRatio(s1: string, s2: string): number {
    const tokens1 = new Set(normalizeTitle(s1).split(/\s+/).filter(Boolean));
    const tokens2 = new Set(normalizeTitle(s2).split(/\s+/).filter(Boolean));

    const intersection = [...tokens1].filter((t) => tokens2.has(t));
    const diff1 = [...tokens1].filter((t) => !tokens2.has(t));
    const diff2 = [...tokens2].filter((t) => !tokens1.has(t));

    const sortedIntersection = intersection.sort().join(" ");
    const combined1 = [sortedIntersection, ...diff1.sort()].join(" ").trim();
    const combined2 = [sortedIntersection, ...diff2.sort()].join(" ").trim();

    const r1 = similarity(sortedIntersection, combined1);
    const r2 = similarity(sortedIntersection, combined2);
    const r3 = similarity(combined1, combined2);

    return Math.max(r1, r2, r3) * 100;
}

/**
 * Share (0–100) of the queried title's tokens the candidate contains. Guards
 * against a short generic title scoring 100 against a longer specific one.
 */
export function titleCoverage(query: string, candidate: string): number {
    const queryTokens = new Set(normalizeTitle(query).split(/\s+/).filter(Boolean));
    if (queryTokens.size === 0) return 0;
    const candidateTokens = new Set(normalizeTitle(candidate).split(/\s+/).filter(Boolean));
    let covered = 0;
    for (const token of queryTokens) if (candidateTokens.has(token)) covered++;
    return (covered / queryTokens.size) * 100;
}

function coverageFor(request: DoiAugmentRequest, candidateTitle: string): number {
    return request.titleIsFullCitation
        ? titleCoverage(candidateTitle, request.title)
        : titleCoverage(request.title, candidateTitle);
}

function titleTokens(title: string): string[] {
    return normalizeTitle(title).split(/\s+/).filter(Boolean);
}

function citationTokenOverlap(citation: string, candidateTitle: string): number {
    const citationTokens = new Set(titleTokens(citation));
    let matched = 0;
    for (const token of new Set(titleTokens(candidateTitle))) if (citationTokens.has(token)) matched++;
    return matched;
}

function runsThroughCitation(citation: string, candidateTitle: string): boolean {
    return ` ${titleTokens(citation).join(" ")} `.includes(` ${titleTokens(candidateTitle).join(" ")} `);
}

function candidateClears(request: DoiAugmentRequest, candidateTitle: string, tsr: number): boolean {
    if (tsr < MATCH_THRESHOLD_TSR) return false;
    if (coverageFor(request, candidateTitle) < MATCH_THRESHOLD_COVERAGE) return false;
    if (!request.titleIsFullCitation) return true;
    if (titleTokens(candidateTitle).length < MIN_CITATION_TITLE_TOKENS) return false;
    return runsThroughCitation(request.title, candidateTitle)
        || citationTokenOverlap(request.title, candidateTitle) >= CITATION_OVERLAP_TOKENS;
}

function logQueryOutcome(
    source: "crossref" | "openalex",
    title: string,
    returned: number,
    accepted: DoiCandidate[],
    rejected: Array<{score: number; coverage: number; title: string}>
): void {
    if (!isDebugEnabled()) return;
    const head = `Augment [${source}] "${title.slice(0, 80)}": ${returned} result(s), ${accepted.length} usable`;
    if (accepted.length > 0) {
        const list = accepted
            .map((c) => `${c.doi} (${c.score.toFixed(1)}) "${c.title.slice(0, 60)}"`)
            .join("; ");
        debugLog(`${head} — ${list}`);
        return;
    }
    const best = rejected.sort((a, b) => b.score - a.score)[0];
    debugLog(best
        ? `${head} — best was "${best.title.slice(0, 60)}"`
          + ` (title ${best.score.toFixed(1)}/${MATCH_THRESHOLD_TSR},`
          + ` coverage ${best.coverage.toFixed(0)}%/${MATCH_THRESHOLD_COVERAGE}%), rejected`
        : `${head} — nothing usable`);
}

/**
 * Query Crossref for a title, returning every candidate that clears the title
 * threshold (with author/year/URL metadata for later tie-breaking).
 */
async function queryCrossref(request: DoiAugmentRequest, email: string, signal?: AbortSignal): Promise<DoiCandidate[]> {
    const {title} = request;
    const cleaned = cleanTitleForSearch(title);
    const url = `${CROSSREF_BASE}?query.title=${encodeURIComponent(cleaned)}&rows=5&select=DOI,title,author,issued,published-print,published-online,published,URL,link&mailto=${encodeURIComponent(email)}`;
    debugLog(`Augment [crossref] query: "${cleaned}"`);
    const response = await crossrefGate.fetch(url, {signal});
    if (!response.ok) throw new Error(`Crossref HTTP ${response.status}`);

    const data = (await response.json()) as {
        message?: {
            items?: Array<{
                DOI?: string;
                title?: string[];
                author?: Array<{family?: string; given?: string; name?: string}>;
                issued?: {"date-parts"?: number[][]};
                "published-print"?: {"date-parts"?: number[][]};
                "published-online"?: {"date-parts"?: number[][]};
                published?: {"date-parts"?: number[][]};
                URL?: string;
                link?: Array<{URL?: string}>;
            }>;
        };
    };

    const items = data.message?.items ?? [];
    const candidates: DoiCandidate[] = [];
    const rejected: Array<{score: number; coverage: number; title: string}> = [];

    for (const item of items) {
        if (!item.DOI || !item.title?.[0]) continue;

        const tsr = tokenSetRatio(title, item.title[0]);
        const coverage = coverageFor(request, item.title[0]);
        if (!candidateClears(request, item.title[0], tsr)) {
            rejected.push({score: tsr, coverage, title: item.title[0]});
        } else {
            const doi = normaliseDOI(item.DOI);
            if (doi) {
                candidates.push({
                    doi,
                    title: item.title[0],
                    score: tsr,
                    source: "crossref",
                    firstAuthor: item.author?.[0]?.family ?? item.author?.[0]?.name ?? null,
                    year: extractCrossrefYear(item),
                    urls: compactUrls([item.URL, ...(item.link ?? []).map((link) => link.URL)]),
                });
            }
        }
    }

    logQueryOutcome("crossref", title, items.length, candidates, rejected);
    return candidates;
}

/**
 * Query OpenAlex for a title, returning every candidate that clears the title
 * threshold (with author/year/URL metadata for later tie-breaking).
 */
async function queryOpenAlex(request: DoiAugmentRequest, email: string, signal?: AbortSignal): Promise<DoiCandidate[]> {
    const {title} = request;
    const cleaned = cleanTitleForSearch(title);
    const url = `${OPENALEX_BASE}?filter=title.search:${encodeURIComponent(cleaned)}&select=id,doi,title,publication_year,authorships,primary_location,locations&per_page=5&mailto=${encodeURIComponent(email)}`;

    debugLog(`Augment [openalex] query: "${cleaned}"`);
    const response = await openalexGate.fetch(url, {signal});
    if (!response.ok) throw new Error(`OpenAlex HTTP ${response.status}`);

    const data = (await response.json()) as {
        results?: Array<{
            doi?: string;
            title?: string;
            publication_year?: number | null;
            authorships?: Array<{author?: {display_name?: string | null} | null}>;
            primary_location?: {landing_page_url?: string | null; pdf_url?: string | null} | null;
            locations?: Array<{landing_page_url?: string | null; pdf_url?: string | null}>;
        }>;
    };

    const works = data.results ?? [];
    const candidates: DoiCandidate[] = [];
    const rejected: Array<{score: number; coverage: number; title: string}> = [];

    for (const work of works) {
        if (!work.doi || !work.title) continue;

        const tsr = tokenSetRatio(title, work.title);
        const coverage = coverageFor(request, work.title);
        if (!candidateClears(request, work.title, tsr)) {
            rejected.push({score: tsr, coverage, title: work.title});
        } else {
            const doi = normaliseDOI(work.doi);
            if (doi) {
                candidates.push({
                    doi,
                    title: work.title,
                    score: tsr,
                    source: "openalex",
                    firstAuthor: work.authorships?.[0]?.author?.display_name ?? null,
                    year: work.publication_year ?? null,
                    urls: compactUrls([
                        work.primary_location?.landing_page_url,
                        work.primary_location?.pdf_url,
                        ...(work.locations ?? []).flatMap((location) => [
                            location.landing_page_url,
                            location.pdf_url,
                        ]),
                    ]),
                });
            }
        }
    }

    logQueryOutcome("openalex", title, works.length, candidates, rejected);
    return candidates;
}

/**
 * Augment DOIs for article titles that don't have a DOI.
 * Queries both Crossref and OpenAlex APIs in parallel, then picks
 * the best-matching candidate using token-set-ratio fuzzy scoring.
 * Returns a Map of original title -> resolved DoiString (or null if not found).
 */
export async function augmentDOIs(
    inputs: Array<string | DoiAugmentRequest>, signal?: AbortSignal
): Promise<Map<string, DoiString | null>> {
    const detailed = await augmentDOIsDetailed(inputs, signal);
    return new Map([...detailed].map(([title, r]) => [title, r.doi] as const));
}

/** Where a resolved DOI came from. "cache" means no platform was queried. */
export type AugmentSource = "crossref" | "openalex" | "both" | "cache";
type AugmentPlatform = "crossref" | "openalex";

export interface AugmentOutcome {
    doi: DoiString | null;
    source: AugmentSource | null;
    answered: boolean;
}

/** As `augmentDOIs`, but reports which platform produced each DOI. */
export async function augmentDOIsDetailed(
    inputs: Array<string | DoiAugmentRequest>, signal?: AbortSignal
): Promise<Map<string, AugmentOutcome>> {
    const results = new Map<string, AugmentOutcome>();
    if (inputs.length === 0) return results;
    const requests = inputs.map(normalizeRequest).filter((request) => request.title.trim());
    if (requests.length === 0) return results;

    // Check cache first — single-blob lookup keyed by normalized title. The
    // cache stays title-keyed; page metadata only influences candidate choice,
    // not the cache identity.
    const keyByTitle = new Map(requests.map((r) => [r.title, normalizeTitle(r.title)] as const));
    const cached = await DOI_AUGMENT_CACHE.getMany([...new Set(keyByTitle.values())]);

    // Group cache misses by their normalized key so titles that only differ in
    // punctuation/whitespace/case (same key) are queried once, not once each.
    const uncachedByKey = new Map<string, DoiAugmentRequest[]>();
    for (const request of requests) {
        const key = keyByTitle.get(request.title)!;
        const entry = cached.get(key);
        if (entry) {
            const cachedDoi = entry.found && entry.doi ? normaliseDOI(entry.doi) : null;
            debugLog(
                `Augment: "${request.title.slice(0, 80)}" → ${cachedDoi ?? "no match"} from cache`
                + " (no platform queried; clear flora_doi_blob to re-resolve)"
            );
            results.set(request.title, {doi: cachedDoi, source: cachedDoi ? "cache" : null, answered: true});
        } else {
            const group = uncachedByKey.get(key);
            if (group) group.push(request);
            else uncachedByKey.set(key, [request]);
        }
    }

    if (uncachedByKey.size === 0) return results;

    // No email means we can't query the APIs at all. Resolve every uncached
    // title to null but DO NOT write the cache: a cached no-match would
    // suppress these titles for the cache TTL (30 days) even after the user
    // configures their email.
    const email = await getUserEmail();
    if (!email) {
        debugWarn(
            `Augment: no contact email configured — skipping ${uncachedByKey.size} title(s);`
            + " neither Crossref nor OpenAlex will be queried"
        );
        for (const group of uncachedByKey.values()) {
            for (const request of group) results.set(request.title, {doi: null, source: null, answered: false});
        }
        return results;
    }

    // Query each distinct title on one platform first — titles alternate
    // between Crossref and OpenAlex so the load (and OpenAlex's daily credit
    // budget) is split — and ask the other only when the first fails, finds
    // nothing, or returns several DOIs (a preprint/journal pair, say) whose
    // tie the second platform's metadata may break. Then use the page
    // metadata to pick the single best candidate. Cache writes are
    // accumulated and flushed once at the end.
    const updates: Array<[string, CachedDoiResult]> = [];
    const lookupPromises = [...uncachedByKey.entries()].map(async ([key, group], index) => {
        const request = group[0];
        const order: AugmentPlatform[] = index % 2 === 0 ? ["crossref", "openalex"] : ["openalex", "crossref"];
        const outcomes: Partial<Record<AugmentPlatform, PromiseSettledResult<DoiCandidate[]>>> = {};
        for (const platform of order) {
            signal?.throwIfAborted();
            const [outcome] = await Promise.allSettled([
                platform === "crossref" ? queryCrossref(request, email, signal) : queryOpenAlex(request, email, signal),
            ]);
            outcomes[platform] = outcome;
            if (outcome.status === "fulfilled" && new Set(outcome.value.map((c) => c.doi)).size === 1) break;
        }
        const crossrefResult = outcomes.crossref ?? {status: "skipped"} as const;
        const openalexResult = outcomes.openalex ?? {status: "skipped"} as const;

        const candidates: DoiCandidate[] = [];
        if (crossrefResult.status === "fulfilled") candidates.push(...crossrefResult.value);
        else if (crossrefResult.status === "rejected") debugWarn(`Augment [crossref] query threw for "${request.title.slice(0, 80)}" —`, crossrefResult.reason);
        if (openalexResult.status === "fulfilled") candidates.push(...openalexResult.value);
        else if (openalexResult.status === "rejected") debugWarn(`Augment [openalex] query threw for "${request.title.slice(0, 80)}" —`, openalexResult.reason);

        // Deduplicate by DOI, merging metadata across the two sources so a
        // candidate seen by both keeps the author/year/urls either provided.
        const byDoi = new Map<string, DoiCandidate>();
        for (const c of candidates) {
            const existing = byDoi.get(c.doi);
            if (!existing) {
                byDoi.set(c.doi, c);
            } else {
                debugLog(
                    `Augment: ${c.doi} returned by both platforms`
                    + ` (crossref/openalex scores ${existing.score.toFixed(1)}/${c.score.toFixed(1)})`
                );
                byDoi.set(c.doi, {
                    ...(c.score > existing.score ? c : existing),
                    firstAuthor: existing.firstAuthor ?? c.firstAuthor,
                    year: existing.year ?? c.year,
                    urls: compactUrls([...(existing.urls ?? []), ...(c.urls ?? [])]),
                });
            }
        }

        const best = selectBestCandidate(request, [...byDoi.values()]);
        const doi = best?.doi ?? null;
        const seenIn = new Set(candidates.filter((c) => c.doi === doi).map((c) => c.source));
        const source: AugmentSource | null = !best
            ? null
            : seenIn.size > 1 ? "both" : best.source;
        const answered =
            crossrefResult.status === "fulfilled" || openalexResult.status === "fulfilled";
        for (const r of group) results.set(r.title, {doi, source, answered});

        if (answered) {
            updates.push([key, {found: doi !== null, doi}]);
        } else {
            debugWarn(
                `Augment: neither platform answered for "${request.title.slice(0, 80)}"`
                + " — not caching the no-match so it retries next time"
            );
        }
    });

    await Promise.allSettled(lookupPromises);

    if (updates.length > 0) await DOI_AUGMENT_CACHE.setMany(updates);

    // Defensive: set null for any titles a rejected lookup left unresolved.
    for (const request of requests) {
        if (!results.has(request.title)) results.set(request.title, {doi: null, source: null, answered: false});
    }

    return results;
}


const TITLE_CACHE = new BlobCache<{ title: string | null }>({
    storageKey: "flora_title_blob",
    ttlMs: 90 * 24 * 60 * 60 * 1000, // 90 days — published titles are stable.
    legacyPrefixes: ["flora_title:"],
});

/**
 * Resolve a paper's canonical title from its DOI. Tries Crossref first, then
 * OpenAlex. Cached in chrome.storage.local since a published title never
 * changes. Returns null when neither service has the DOI.
 */
export async function fetchTitleByDoi(doi: string): Promise<string | null> {
    const cached = await TITLE_CACHE.get(doi);
    if (cached) return cached.title;

    const encodedDoi = doi.split("/").map(encodeURIComponent).join("/");

    let title: string | null = null;
    let crossrefAnswered = false;
    let openalexAnswered = false;

    try {
        const email = await getUserEmail();
        const mailto = email ? `?mailto=${encodeURIComponent(email)}` : "";
        const response = await crossrefGate.fetch(`${CROSSREF_BASE}/${encodedDoi}${mailto}`);
        crossrefAnswered = response.ok || response.status === 404;
        if (response.ok) {
            const data = (await response.json()) as { message?: { title?: string[] } };
            title = data.message?.title?.[0] ?? null;
        }
    } catch {
        // Crossref failed — fall through to OpenAlex
    }

    if (!title) {
        try {
            const response = await openalexGate.fetch(`${OPENALEX_BASE}/doi:${encodedDoi}?select=title`);
            openalexAnswered = response.ok || response.status === 404;
            if (response.ok) {
                const data = (await response.json()) as { title?: string };
                title = data.title ?? null;
            }
        } catch (err) {
            debugWarn(`Title lookup: OpenAlex failed for ${doi} —`, err);
        }
    }

    if (title !== null || (crossrefAnswered && openalexAnswered)) {
        void TITLE_CACHE.set(doi, {title});
    }
    return title;
}

/** Test-only: drop in-memory cache state so each case starts fresh. */
export function _resetAugmentCachesForTesting(): void {
    DOI_AUGMENT_CACHE.resetForTesting();
    TITLE_CACHE.resetForTesting();
}
