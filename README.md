# FORRT ORE — Open Research Extension

**FORRT ORE** (Open Research Extension) is a browser extension for Chrome and Edge that detects academic papers on the web and surfaces what is known about them: replication and reproduction evidence from the [FORRT Replication Database](https://forrt.org/replication-database/), retractions and expressions of concern, PubPeer discussion, and open-access full text.

When you visit an article page (PubMed, journal websites, preprint servers, etc.) or search on Google Scholar, OpenAlex, Semantic Scholar, PubMed, Europe PMC, Scopus or EBSCOhost, ORE scans for DOIs, looks them up, and shows what it found in an inline pill next to each paper and each reference.

📖 **[User documentation](https://forrt.org/chromium-extension/)** — what ORE shows, where it works, how to install it, and the [privacy policy](https://forrt.org/chromium-extension/privacy.html). Source for that site lives in [`docs/`](docs/).

## What it does

- **Article pages**: Displays a banner at the top of the page summarizing replication/reproduction data for all DOIs found on the page. Inline badges also appear next to individual DOI links. Handles SPAs by detecting URL changes and re-scanning automatically.
- **Search results (Google Scholar, OpenAlex, Semantic Scholar, PubMed, Europe PMC, Scopus, EBSCOhost)**: Adds an indicator panel (DOI, open access, PubPeer, replication/retraction status) beside each result. One shared pipeline resolves each row's DOI — from the row itself, from the site's own record id (OpenAlex work ids, Semantic Scholar paper ids, PubMed PMIDs, Scopus record ids and EBSCOhost record ids are resolved through those sites' own APIs), or by title search — and a per-site adapter in `src/content-search/sites/` supplies the selectors and a stylesheet that places the panel in that site's layout. Adding a site means adding one adapter file, one CSS file and the manifest URL patterns.
- **DOI extraction**: Extracts DOIs from meta tags, JSON-LD, link hrefs, visible text, and HTML tables. Handles word-break characters (zero-width spaces, soft hyphens) and validates DOI suffixes to avoid partial matches from split HTML.
- **DOI augmentation**: When a page or Scholar result doesn't have a DOI in its HTML, ORE queries [Crossref](https://www.crossref.org/) and [OpenAlex](https://openalex.org/) to resolve the article title to a DOI via fuzzy matching (token-set-ratio > 88%).
- **DOI popover**: Each DOI pill has a hover popover showing the full DOI string with a copy-to-clipboard button.
- **Clicking badges/links**: Opens the [FORRT replication landing page](https://forrt.org/flora-replication-atlas/) for the relevant DOI(s).

## Installation (developer mode)

Since this extension is not yet on the Chrome Web Store, you'll need to load it manually.

### Quick install

1. **[Download flora-extension.zip](https://github.com/forrtproject/chromium-extension/releases)** (built automatically from the latest code)
2. **Unzip** it to a folder on your computer
3. Open `chrome://extensions` (or `edge://extensions`)
4. Enable **Developer mode** (toggle in the top-right corner)
5. Click **Load unpacked** and select the unzipped folder
6. **You're done!** Navigate to any academic article page or Google Scholar to see it in action.

### Building from source

If you want to develop or modify the extension:

1. Install [Node.js](https://nodejs.org/) (v24, matching CI)

2. Clone and build:

   ```bash
   git clone https://github.com/forrtproject/chromium-extension.git
   cd chromium-extension
   npm install
   npm run build
   ```

3. Load the project root folder as an unpacked extension (as above).

After making changes, run `npm run build` and click the **reload** icon on the extension's card in `chrome://extensions`.

## Development

### Project structure

```
chromium-extension/
  manifest.json          # Chrome MV3 manifest
  esbuild.config.ts      # Build configuration
  src/
    shared/              # Shared modules used by all entry points
      types.ts           # Zod schemas, branded types, state types
      doi-normalise.ts   # DOI string normalisation
      doi-extractor.ts   # Extract DOIs from page HTML (meta, JSON-LD, visible text, tables)
      doi-augment.ts     # Resolve titles to DOIs via Crossref + OpenAlex
      flora-api.ts       # FORRT replication API client
      messages.ts        # Message types for content ↔ background
      cache.ts           # Persistent lookup cache (chrome.storage.local)
      site-adapters.ts   # Per-site pill placement registry (see below)
      debounce.ts        # Debounce utility
      debug.ts           # Debug logger + capture (gated on the flora_debug flag)
      debug-log.ts       # Persistent debug log; the service worker is its only writer
      debug-report.ts    # Builds the diagnostic report attached to issue reports
    background/
      service-worker.ts  # MV3 service worker — handles FLORA_LOOKUP messages
    content-general/
      index.ts           # Content script for article pages (SPA-aware)
      injector.ts        # Banner, inline badge, and DOI popover rendering (Shadow DOM)
      styles.css         # Banner/badge styles
    content-github/
      index.ts           # Fills the debug report into ORE's own GitHub issue form
    content-search/
      index.ts           # Content script for search-results sites (picks the adapter by hostname)
      pipeline.ts        # Shared row → DOI → lookup → panel pipeline
      observer.ts        # Re-runs the pipeline when the site adds result rows
      sites/             # One adapter (.ts) + placement stylesheet (.css) per site; index.ts registers them
    options/
      index.html         # Options page
  tests/
    setup.ts             # Chrome API mocks
    helpers.ts           # Test utilities (doi(), mockResult())
    unit/                # Unit tests for all modules
    fixtures/            # HTML fixtures for extractor tests
  dist/                  # Built output (generated by npm run build)
```

### Per-site pill placement

By default ORE infers where to put a pill from the shape of the page — the
longest text container in a reference entry, the last link in the entry, and so
on. That works across the long tail of publishers, but on sites we know it can
land badly. On Atypon platforms (science.org, Sage) the only DOI in a reference
is the href of the "Crossref" link, so the generic rule wedges the pill into the
middle of the `Crossref | Web of Science | Google Scholar` row.

`src/shared/site-adapters.ts` holds a registry that names the element a pill
belongs in, per hostname. **Every site spells out its own selectors**, even
where two sites currently agree — sites are tuned and broken independently, and
a shared rule set means you can't fix one publisher without retesting the other.
A test enforces this: no two adapters may share a rule object by reference.

To add a site, copy an existing block, change the selectors, and append it to
`SITE_ADAPTERS`:

```ts
const NATURE: SiteAdapter = {
  id: "nature",
  hostnames: ["nature.com"],          // subdomains and www. match too
  referencePill: [
    { selector: ".c-article-references__text", position: "append" },
  ],
  titlePill: [
    { selector: "h1.c-article-title", position: "append" },
  ],
  referenceScope: "#references",            // optional
  referencePillStyle: { top: "2px" },       // optional
  titlePillStyle: { top: "0" },             // optional
};
```

Record the DOM path you verified the selectors against in a comment above the
block, as the existing entries do. That's what makes the next person's fix a
two-minute job rather than an archaeology exercise.

* `referencePill` / `titlePill` are ordered candidate lists. The first selector
  matching a live element wins, so you can list a preferred target then a
  fallback for older page templates.
* `position` is `append` (default), `prepend`, `before`, or `after`. The
  selector `":self"` targets the search root itself.
* `referencePillStyle` / `titlePillStyle` override the pill wrapper's CSS, per
  slot — most often `top`, the vertical nudge, whose default suits body text and
  usually needs lowering inside a large `h1`. Anything you don't name keeps its
  default, and a value may end in `!important` for publishers with aggressive
  CSS.
* `referenceScope` confines pills to one part of the page. Sage marks author
  endnotes up much like citations, and without a scope they get pilled — and
  worse, sent to Crossref/OpenAlex for augmentation, which can return a
  confident-looking wrong DOI.

**Sites not in the registry use the generic placement**, and so does any
registered site whose selectors stop matching. That fallback is deliberate:
publisher markup changes without notice, and a stale selector should quietly
degrade to generic placement rather than drop the pill from the page.

Placement is covered by `tests/unit/site-adapters.test.ts` (rules in isolation)
and `tests/unit/reference-placement.test.ts` (the real render path, hostname
stubbed). Both run against fixtures trimmed from live article pages, so add a
fixture when you add a site.

### Debug mode & issue reports

Toolbar popup → **Debug mode** turns on logging. Every `debugLog`/`debugWarn`/
`debugError` call, plus uncaught errors thrown by extension code, is then
captured alongside the console output. Content scripts and extension pages batch
their entries and message them to the service worker, which is the only writer of
the `flora_debug_log` storage key — so there is no read-modify-write race between
contexts. The log is a ring buffer capped at 800 entries.

With debug mode on, the progress toast (bottom right while a page is worked)
also offers **Copy log** in its expanded panel, and — with the popup's
*Offer "Copy log" after each pass* switch on — stays up as a one-line
`Done in 2.3 s · Copy log` after the pass. Every stage transition is logged with
its duration (`Work: augment done in 2310 ms`), so a slow pass shows which stage
took the time. The same panel lists the stages of the current pass (on Google
Scholar also the DOIs and titles being resolved) and a **Cancel** button; the clock
icon snoozes ORE on the site for an hour or until tomorrow (resume from the popup)
or disables it on the domain.

To report a bug: turn debug mode on, reload the page, reproduce, then hit
**Report an issue** in the popup. The diagnostic report — build, user agent,
behaviour-changing settings and the log — is written into the GitHub issue body
for you; nothing is submitted until you press GitHub's own button.

Two routes get it there, and the first doesn't touch GitHub's DOM at all:

1. **`?body=` prefill.** GitHub's documented prefill is the reliable path, but a
   URL only holds so much — `issueUrl()` binary-searches the entry count to fit
   as much of the log's *tail* as stays under 6 KB, and labels the result "most
   recent N of M entries" so a trimmed log is never mistaken for a whole one.
   Trimming whole entries rather than slicing the string keeps the markdown and
   its code fence intact.
2. **Form autofill upgrades that to the full log.** The complete report is parked
   in the worker's session storage; `content-github.ts`, declared only for
   `github.com/forrtproject/chromium-extension/issues/new*`, waits for the body
   field and swaps it in between the `<!-- ORE-DEBUG-REPORT:START/END -->`
   fences. Writes go through the `HTMLTextAreaElement.prototype` value setter
   plus a bubbling `input` event, or React discards the text on its next render.

The second step is best-effort by design: if it fails, step 1 has already put a
usable log in the issue. The report is claimed only once a field exists to hold
it, so a detour through GitHub sign-in leaves it parked rather than consumed (15
minute TTL). Failure is never silent — the content script verifies the text
survived 250 ms of re-rendering and raises an on-page toast if it didn't, and the
full report is on the clipboard either way.

Settings → **Troubleshooting** shows the same report on screen so it can be
reviewed, downloaded or cleared before it is shared; the user's contact email is
never included.

### Automated Workflows

* Opened pull request are tested against the [test workflow](.github/workflows/test.yml)
* Pushing to `main` creates a new draft release from latest sources.
* Pushing a tag to `main` will create a new release

### Commands

| Command              | Description                    |
| -------------------- | ------------------------------ |
| `npm run build`      | Build the extension (one-time) |
| `npm run watch`      | Build and watch for changes    |
| `npm test`           | Run all unit tests             |
| `npm run test:watch` | Run tests in watch mode        |
| `npm run typecheck`  | TypeScript type checking       |

### Tech stack

- **TypeScript** (strict mode)
- **esbuild** for bundling; TypeScript checks run separately with `npm run typecheck`
- **Zod** for API response validation
- **Vitest** + jsdom + msw for testing
- **Shadow DOM** for UI isolation (styles don't leak into host pages)
- **Manifest V3** (Chrome + Edge)

### How it works

1. **Content scripts** run on every page. They extract DOIs from the page using meta tags, JSON-LD, link hrefs, visible text, and HTML tables. Word-break characters are stripped and partial DOI suffixes are filtered out.
2. If no DOIs are found directly, the extension tries to resolve the page/article title to a DOI using **Crossref** or **OpenAlex**, alternating which service is queried first across titles. The other service is queried if the first fails or returns no single DOI (fuzzy title matching with token-set-ratio > 88%).
3. Found DOIs are sent to the **background service worker** via `chrome.runtime.sendMessage`.
4. The service worker checks its **persistent local cache**, deduplicates in-flight requests, and calls the **FORRT Replication API** for any uncached DOIs.
5. Results are sent back to the content script, which renders **banners** and **inline badges** using Shadow DOM.
6. On **search-results sites** (Google Scholar, OpenAlex, Semantic Scholar, PubMed, Europe PMC, Scopus, EBSCOhost), an indicator panel is injected into each result row where the site adapter's stylesheet places it (Scholar: the right-side `.gs_ggs` column, created if absent; OpenAlex: a right-hand column beside the result text; Semantic Scholar: beside the TLDR/abstract; PubMed: beside the authors/journal/PMID block; Europe PMC: a right-hand column below the title; EBSCOhost: beside the By/In metadata line, above the abstract; Scopus: the right end of the result's columns row in list view and in the title cell in table view).
7. The content-general script detects **SPA navigations** (URL changes) and re-scans the page automatically.

## Data sources & credits

- **Replication / reproduction data** — [FORRT Replication Database](https://forrt.org/replication-database/).
- **Title → DOI resolution** — [Crossref](https://www.crossref.org/) and [OpenAlex](https://openalex.org/).
- **Retractions** — [Retraction Watch](https://retractionwatch.com/) / The Center for Scientific Integrity, made openly available in partnership with [Crossref](https://gitlab.com/crossref/retraction-watch-data) under [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## License

This project is part of the [FORRT](https://forrt.org/) initiative.
