# Visual regression harness

Renders FLoRA's on-page UI in a **real browser with the real built extension**
and pixel-diffs full-page screenshots against committed baselines. It exists
because placement of the injected pills/badges is the top source of bug
reports, and those bugs only show up in a rendered layout — not in unit tests.

The harness loads the actual MV3 extension into **Chrome for Testing**, serves
fixture pages over `http://127.0.0.1`, waits for FLoRA to finish injecting, and
captures the page. Everything the extension would fetch is mocked, so pass/fail
never depends on the network.

The browser runs **headless** (`headless: true`), which loads MV3 extensions and
renders pixel-for-pixel the same as a headful window — no window opens while the
tests run.

## Running

```bash
npm run build            # dist/ must exist — the extension is loaded from the repo root
npm run test:visual        # compare against baselines; exits 1 on any diff
npm run test:visual:update # regenerate baselines (after an intentional UI change)
```

On first run the harness auto-installs its pinned Chrome for Testing version into the default
puppeteer cache (`~/.cache/puppeteer`, **outside the repo**). Nothing is written
into the working tree except baselines (on update) and `output/` (on failure).

### First-run note (macOS)

`@puppeteer/browsers` occasionally extracts the Chrome `.app` bundle without its
`Frameworks/` symlinks, and the browser then fails to launch
(`dlopen … Framework: no such file`). If that happens, re-extract the cached zip
with macOS `ditto`, which handles app bundles correctly:

```bash
cd ~/.cache/puppeteer/chrome
rm -rf mac_arm-*/chrome-mac-arm64
ditto -x -k *.zip mac_arm-<version>/
```

## What gets tested

13 fixtures (viewport 1280×900, `deviceScaleFactor` 1):

| Fixture | Exercises |
| --- | --- |
| `ref-list-flex` | Reference list as flex rows with action links |
| `ref-list-grid` | Reference list in a two-column CSS grid |
| `table-bibliography` | `<table>`-based bibliography |
| `rtl-article` | `dir="rtl"` Arabic article with DOIs (pill mirroring) |
| `editor-textarea` | `contenteditable` editor + `<textarea>` with DOIs |
| `long-article-sticky` | Long article, sticky header + fixed footer, side panel |
| `shared-block-anchor` | Several matched DOIs sharing one block anchor (one badge each) |
| `article-with-dois` | Reused unit fixture — meta DOI + doi.org ref links |
| `doi-in-href` | Reused — DOI only in a link href |
| `doi-in-table` | Reused — DOI in a cell / prose inside a table |
| `doi-in-text` | Reused — DOI in running prose |
| `retracted` | Reused — Springer article page, notice beside the DOI-bearing masthead link |
| `publisher-styled-link-row` | Reference row whose publisher styling (separator borders) must stay off the pill |

Each fixture uses DOIs seeded to a known state (has replications, reproductions,
retracted, expression of concern, or no data) so the injected UI is fully
determined by the mocks.

## How the mocks work (hermetic)

Two mechanisms, both in `mocks.ts`, guarantee no real network dependence:

1. **Pre-seeded `chrome.storage`.** Before any fixture loads, the harness writes
   into the service worker's storage via `worker.evaluate(() => chrome.storage…)`:
   - **FLoRA replication cache** — the worker caches lookups through
     `LocalCache` (prefix `"flora"`); entries are `{"flora:<doi>": {data, expiresAt}}`
     (see `src/shared/cache.ts`). Every fixture DOI is seeded, so each lookup is a
     cache hit and the FORRT rep-api is never called.
   - **Retraction map** — stored under `RET_MAP_KEY` (`"RetractionLookupLocal"`,
     `src/shared/data-extract.ts`) as `{retractions, concerns}`, mapping the
     retracted / concern fixture DOIs to notice DOIs. `synctime` is set to "now"
     so the weekly GitHub sync never fires.
   - **Settings** — `flora_settings` in `chrome.storage.sync` with an email set,
     so `isSetupComplete()` is true and the setup prompt never overlays a
     screenshot.
   - **Page-side `BlobCache`s** (`chrome.storage.local`): doi.org validation
     (`flora_doival_blob`), PubPeer (`flora_pubpeer_blob`), and Unpaywall Open
     Access (`flora_oa_blob`) — one entry per fixture DOI, so the content
     script's own lookups are also cache hits.

2. **Request interception.**
   - **Page context** (`page.setRequestInterception`): localhost is allowed; the
     doi.org Handle API, PubPeer POST, and Unpaywall are served canned JSON; any
     other external request is aborted.
   - **Worker context**: every http(s) request the service worker makes to
     anything but the local fixture server (FORRT rep-api, Crossref, OpenAlex,
     the GitHub retraction sync, Google Docs, PMC, …) is failed via a CDP
     `Fetch` session attached to the `service_worker` target — page-level
     interception does not cover worker requests. The extension's own packaged
     resources pass through.

The retraction map + settings are re-seeded immediately before each fixture as
insurance against a stray install-time sync.

## Determinism

- **One raster path.** macOS Chrome flaps between GPU and software
  rasterisation across page loads, which shifts the anti-aliasing of *every
  glyph* on the page — runs would pass or fail different fixtures at random
  with whole-page text diffs (~0.2–2 % of pixels). The launch flags pin a
  single software raster path: `--disable-gpu` (the primary fix) plus
  `--disable-gpu-compositing --force-device-scale-factor=1
  --disable-font-subpixel-positioning --disable-partial-raster
  --disable-skia-runtime-opts`.
- **Viewport capture where the page fits.** `fullPage` on a `dir="rtl"`
  document captures from the wrong horizontal origin — content comes out
  shifted right and clipped at the right edge even though nothing overflows
  the viewport, which hid every RTL placement the fixture exists to check.
  The harness captures the viewport directly whenever the page already fits
  in it, and falls back to `fullPage` only for the taller fixtures.
- Rendering flags: `--force-color-profile=srgb --hide-scrollbars
  --disable-lcd-text --font-render-hinting=none`.
- A stylesheet injected after load disables all animations/transitions, hides the
  caret, and removes the transient "scanning" toast.
- Fixtures use an explicit system font stack and load no external
  fonts/images/scripts; `document.fonts.ready` is awaited before capture.
- After navigation the harness polls the injected FLoRA selectors
  (`.flora-indicator-pill, .flora-notice-pill, #flora-pubpeer-panel`)
  until their contents and geometry are stable for 700 ms, at least one
  element exists, and the work toast is gone, then waits a short settle.
  Failure to reach this state within 12 seconds fails the fixture.

Stability bar: after regenerating baselines, `npm run test:visual` must report
**0 px difference on every fixture across five consecutive runs** before the
baselines are committed.

Local comparison uses `pixelmatch` at a per-pixel threshold of `0.1`; a fixture fails
if more than **100 pixels** differ. The budget is an absolute count so that it
stays meaningful on a tall full-page shot, where a percentage would leave room
for a whole pill to move. On failure the actual and diff images are written to
`output/` (gitignored).

## Baselines are platform-specific

Baselines in `baselines/` were rendered on **macOS**. Font rasterisation differs
across operating systems, so baselines generated on macOS will not match a Linux
CI run pixel-for-pixel. Regenerate baselines on the platform where the tests will
run (`npm run test:visual:update`) and commit them from that platform.

## Updating baselines

When a FLoRA UI change is intentional, run `npm run test:visual:update`,
**visually inspect** the regenerated PNGs in `baselines/`, and commit them
alongside the code change so the diff is reviewable.

## PR evidence and visual sign-off

`Visual evidence` builds the PR base and head on the same Ubuntu runner and
renders both with the PR's fixture catalogue and pinned Chrome 152.0.7977.75.
Committed macOS baselines do not determine CI results. Changes to committed
baseline PNGs cannot hide a change between the actual base and head builds.
Both link-only and text-only DOI fixtures now contain real reference layouts;
the old minimal unit fixtures produced no visible extension UI.

The capture waits for nonempty extension UI, stable contents and geometry,
and removal of the work toast. A timeout is a failure, including in update
mode. This is a readiness guard, not a claim that every async interaction is
covered. Popovers, keyboard interaction, popup/options, search-site layouts,
and narrow viewports still need additional visual scenarios.

The PR approval gate uses exact raw RGBA equality: even a one-channel change
within the local perceptual budget requires visual approval.

CI stores all before/after PNGs, changed-pixel diff images (when dimensions
match), JSON results, and a self-contained `index.html` in the `visual-report`
artifact. Download and extract the artifact, then open `index.html`. Reports
expire after 30 days; rerun capture if the evidence has expired.

A separate trusted `workflow_run` job updates a marked section of the PR body
with the commit, changed fixtures, report link, and approval status. GitHub
artifact images cannot be embedded directly in Markdown; the report provides
the image comparison without publishing screenshots to another service.
The privileged job executes only default-branch code and parses artifact JSON
as data. It also checks the PR head SHA and repository so stale runs cannot
approve a newer commit.

The PR description shows only the checkboxes that apply:

- [ ] I checked the changed screenshots and they look right.
- [ ] I checked the screenshot test setup changes.

After inspecting the evidence, a human collaborator with write access can tick
these boxes directly in the PR description. The PR author can do this too.
There is no special review phrase or approving-review requirement. Screenshot
changes and changes to the capture machinery are separate decisions; ticking
one box preserves that partial approval while the other remains pending.

A trusted `pull_request_target` body-edit workflow verifies the editor's access
and an actual unchecked-to-checked transition on the current evidence. That
edit confirms the boxes checked in the submitted checklist, so rapid clicks
do not lose the first choice. Stale edit events cannot overwrite a later edit;
checked text without an authorized checkbox edit does not grant approval.
Approval is recorded against
the head commit, capture run/attempt and current artifact, with the capture
timestamp in the managed evidence marker. New commits or captures reset the
checkboxes. Unchecking a box withdraws that approval. Capture failures remain
failures regardless of the checklist.

The `Visual approval` status succeeds automatically when there are no screenshot
or capture-input changes, stays pending until the required boxes are checked,
and fails if capture failed. Summary counts use separate units: rendered
examples, committed screenshot files and non-image capture inputs. Rendered
examples and committed screenshots can overlap and are not added together.

**Activation:** these trusted workflows must first be merged to the default
branch. Then make `Visual approval` a required status check for `main` using
branch protection or a repository ruleset. Until that repository setting is
enabled, the status reports approval but cannot prevent merging. This avoids
requiring blanket PR approvals when screenshots did not change.

For local base/head captures, the harness also accepts `VR_REPO_ROOT` (built
extension root), `VR_BASELINE_DIR`, and `VR_OUTPUT_DIR`. `--review` treats pixel
changes as reviewable evidence while still failing capture errors. These are
optional; the existing local comparison/update commands still work.

Changed committed baseline PNGs also require visual approval and are embedded
as base/PR image pairs in the PR description. This covers changes to the test
scenes or reference images even when both builds render identically with the
new fixture catalogue. Artifact comparisons and committed-baseline comparisons
are labeled separately because they answer different questions.

Changes to visual fixtures, capture/publisher workflows, the publisher script,
package manifests/lockfile, build configuration or extension manifest also
require review. A PR cannot weaken its own capture and use its resulting
all-pass artifact as evidence that approval is unnecessary. This is a review
policy for regression detection, not a security sandbox for hostile extensions.
