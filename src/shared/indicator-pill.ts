import {safeSendMessage, type LookupResponse} from "@shared/messages";
import {fetchOpenAccess} from "@shared/openaccess";
// Merged FLoRA indicator pill — combines the DOI badge, Open Access padlock,
// PubPeer discussion marker, and retraction/replication badge into a single
// pill (mockup: a rounded maroon pill with icon segments split by dividers).
//
// Segments that have no data stay in the pill (dimmed) rather than
// disappearing, so the pill's width/segment order never shifts as async
// lookups resolve. The segments themselves are just status glyphs — hovering
// (or clicking, to pin) the pill opens a popover listing every indicator as
// its own row, and all actual interaction (copy DOI, open on doi.org, open
// the OA full text, open the PubPeer thread, open the retraction notice or
// FLoRA Atlas entry) happens from inside that popover.

import type {DoiString, LookupState, RetractionResponse} from "@shared/types";
import type {OpenAccessLocation, OpenAccessStatus} from "@shared/openaccess";
import type {PubPeerFeedback} from "@shared/pubpeer-api";
import {lookupPubPeerForDoi} from "@shared/pubpeer-api";
import {noticePresentation} from "@shared/doi-retraction";
import {atlasDoiUrl} from "@shared/flora-atlas";
import {OA_UNLOCK_SVG} from "@shared/doi-label";
import {fetchCitationDetailed, preferredCitationFormat, type CitationFormat} from "@shared/citation";
import {debugWarn} from "@shared/debug";
import {ensureFocusStyle} from "@shared/flora-ui";
import {getSettings} from "@shared/settings";
import {writeClipboard, writeRichClipboard} from "@shared/clipboard";
import {showToast} from "@shared/toast";

export const INDICATOR_PILL_CLASS = "flora-indicator-pill";

// Two scripts can share a page: content-general owns the title pills, the
// search content script owns the per-result panels (on Europe PMC, Scopus,
// EBSCOhost, …). Each removes and re-badges only its own kind, or one script's
// SPA reset would wipe the other's work.
export type IndicatorScope = "pills" | "panels";

function indicatorSelector(scope: IndicatorScope): string {
    return scope === "panels"
        ? `.${INDICATOR_PILL_CLASS}[data-flora-panel]`
        : `.${INDICATOR_PILL_CLASS}:not([data-flora-panel])`;
}

export function removeIndicatorPills(root: ParentNode = document, scope: IndicatorScope = "pills"): void {
    for (const pill of root.querySelectorAll(indicatorSelector(scope))) pill.remove();
}

export const PAGE_PROVENANCE = "Found on this page";
export const SEARCH_PROVENANCE =
    "Matched by search — looked up by title, first author and year. Check it is the right paper.";

export const PUBPEER_HUB_SVG =
    `<svg width="11" height="15" viewBox="0 0 98.5 146.5" fill="none" stroke="currentColor" ` +
    `stroke-width="9" stroke-linecap="round" style="display:block;">` +
    `<circle cx="13.667" cy="34.833" r="10.167"/>` +
    `<circle cx="86.302" cy="80.344" r="10.167"/>` +
    `<circle cx="86.302" cy="12.741" r="10.167"/>` +
    `<circle cx="13.04" cy="133.811" r="10.166"/>` +
    `<line x1="13.04" y1="45" x2="13.04" y2="123.645"/>` +
    `<line x1="23.44" y1="32.04" x2="76.554" y2="15.626"/>` +
    `<line x1="86.303" y1="22.907" x2="86.303" y2="70.177"/>` +
    `<line x1="18.027" y1="124.955" x2="80.772" y2="21.267"/>` +
    `<line x1="76.136" y1="80.344" x2="45.023" y2="80.344"/></svg>`;

const DIVIDER_STYLE = "width:1px;height:11px;background:rgba(255,255,255,0.4);flex-shrink:0;margin:0 6px;";

// Link/chain glyph for the popover's DOI row — same Octicons family as the
// copy/open/check icons used elsewhere in the popover.
export const DOI_LINK_SVG =
    `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="display:block;">` +
    `<path d="M7.775 3.275a.75.75 0 0 0 1.06 1.06l1.25-1.25a2 2 0 1 1 2.83 2.83l-2.5 2.5a2 2 0 0 1-2.83 0 ` +
    `.75.75 0 0 0-1.06 1.06 3.5 3.5 0 0 0 4.95 0l2.5-2.5a3.5 3.5 0 0 0-4.95-4.95l-1.25 1.25Zm-4.69 9.64a2 2 0 0 1 0-2.83l2.5-2.5a2 2 0 0 1 2.83 0 ` +
    `.75.75 0 0 0 1.06-1.06 3.5 3.5 0 0 0-4.95 0l-2.5 2.5a3.5 3.5 0 0 0 4.95 4.95l1.25-1.25a.75.75 0 0 0-1.06-1.06l-1.25 1.25a2 2 0 0 1-2.83 0Z">` +
    `</path></svg>`;

// Quotation-mark glyph for the DOI row's "copy this reference" action.
const QUOTE_SVG =
    `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="display:block;">` +
    `<path d="M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z"/></svg>`;

const CLIPBOARD_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="display:block;"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"></path><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"></path></svg>`;
const CHECK_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="display:block;"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"></path></svg>`;

const ICON_BTN_STYLE = `
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: content-box;
    width: 14px !important;
    height: 14px !important;
    min-width: 0 !important;
    max-width: 14px !important;
    padding: 0 !important;
    margin: 0;
    border: none !important;
    background: transparent !important;
    cursor: pointer;
    color: #656d76;
    transition: color 0.15s ease;
    line-height: 0;
    font-size: 0;
    text-decoration: none;
    flex: 0 0 auto;
  `;

// Shared by the indicator pill and the retraction/concern notice pill so the
// two align with each other wherever they land beside the same citation.
//
// Two things keep the pill centred on the text it annotates, at any size:
//
// `line-height: 0` — the wrapper is an inline-block, so without it the
// wrapper's strut inherits the host's line-height and the box grows taller
// than the pill drawn inside it (38px of box around a 22px pill in a heading
// with `line-height: 1.55`). `vertical-align` then centres that inflated box
// while the visible pill hangs low inside it, by an amount that follows the
// host's line-height rather than anything we control.
//
// `top: -0.1em` — `vertical-align: middle` centres on the parent's x-height
// (0.52em in a typical sans) rather than its cap height (0.71em), leaving the
// pill low by half the difference. In `em` so it tracks the host's font size.
// `top` and not `transform`: a transform would make this wrapper the
// containing block for the position:fixed popover, throwing its viewport
// coordinates far off.
export const PILL_WRAPPER_STYLE =
    "position: relative; display: inline-block; vertical-align: middle;"
    + " line-height: 0 !important; top: -0.1em;"
    + " margin-left: 0 !important; margin-right: 0 !important;"
    + " margin-inline-start: 6px !important;";

const BOX_SIDES = ["top", "right", "bottom", "left"] as const;

const INHERITED_TEXT_RESETS = [
    ["text-indent", "0"],
    ["text-transform", "none"],
    ["letter-spacing", "normal"],
    ["word-spacing", "normal"],
    ["font-variant", "normal"],
    ["text-shadow", "none"],
] as const;

function resetInheritedText<T extends Element>(root: T): T {
    const style = (root as Partial<ElementCSSInlineStyle>).style;
    if (!style) return root;
    for (const [prop, value] of INHERITED_TEXT_RESETS) {
        if (!style.getPropertyValue(prop)) style.setProperty(prop, value, "important");
    }
    return root;
}

function shieldFromPageCss<T extends Element>(root: T): T {
    const nodes = [root, ...root.querySelectorAll("*")] as Iterable<Partial<ElementCSSInlineStyle>>;
    for (const node of nodes) {
        const style = node.style;
        if (!style) continue;
        for (const side of BOX_SIDES) {
            for (const prop of [`padding-${side}`, `margin-${side}`, `border-${side}-width`]) {
                if (!style.getPropertyValue(prop)) style.setProperty(prop, "0", "important");
            }
        }
    }
    return resetInheritedText(root);
}

function makeDivider(): HTMLElement {
    const d = document.createElement("span");
    d.style.cssText = DIVIDER_STYLE;
    return d;
}

// ──────────────────────────────────────────────
// Inline segments — dimmed/lit status glyphs only, no direct interaction.
// ──────────────────────────────────────────────

function buildOaSegment(oa: OpenAccessStatus | null): HTMLElement {
    const available = !!oa?.isOa;
    const el = document.createElement("span");
    el.setAttribute("data-flora-oa-segment", "");
    el.style.cssText = `display:inline-flex;align-items:center;line-height:0;color:#fff;opacity:${available ? "1" : "0.35"};`;
    el.innerHTML = OA_UNLOCK_SVG;
    el.title = available ? "Open Access — free full text available" : "Open Access status unavailable";
    return shieldFromPageCss(el);
}

function buildPubPeerSegment(feedback: PubPeerFeedback | null, answered: boolean | "pending" = "pending"): HTMLElement {
    const available = !!feedback && feedback.total_comments > 0;
    const el = document.createElement("span");
    el.setAttribute("data-flora-pubpeer-segment", "");
    el.style.cssText = `display:inline-flex;align-items:center;line-height:0;color:#fff;opacity:${available ? "1" : "0.35"};`;
    el.innerHTML = PUBPEER_HUB_SVG;
    el.title = answered === "pending" ? "Checking PubPeer…" : available && feedback
        ? `${feedback.total_comments} ${feedback.total_comments === 1 ? "comment" : "comments"} on PubPeer`
        : answered ? "No PubPeer discussion found" : "PubPeer status unavailable";
    return shieldFromPageCss(el);
}

interface BadgeSignal {
    available: boolean;
    href?: string;
    glyph: string;       // inline segment text
    background: string;  // inline segment background colour
    accent: string;      // popover row icon/action colour
    rowTitle: string;    // popover row heading
    rowSubtitle: string; // popover row status line
    rowSubtitleShort: string; // same status, trimmed to sit beside the heading
    actionLabel?: string;
}

// Replications take priority over reproductions when a DOI has both — the
// badge shows one count/label, not two, to keep the pill's shape stable.
function resolveBadgeSignal(
    doi: DoiString,
    retraction: RetractionResponse | null | undefined,
    replicationsCount: number | null | undefined,
    reproductionsCount: number | null | undefined
): BadgeSignal {
    if (retraction) {
        const presentation = noticePresentation(retraction.kind);
        return {
            available: true,
            href: `https://doi.org/${retraction.doi}`,
            glyph: "!",
            background: presentation.pillStroke,
            accent: presentation.pillStroke,
            rowTitle: presentation.label,
            rowSubtitle: presentation.bannerCopy,
            rowSubtitleShort: "",
            actionLabel: "View notice",
        };
    }
    if (replicationsCount && replicationsCount > 0) {
        return {
            available: true,
            href: atlasDoiUrl([doi]),
            glyph: `${replicationsCount} Reps`,
            background: "rgba(255,255,255,0.25)",
            accent: "#0369a1",
            rowTitle: "Replications",
            rowSubtitle: `${replicationsCount} replication${replicationsCount === 1 ? "" : "s"} recorded`,
            rowSubtitleShort: `${replicationsCount}`,
            actionLabel: "View in Atlas",
        };
    }
    if (reproductionsCount && reproductionsCount > 0) {
        return {
            available: true,
            href: atlasDoiUrl([doi]),
            glyph: `${reproductionsCount} Reprod`,
            background: "rgba(255,255,255,0.25)",
            accent: "#6d28d9",
            rowTitle: "Reproductions",
            rowSubtitle: `${reproductionsCount} reproduction${reproductionsCount === 1 ? "" : "s"} recorded`,
            rowSubtitleShort: `${reproductionsCount}`,
            actionLabel: "View in Atlas",
        };
    }
    return {
        available: false,
        glyph: "",
        background: "rgba(255,255,255,0.15)",
        accent: "#8b949e",
        rowTitle: "Replication / Reproduction data",
        rowSubtitle: "No replication or reproduction data found",
        rowSubtitleShort: "None",
    };
}

function buildBadgeSegment(signal: BadgeSignal): HTMLElement {
    const el = document.createElement("span");
    el.setAttribute("data-flora-badge-segment", "");
    // Single-glyph states ("!" or empty) render as a small circle; multi-char
    // labels ("3 Reps") widen into a pill so the text isn't clipped.
    const isPill = signal.glyph.length > 1;
    el.style.cssText = `
    display:inline-flex;align-items:center;justify-content:center;
    height:15px;${isPill ? "min-width:15px;padding:0 5px;border-radius:999px;" : "width:15px;border-radius:50%;"}
    margin-left:2px;flex-shrink:0;white-space:nowrap;
    font-size:9px;font-weight:700;line-height:1;color:#fff;
    background:${signal.background};
    opacity:${signal.available ? "1" : "0.35"};
  `;
    el.textContent = signal.glyph;
    el.title = signal.available ? `${signal.rowTitle} — ${signal.rowSubtitle}` : signal.rowSubtitle;
    return shieldFromPageCss(el);
}

// ──────────────────────────────────────────────
// Popover rows — the actual interactive surface for every segment.
// ──────────────────────────────────────────────

const ROW_LABEL_WRAP = "display:flex;flex-direction:column;flex:1;min-width:0;gap:1px;";
// Compact rows put the status beside the heading instead of under it, halving
// the row count's contribution to the panel's height.
const ROW_LABEL_WRAP_COMPACT = "display:flex;align-items:baseline;flex:1;min-width:0;gap:5px;";
const ROW_TITLE_STYLE = "font-size:11.5px;font-weight:600;color:#1f2328;line-height:1.3;";
const ROW_TITLE_STYLE_COMPACT = "font-size:11px;font-weight:600;color:#1f2328;line-height:1.25;";

function rowIconWrapStyle(color: string, available: boolean, compact = false): string {
    const size = compact ? 12 : 16;
    return `display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;flex-shrink:0;color:${color};opacity:${available ? "1" : "0.4"};`;
}

function rowSubStyle(available: boolean, compact = false): string {
    return `font-size:${compact ? "10px" : "10.5px"};color:#57606a;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
}

function rowActionStyle(color: string, compact = false): string {
    return `font-size:${compact ? "10px" : "10.5px"};font-weight:600;color:${color};flex-shrink:0;white-space:nowrap;`;
}

/** Build one interactive popover row. `href` present → clickable <a>; absent → inert <div>. */
function buildRow(opts: {
    iconHtml: string;
    accent: string;
    available: boolean;
    title: string;
    subtitle: string;
    /** Status text for compact rows, where the full sentence has no room. */
    subtitleShort?: string;
    href?: string;
    onAction?: () => void;
    actionLabel?: string;
    /** Action text for compact rows; falls back to a bare arrow. */
    actionLabelShort?: string;
    attr: string;
    compact?: boolean;
}): HTMLElement {
    const useLink = opts.available && !!opts.href;
    const row = document.createElement(useLink ? "a" : "div") as HTMLElement;
    row.setAttribute(opts.attr, "");
    row.style.cssText = `display:flex;align-items:center;gap:${opts.compact ? "5px" : "8px"};padding:${opts.compact ? "1px 3px" : "5px 4px"};border-radius:6px;text-decoration:none;${useLink ? "cursor:pointer;" : "cursor:default;"}`;
    if (useLink && row instanceof HTMLAnchorElement && opts.href) {
        row.href = opts.href;
        row.target = "_blank";
        row.rel = "noopener noreferrer";
        row.addEventListener("click", (e) => e.stopPropagation());
        row.addEventListener("mouseenter", () => { row.style.background = "#f6f8fa"; });
        row.addEventListener("mouseleave", () => { row.style.background = "transparent"; });
    }
    const subtitle = opts.compact ? opts.subtitleShort ?? opts.subtitle : opts.subtitle;
    const action = opts.compact
        ? opts.actionLabelShort ?? "↗"
        : `${opts.actionLabel ?? "View"} ↗`;
    row.innerHTML = `
    <span style="${rowIconWrapStyle(opts.accent, opts.available, opts.compact)}">${opts.iconHtml}</span>
    <span style="${opts.compact ? ROW_LABEL_WRAP_COMPACT : ROW_LABEL_WRAP}">
      <span style="${opts.compact ? ROW_TITLE_STYLE_COMPACT : ROW_TITLE_STYLE}">${opts.title}</span>
      <span data-flora-row-sub style="${rowSubStyle(opts.available, opts.compact)}">${subtitle}</span>
    </span>
    ${useLink ? `<span style="${rowActionStyle(opts.accent, opts.compact)}">${action}</span>` : ""}
  `;
    if (!useLink && opts.onAction) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = opts.actionLabel ?? "Settings";
        button.style.cssText =
            `all:unset;cursor:pointer;${rowActionStyle(opts.accent, opts.compact)}`;
        button.addEventListener("click", (e) => {
            e.stopPropagation();
            opts.onAction?.();
        });
        row.appendChild(button);
        row.style.cursor = "default";
    }
    return row;
}

/** Keep keyboard position when an async provider row replaces its focused control. */
function replaceIndicatorRow(previous: HTMLElement, next: HTMLElement): void {
    const focused = previous.contains(document.activeElement);
    previous.replaceWith(next);
    if (focused) {
        const target = next.matches("a,button") ? next : next.querySelector<HTMLElement>("a,button") ?? next;
        if (target === next && !next.matches("a,button")) next.tabIndex = -1;
        target.focus({preventScroll: true});
    }
}

async function hasContactEmail(): Promise<boolean> {
    try {
        return (await getSettings()).email.trim().length > 0;
    } catch {
        return true;
    }
}

function openFloraOptions(): void {
    try {
        chrome.runtime.sendMessage({type: "FLORA_OPEN_OPTIONS"}).catch(() => {});
    } catch (err) {
        debugWarn("Pill: could not open the options page —", err);
    }
}

const DOT_ICON = (color: string) => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};"></span>`;

/** Every free copy on offer, falling back to the single URL older caches stored. */
function oaLocations(oa: OpenAccessStatus | null): OpenAccessLocation[] {
    if (!oa?.isOa) return [];
    if (oa.locations?.length) return oa.locations;
    return oa.url ? [{url: oa.url, label: "Free copy", version: null, isPdf: false}] : [];
}

/** One free copy, as a line in the chooser under the Open Access row. */
function buildOaChoice(loc: OpenAccessLocation, compact: boolean): HTMLElement {
    const item = document.createElement("a");
    item.href = loc.url;
    item.target = "_blank";
    item.rel = "noopener noreferrer";
    item.style.cssText = `display:flex;align-items:baseline;gap:6px;padding:${compact ? "1px 4px" : "3px 4px"};border-radius:5px;text-decoration:none;font-size:${compact ? "10px" : "10.5px"};line-height:1.4;`;
    item.addEventListener("click", (e) => e.stopPropagation());
    item.addEventListener("mouseenter", () => { item.style.background = "#f6f8fa"; });
    item.addEventListener("mouseleave", () => { item.style.background = "transparent"; });

    const label = document.createElement("span");
    label.textContent = loc.label;
    label.style.cssText = "flex:1;min-width:0;color:#1f2328;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";

    const meta = document.createElement("span");
    meta.textContent = [loc.isPdf ? "PDF" : null, loc.version].filter(Boolean).join(" · ");
    meta.style.cssText = "flex-shrink:0;color:#57606a;";

    item.appendChild(label);
    if (meta.textContent) item.appendChild(meta);
    return item;
}

type OaState = OpenAccessStatus | null | "pending" | "no-email";

function oaSubtitle(state: OaState, available: boolean): string {
    if (state === "pending") return "Checking…";
    if (state === "no-email") return "Add your email in Settings to check open access";
    if (state === null) return "Unavailable";
    if (state.notIndexed) return "Not indexed by Unpaywall";
    return available ? "Free full text available" : "Not confirmed open access";
}

function buildOaRow(state: OaState, compact = false, retry?: () => void): HTMLElement {
    const oa = state === "pending" || state === "no-email" ? null : state;
    const available = !!oa?.isOa;
    const locations = oaLocations(oa);

    if (locations.length <= 1) {
        return buildRow({
            iconHtml: OA_UNLOCK_SVG,
            accent: "#853953",
            available: available && locations.length === 1,
            title: "Open Access",
            subtitle: oaSubtitle(state, available),
            onAction: state === "no-email" ? openFloraOptions : state === null ? retry : undefined,
            subtitleShort: state === null ? "Unavailable" : state === "pending" ? "…" : oa?.notIndexed ? "Not indexed" : available ? "Free" : "—",
            href: locations[0]?.url,
            actionLabel: state === "no-email" ? "Settings" : state === null ? "Retry" : "View PDF",
            attr: "data-flora-oa-row",
            compact,
        });
    }

    // Several free copies — publisher, preprint server, institutional
    // repository — differ in version and licence. The row still opens the
    // best-ranked one on a plain click, which is what a reader wants nearly
    // every time; the chevron beside it folds out the rest, for when that copy
    // turns out to be dead, gated, or the wrong version.
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-flora-oa-row", "");
    wrapper.style.cssText = "display:flex;flex-direction:column;";

    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;";

    const primary = buildRow({
        iconHtml: OA_UNLOCK_SVG,
        accent: "#853953",
        available: true,
        title: "Open Access",
        subtitle: `${locations.length} free copies`,
        subtitleShort: `${locations.length} free`,
        href: locations[0].url,
        actionLabel: "View PDF",
        attr: "data-flora-oa-primary",
        compact,
    });
    primary.style.flex = "1";
    primary.style.minWidth = "0";
    header.appendChild(primary);

    // The toggle is a sibling of the link, not a child: a control nested inside
    // an <a> would navigate and expand on the same click.
    let open = false;

    const toggle = document.createElement("span");
    toggle.setAttribute("data-flora-oa-choices", "");
    toggle.setAttribute("role", "button");
    toggle.tabIndex = 0;
    toggle.title = `Choose from ${locations.length} free copies`;
    toggle.style.cssText =
        rowActionStyle("#853953", compact)
        + `cursor:pointer;user-select:none;border-radius:5px;padding:${compact ? "1px 4px" : "3px 5px"};`;

    const list = document.createElement("div");
    list.style.cssText = `display:none;flex-direction:column;padding:0 0 ${compact ? "2px" : "4px"} ${compact ? "19px" : "24px"};`;
    for (const loc of locations) list.appendChild(buildOaChoice(loc, compact));

    const setToggle = () => {
        toggle.textContent = open ? "▴" : "▾";
        toggle.setAttribute("aria-expanded", String(open));
    };
    setToggle();

    const flip = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        open = !open;
        list.style.display = open ? "flex" : "none";
        setToggle();
    };
    toggle.addEventListener("click", flip);
    toggle.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") flip(e);
    });
    toggle.addEventListener("mouseenter", () => { toggle.style.background = "#f6f8fa"; });
    toggle.addEventListener("mouseleave", () => { toggle.style.background = "transparent"; });

    header.appendChild(toggle);
    wrapper.appendChild(header);
    wrapper.appendChild(list);
    return wrapper;
}

function buildPubPeerRow(state: PubPeerFeedback | null | "pending" | "unavailable", compact = false, retry?: () => void): HTMLElement {
    const feedback = typeof state === "string" ? null : state;
    const available = !!feedback && feedback.total_comments > 0;
    const subtitle = state === "pending"
        ? "Checking…"
        : state === "unavailable" ? "Unavailable" : available && feedback
            ? `${feedback.total_comments} ${feedback.total_comments === 1 ? "comment" : "comments"}`
            : "No discussion found";
    return buildRow({
        iconHtml: PUBPEER_HUB_SVG,
        accent: "#446058",
        available,
        title: "PubPeer",
        subtitle,
        subtitleShort: state === "pending" ? "…" : state === "unavailable" ? "Unavailable" : available && feedback ? `${feedback.total_comments}` : "—",
        href: feedback?.url,
        onAction: state === "unavailable" ? retry : undefined,
        actionLabel: state === "unavailable" ? "Retry" : "View thread",
        attr: "data-flora-pubpeer-row",
        compact,
    });
}

function buildBadgeRow(signal: BadgeSignal, compact = false): HTMLElement {
    return buildRow({
        iconHtml: DOT_ICON(signal.accent),
        accent: signal.accent,
        available: signal.available,
        title: signal.rowTitle,
        subtitle: signal.rowSubtitle,
        subtitleShort: signal.rowSubtitleShort,
        href: signal.href,
        actionLabel: signal.actionLabel,
        attr: "data-flora-badge-row",
        compact,
    });
}

export interface IndicatorPillOptions {
    doi: DoiString;
    /** Pill background colour — default matches confident/direct DOI extraction. */
    color?: string;
    /** True when the DOI came from Crossref/OpenAlex augmentation rather than direct extraction. */
    isAugmented?: boolean;
    /** Overrides the provenance line under the DOI (default: page vs. title match). */
    provenanceLabel?: string;
    /** Open Access lookup — resolves the padlock segment/row when it lands. */
    oaStatus?: Promise<OpenAccessStatus | null>;
    /** Already-resolved retraction/concern notice for this DOI, if any. */
    retraction?: RetractionResponse | null;
    /** Already-known replication count for this DOI, if any (pass only when > 0). Takes priority over reproductionsCount. */
    replicationsCount?: number | null;
    /** Already-known reproduction count for this DOI, if any (pass only when > 0). Shown only when replicationsCount is absent. */
    reproductionsCount?: number | null;
}

/** The DOI row: the DOI itself and the copy/cite/open actions. */
function buildDoiRow(
    doi: string,
    color: string,
    isAugmented: boolean,
    compact = false,
    provenanceLabel?: string
): HTMLElement {
    const contentRow = document.createElement("div");
    contentRow.style.cssText = `display: flex; align-items: center; gap: ${compact ? "5px" : "8px"}; padding: ${compact ? "1px 3px" : "5px 4px"};`;

    const doiIcon = document.createElement("span");
    doiIcon.style.cssText = rowIconWrapStyle(color, true, compact);
    doiIcon.innerHTML = DOI_LINK_SVG;
    contentRow.appendChild(doiIcon);

    const doiText = document.createElement("span");
    doiText.setAttribute("data-flora-doi-text", "");
    doiText.textContent = doi;
    doiText.title = provenanceLabel ?? (isAugmented ? SEARCH_PROVENANCE : PAGE_PROVENANCE);
    doiText.style.cssText = `
    flex: 1;
    min-width: 0;
    color: #1f2328;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    font-size: ${compact ? "11px" : "11.5px"};
    ${compact ? "" : "font-weight: 600;"}
    letter-spacing: 0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `;
    if (isAugmented) {
        doiText.style.textDecoration = "underline dotted";
        doiText.style.textUnderlineOffset = "2px";
    }

    const copyBtn = document.createElement("button");
    copyBtn.innerHTML = CLIPBOARD_SVG;
    copyBtn.title = "Copy DOI";
    copyBtn.style.cssText = ICON_BTN_STYLE;
    let copySuccess = false;
    copyBtn.addEventListener("mouseenter", () => {
        if (!copySuccess) copyBtn.style.color = color;
    });
    copyBtn.addEventListener("mouseleave", () => {
        if (!copySuccess) copyBtn.style.color = "#656d76";
    });
    copyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        copySuccess = true;
        copyBtn.innerHTML = CHECK_SVG;
        copyBtn.style.color = color;
        copyBtn.title = "Copied";
        const restoreIcon = (): void => {
            copySuccess = false;
            copyBtn.innerHTML = CLIPBOARD_SVG;
            copyBtn.style.color = copyBtn.matches(":hover") ? color : "#656d76";
            copyBtn.title = "Copy DOI";
        };
        void writeClipboard(doi).then((ok) => {
            if (ok) {
                showToast(`DOI copied — ${doi}`);
                setTimeout(restoreIcon, 1500);
            } else {
                // The optimistic check would otherwise confirm a copy that
                // never reached the clipboard.
                showToast("Couldn't copy the DOI", {tone: "error"});
                restoreIcon();
            }
        });
    });

    const externalLinkSvg = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="display:block;"><path d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z"></path></svg>`;

    const openLink = document.createElement("a");
    openLink.innerHTML = externalLinkSvg;
    openLink.href = `https://doi.org/${doi}`;
    openLink.target = "_blank";
    openLink.rel = "noopener noreferrer";
    openLink.title = "Open on doi.org";
    openLink.style.cssText = ICON_BTN_STYLE;
    openLink.addEventListener("mouseenter", () => {
        openLink.style.color = color;
    });
    openLink.addEventListener("mouseleave", () => {
        openLink.style.color = "#656d76";
    });
    openLink.addEventListener("click", (e) => {
        e.stopPropagation();
    });

    const actions = document.createElement("div");
    actions.style.cssText = `display: inline-flex; align-items: center; gap: ${compact ? "8px" : "10px"}; flex-shrink: 0;`;
    actions.appendChild(copyBtn);
    actions.appendChild(buildCiteButton(doi, color));
    actions.appendChild(openLink);

    contentRow.appendChild(doiText);
    contentRow.appendChild(actions);
    return contentRow;
}

/**
 * The cite action in the DOI row: copies this reference in the style chosen in
 * settings. Nothing is fetched until it is clicked, so a page of references
 * adds no requests unless a reader asks for one. The style is reported through
 * the button's tooltip — the row has no space for a status line — while the
 * fetch/copy outcome goes to a toast, which reaches a reader who has already
 * moved the pointer off the button.
 */
function buildCiteButton(doi: string, color: string): HTMLElement {
    const btn = document.createElement("button");
    btn.setAttribute("data-flora-citation-copy", "");
    btn.innerHTML = QUOTE_SVG;
    btn.style.cssText = ICON_BTN_STYLE;

    let idleTitle = "Copy citation";
    let flashing = false;
    let loadToken = 0;
    let titleTimer: ReturnType<typeof setTimeout> | null = null;

    const restore = (): void => {
        flashing = false;
        btn.innerHTML = QUOTE_SVG;
        btn.style.color = btn.matches(":hover") ? color : "#656d76";
        btn.title = idleTitle;
    };

    const setTitle = (text: string): void => {
        if (titleTimer) {
            clearTimeout(titleTimer);
            titleTimer = null;
        }
        btn.title = text;
    };

    const flash = (iconHtml: string, text: string): void => {
        flashing = true;
        btn.innerHTML = iconHtml;
        btn.style.color = color;
        setTitle(text);
        titleTimer = setTimeout(restore, 1500);
    };

    const showStyle = (format: CitationFormat): void => {
        idleTitle = format.verbatim
            ? `Copy this reference as ${format.label} — change the style in ORE's settings`
            : `Copy this reference in ${format.label}, formatting included — change the style in ORE's settings`;
        if (!flashing) btn.title = idleTitle;
    };

    void preferredCitationFormat().then(showStyle);

    btn.addEventListener("mouseenter", () => {
        if (!flashing) btn.style.color = color;
    });
    btn.addEventListener("mouseleave", () => {
        if (!flashing) btn.style.color = "#656d76";
    });

    // Re-read the preference on every copy: the reader may have changed it in
    // settings while this page stayed open.
    const copyCitation = async (): Promise<void> => {
        const token = ++loadToken;
        const format = await preferredCitationFormat();
        if (token !== loadToken) return;
        showStyle(format);
        setTitle("Fetching…");
        // The fetch is a network round trip — say so, rather than leaving the
        // reader wondering whether the click registered.
        showToast(`Fetching ${format.label} citation…`, {tone: "pending", duration: 0});
        const {citation, reachable} = await fetchCitationDetailed(doi, format.id);
        if (token !== loadToken) return;
        if (!citation) {
            flash(QUOTE_SVG, reachable ? "Citation unavailable" : "Couldn't reach Crossref");
            showToast(
                reachable
                    ? `No ${format.label} citation available for this DOI`
                    : "Couldn't reach Crossref — check your connection and try again",
                {tone: "error"}
            );
            return;
        }
        const copied = citation.html
            ? await writeRichClipboard(citation.html, citation.text)
            : await writeClipboard(citation.text);
        if (token !== loadToken) return;
        if (!copied) {
            flash(QUOTE_SVG, "Copy failed");
            showToast("Couldn't copy the citation", {tone: "error"});
            return;
        }
        flash(CHECK_SVG, "Copied");
        showToast(`${format.label} citation copied`);
    };

    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        // The "fetching" toast stays up until it is replaced, so a rejection
        // anywhere in the chain (storage, settings) must still land on a
        // terminal toast rather than leave the spinner running forever.
        void copyCitation().catch(() => {
            flash(QUOTE_SVG, "Citation unavailable");
            showToast("Couldn't fetch the citation", {tone: "error"});
        });
    });

    return btn;
}

interface IndicatorRowsOptions {
    doi: DoiString;
    color: string;
    isAugmented: boolean;
    provenanceLabel?: string;
    oaStatus?: Promise<OpenAccessStatus | null>;
    retraction: RetractionResponse | null;
    replicationsCount: number | null;
    reproductionsCount: number | null;
    /** Called when the async lookup lands, so a caller can mirror it elsewhere. */
    onOa?: (oa: OpenAccessStatus | null) => void;
    onPubPeer?: (feedback: PubPeerFeedback | null, answered: boolean | "pending") => void;
    /** Single-line rows and tighter metrics, for the always-visible panel. */
    compact?: boolean;
}

/**
 * The row stack shared by the pill's popover and the standalone panel: DOI,
 * Open Access, PubPeer, replication/retraction. The OA and PubPeer rows start
 * unresolved and swap themselves in when their lookups land; the DOI row's
 * cite action fetches nothing until a reader clicks it.
 */
function buildIndicatorRows(opts: IndicatorRowsOptions): HTMLElement {
    const compact = opts.compact ?? false;
    const rows = document.createElement("div");
    rows.style.cssText = `display:flex;flex-direction:column;gap:${compact ? "0" : "2px"};`;

    rows.appendChild(buildDoiRow(opts.doi, opts.color, opts.isAugmented, compact, opts.provenanceLabel));

    const sectionDivider = document.createElement("div");
    sectionDivider.style.cssText = `height:1px;background:#eaeef2;margin:${compact ? "2px 0" : "0 0 2px"};`;
    rows.appendChild(sectionDivider);

    let oaRow = buildOaRow(opts.oaStatus ? "pending" : null, compact, () => retryOa());
    rows.appendChild(oaRow);
    const settleOa = (state: OaState, oa: OpenAccessStatus | null): void => {
        const resolved = shieldFromPageCss(buildOaRow(state, compact, retryOa));
        replaceIndicatorRow(oaRow, resolved);
        oaRow = resolved;
        opts.onOa?.(oa);
    };
    const loadOa = (request: Promise<OpenAccessStatus | null>): void => {
        void request.then(async oa => settleOa(oa ?? (await hasContactEmail() ? null : "no-email"), oa))
            .catch(() => settleOa(null, null));
    };
    const retryOa = (): void => {
        settleOa("pending", null);
        loadOa(fetchOpenAccess(opts.doi));
    };
    if (opts.oaStatus) loadOa(opts.oaStatus);

    let pubpeerRow = buildPubPeerRow("pending", compact);
    rows.appendChild(pubpeerRow);
    const settlePubPeer = (feedback: PubPeerFeedback | null | "unavailable" | "pending"): void => {
        const resolved = shieldFromPageCss(buildPubPeerRow(feedback, compact, retryPubPeer));
        replaceIndicatorRow(pubpeerRow, resolved);
        pubpeerRow = resolved;
        opts.onPubPeer?.(typeof feedback === "string" ? null : feedback, feedback === "pending" ? "pending" : typeof feedback !== "string");
    };
    const retryPubPeer = (): void => {
        settlePubPeer("pending");
        void lookupPubPeerForDoi(opts.doi).then(settlePubPeer).catch(error => {
            settlePubPeer("unavailable");
            if (typeof error?.retryAfterMs === "number") {
                const subtitle = pubpeerRow.querySelector("[data-flora-row-sub]");
                if (subtitle) subtitle.textContent = compact ? "Rate limited" : `Rate limited — try again in ${Math.ceil(error.retryAfterMs / 1000)} seconds`;
            }
        });
    };
    retryPubPeer();

    rows.appendChild(buildBadgeRow(resolveBadgeSignal(
        opts.doi, opts.retraction, opts.replicationsCount, opts.reproductionsCount
    ), compact));
    return shieldFromPageCss(rows);
}

/**
 * Build the merged FLoRA indicator pill: DOI content + Open Access padlock +
 * PubPeer marker + retraction/replication badge, each segment split by a
 * divider. Unavailable segments render dimmed rather than being removed, so
 * the pill's shape stays stable as async data lands. Hovering (or clicking,
 * to pin) the pill opens a popover with one interactive row per segment.
 */
function pillAriaLabel(
    doi: string,
    retraction: RetractionResponse | null,
    replications: number | null,
    reproductions: number | null,
): string {
    const parts: string[] = [];
    if (retraction) {
        parts.push(retraction.kind === "concern" ? "expression of concern" : "retracted");
    }
    const studies = (replications ?? 0) + (reproductions ?? 0);
    if (studies > 0) parts.push(`${studies} replication or reproduction ${studies === 1 ? "study" : "studies"}`);
    const summary = parts.length > 0 ? parts.join(", ") : "no flags yet";
    return `Open research details for ${doi}: ${summary}. Press Enter for more.`;
}

export function createIndicatorPill(options: IndicatorPillOptions): HTMLElement {
    ensureFocusStyle();
    const {doi, color = "#853953", isAugmented = false, provenanceLabel, oaStatus, retraction = null, replicationsCount = null, reproductionsCount = null} = options;

    const wrapper = document.createElement("span");
    wrapper.className = INDICATOR_PILL_CLASS;
    wrapper.setAttribute("data-flora-doi", doi);
    // The popover prints the DOI and links it to doi.org; without this marker
    // the extractor rescans that as a page occurrence and pills it again.
    wrapper.setAttribute("data-flora-ui", "");
    // Centred on the text it annotates, with a gap before it. The gap is
    // `margin-inline-start` so it mirrors on RTL pages, declared after the
    // physical margins so it wins the cascade on either side; the physical
    // zeroes are declared here (rather than left to shieldFromPageCss) so
    // that the gap survives. See PILL_WRAPPER_STYLE for the alignment.
    wrapper.style.cssText = PILL_WRAPPER_STYLE;

    const pill = document.createElement("span");
    pill.setAttribute("role", "button");
    pill.setAttribute("tabindex", "0");
    pill.setAttribute("aria-haspopup", "dialog");
    pill.setAttribute("aria-expanded", "false");
    pill.setAttribute("aria-label", pillAriaLabel(doi, retraction, replicationsCount, reproductionsCount));
    pill.style.cssText = `
    display: inline-flex;
    align-items: center;
    font-size: 12px;
    font-weight: 500;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: white;
    background: ${color};
    opacity: 0.75;
    padding: 2px 8px 2px 10px;
    border-radius: 20px;
    cursor: pointer;
    user-select: none;
    line-height: 18px;
    letter-spacing: 0.02em;
    box-shadow: 0 0 0 0 rgba(0,0,0,0);
    transition: opacity 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
  `;
    pill.addEventListener("mouseenter", () => {
        pill.style.opacity = "1";
        pill.style.boxShadow = "0 1px 2px rgba(27,31,36,0.12), 0 2px 6px rgba(66,74,83,0.14)";
        pill.style.transform = "translateY(-1px)";
    });
    pill.addEventListener("mouseleave", () => {
        pill.style.opacity = "0.75";
        pill.style.boxShadow = "0 0 0 0 rgba(0,0,0,0)";
        pill.style.transform = "translateY(0)";
    });

    // Segment 1 — DOI content.
    const doiSegment = document.createElement("span");
    doiSegment.setAttribute("data-flora-doi-segment", "");
    if (isAugmented) {
        doiSegment.textContent = "DOI";
        doiSegment.style.cssText = "text-decoration: underline dotted; text-underline-offset: 2px; text-decoration-thickness: 1px;";
    } else {
        const checkSvg = `<svg width="12" height="12" viewBox="0 0 16 16" fill="white" style="display:inline-block;vertical-align:middle;"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"></path></svg>`;
        doiSegment.style.cssText = "display:inline-flex;align-items:center;gap:4px;";
        doiSegment.innerHTML = `DOI ${checkSvg}`;
    }
    pill.appendChild(doiSegment);

    // Segment 2 — Open Access padlock (async).
    pill.appendChild(makeDivider());
    let oaSegment = buildOaSegment(null);
    pill.appendChild(oaSegment);

    // Segment 3 — PubPeer marker (async, fetched internally so callers don't
    // each need to import pubpeer-api.ts; per-pill lookups are coalesced into
    // one batch request and cached).
    pill.appendChild(makeDivider());
    let pubpeerSegment = buildPubPeerSegment(null);
    pill.appendChild(pubpeerSegment);

    // Segment 4 — retraction/replication badge (already-resolved inputs).
    pill.appendChild(makeDivider());
    const badgeSegment = buildBadgeSegment(resolveBadgeSignal(doi, retraction, replicationsCount, reproductionsCount));
    pill.appendChild(badgeSegment);

    // ── Popover — one interactive row per segment, plus DOI copy/open ──
    const popover = document.createElement("div");
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", `Open research details for ${doi}`);
    popover.setAttribute("data-flora-popover", "");
    // position:fixed (not absolute) so the popover is positioned against the
    // viewport — an ancestor with overflow:hidden (common on article content
    // columns) would otherwise clip it. Coordinates are set in show().
    popover.style.cssText = `
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    min-width: 230px;
    background: #ffffff;
    border: 1px solid ${color}40;
    border-radius: 12px;
    box-shadow: 0 1px 2px rgba(27,31,36,0.08), 0 4px 16px rgba(66,74,83,0.10);
    padding: 8px;
    z-index: 2147483647;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 12px;
    line-height: 18px;
    flex-direction: column;
    gap: 2px;
  `;

    popover.appendChild(buildIndicatorRows({
        doi, color, isAugmented, provenanceLabel, oaStatus, retraction, replicationsCount, reproductionsCount,
        // The pill mirrors each resolved row into its matching inline segment.
        onOa: (oa) => {
            const resolved = buildOaSegment(oa);
            oaSegment.replaceWith(resolved);
            oaSegment = resolved;
        },
        onPubPeer: (feedback, answered) => {
            const resolved = buildPubPeerSegment(feedback, answered);
            pubpeerSegment.replaceWith(resolved);
            pubpeerSegment = resolved;
        },
    }));

    let hideTimeout: ReturnType<typeof setTimeout> | null = null;
    let pinned = false;
    let docClickHandler: ((e: MouseEvent) => void) | null = null;

    const show = () => {
        if (hideTimeout) {
            clearTimeout(hideTimeout);
            hideTimeout = null;
        }
        // Reveal first so the popover has measurable dimensions.
        shieldFromPageCss(popover);
        popover.style.display = "flex";
        pill.setAttribute("aria-expanded", "true");

        const gap = 8;
        const margin = 4;
        const pillRect = pill.getBoundingClientRect();
        const popRect = popover.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        const spaceRight = vw - pillRect.right - gap;
        const spaceLeft = pillRect.left - gap;
        const spaceBelow = vh - pillRect.bottom - gap;
        const spaceAbove = pillRect.top - gap;

        // Prefer opening to the right, then left, then below, then above —
        // falling back to whichever side has the most room.
        let left = 0;
        let top = 0;
        const placeRight = () => { left = pillRect.right + gap; top = pillRect.top; };
        const placeLeft = () => { left = pillRect.left - gap - popRect.width; top = pillRect.top; };
        const placeBelow = () => { left = pillRect.left; top = pillRect.bottom + gap; };
        const placeAbove = () => { left = pillRect.left; top = pillRect.top - gap - popRect.height; };

        if (spaceRight >= popRect.width) placeRight();
        else if (spaceLeft >= popRect.width) placeLeft();
        else if (spaceBelow >= popRect.height) placeBelow();
        else if (spaceAbove >= popRect.height) placeAbove();
        else {
            const best = Math.max(spaceRight, spaceLeft, spaceBelow, spaceAbove);
            if (best === spaceRight) placeRight();
            else if (best === spaceLeft) placeLeft();
            else if (best === spaceBelow) placeBelow();
            else placeAbove();
        }

        // Clamp into the viewport so the popover is never cut off.
        left = Math.max(margin, Math.min(left, vw - popRect.width - margin));
        top = Math.max(margin, Math.min(top, vh - popRect.height - margin));
        popover.style.left = `${left}px`;
        popover.style.top = `${top}px`;
        popover.style.right = "auto";
        popover.style.bottom = "auto";
    };
    const hide = () => {
        if (pinned) return;
        hideTimeout = setTimeout(() => {
            popover.style.display = "none";
            pill.setAttribute("aria-expanded", "false");
        }, 200);
    };

    const unpin = () => {
        if (!pinned) return;
        pinned = false;
        pill.style.outline = "";
        pill.style.outlineOffset = "";
        if (docClickHandler) {
            document.removeEventListener("click", docClickHandler, {capture: true});
            docClickHandler = null;
        }
        hide();
    };

    pill.addEventListener("click", (e) => {
        e.stopPropagation();
        if (pinned) {
            unpin();
            return;
        }
        pinned = true;
        pill.style.outline = `2px solid ${color}60`;
        pill.style.outlineOffset = "1px";
        show();
        // Defer so this same click doesn't immediately trigger the doc handler.
        setTimeout(() => {
            docClickHandler = (ev: MouseEvent) => {
                // isConnected: a hydrating SPA can wipe a pinned pill, stranding
                // this listener on `document` with nothing left to unpin it.
                if (!wrapper.isConnected || !wrapper.contains(ev.target as Node)) unpin();
            };
            document.addEventListener("click", docClickHandler, {capture: true});
        }, 0);
    });

    pill.addEventListener("mouseenter", show);
    pill.addEventListener("mouseleave", hide);
    popover.addEventListener("mouseenter", show);
    popover.addEventListener("mouseleave", hide);

    pill.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
            e.preventDefault();
            pill.click();
        } else if (e.key === "Escape" && pinned) {
            unpin();
            pill.focus();
        }
    });

    wrapper.addEventListener("focusin", show);
    wrapper.addEventListener("focusout", (e) => {
        if (!wrapper.contains(e.relatedTarget as Node | null)) hide();
    });
    popover.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        unpin();
        pill.focus();
    });

    wrapper.appendChild(pill);
    wrapper.appendChild(popover);
    return shieldFromPageCss(wrapper);
}

/**
 * Refresh the retraction/replication badge segment and popover row on every
 * merged pill under `root` once fresher `pageState`/`redacts` data lands.
 * Idempotent — safe to call repeatedly (e.g. alongside the title pill's
 * re-placement passes).
 */
const PANEL_STYLE_ID = "flora-indicator-panel-style";

/**
 * The panel's status text sits beside its heading, so it stays on one line and
 * ellipsises rather than pushing the row taller.
 *
 * This is a stylesheet rather than inline styles because the OA, PubPeer and
 * badge rows replace themselves when their lookups land; a rule keyed on the
 * panel keeps applying to whatever is swapped in.
 */
function ensurePanelStyle(): void {
    if (document.getElementById(PANEL_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = PANEL_STYLE_ID;
    // Layout defaults live here rather than inline so a site stylesheet (see
    // content-search/sites/*.css) can override them with an ordinary selector.
    style.textContent =
        `[data-flora-panel]{max-width:260px;margin-top:4px;}` +
        `[data-flora-panel] [data-flora-row-sub]{flex-shrink:0;}`;
    (document.head ?? document.documentElement).appendChild(style);
}

/**
 * The pill's rows rendered inline as a standalone card, for surfaces with the
 * room to show them outright instead of behind a hover (Google Scholar's result
 * rows). Carries the same class, DOI attribute and badge-row marker as the
 * pill, so updateIndicatorPillBadges refreshes it identically.
 */
export function createIndicatorPanel(options: IndicatorPillOptions): HTMLElement {
    const {
        doi, color = "#853953", isAugmented = false, provenanceLabel, oaStatus,
        retraction = null, replicationsCount = null, reproductionsCount = null,
    } = options;

    const wrapper = document.createElement("div");
    wrapper.className = INDICATOR_PILL_CLASS;
    wrapper.setAttribute("data-flora-doi", doi);
    wrapper.setAttribute("data-flora-ui", "");
    wrapper.setAttribute("data-flora-panel", "");
    wrapper.style.cssText = `
    display: block;
    box-sizing: border-box;
    background: #ffffff;
    border: 1px solid ${color}40;
    border-radius: 8px;
    box-shadow: 0 1px 2px rgba(27,31,36,0.08);
    padding: 4px 5px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 12px;
    line-height: 16px;
    text-align: left;
  `;

    ensurePanelStyle();
    wrapper.appendChild(buildIndicatorRows({
        doi, color, isAugmented, provenanceLabel, oaStatus, retraction, replicationsCount, reproductionsCount,
        compact: true,
    }));
    return resetInheritedText(wrapper);
}

export function updateIndicatorPillBadges(
    root: ParentNode,
    pageState: Map<DoiString, LookupState>,
    redacts: readonly RetractionResponse[],
    scope: IndicatorScope = "pills",
    onlyDoi?: DoiString
): void {
    const retractionByDoi = new Map(redacts.map((r) => [r.originDoi, r] as const));
    for (const wrapper of root.querySelectorAll<HTMLElement>(indicatorSelector(scope))) {
        const doi = wrapper.getAttribute("data-flora-doi") as DoiString | null;
        if (!doi || (onlyDoi && doi !== onlyDoi)) continue;
        const badgeSegment = wrapper.querySelector<HTMLElement>("[data-flora-badge-segment]");
        const badgeRow = wrapper.querySelector<HTMLElement>("[data-flora-badge-row]");
        if (!badgeSegment && !badgeRow) continue;

        const retraction = retractionByDoi.get(doi) ?? null;
        const state = pageState.get(doi);
        const replicationsCount = state?.status === "matched" ? state.result.record.stats.n_replications_total : null;
        const reproductionsCount = state?.status === "matched" ? state.result.record.stats.n_reproductions_total : null;
        const signal = resolveBadgeSignal(doi, retraction, replicationsCount, reproductionsCount);

        if (!retraction && (state?.status === "error" || state?.status === "loading")) {
            signal.rowSubtitle = state.status === "loading" ? "Checking FORRT…" : "FORRT unavailable";
        }
        if (badgeSegment) badgeSegment.replaceWith(buildBadgeSegment(signal));
        if (badgeRow && !retraction && (state?.status === "error" || state?.status === "loading")) {
            const pending = state.status === "loading";
            const retry = async () => {
                const next = pageState;
                next.set(doi, {status: "loading"});
                updateIndicatorPillBadges(root, next, redacts, scope, doi);
                try {
                    const response = await safeSendMessage<LookupResponse>({type: "FLORA_LOOKUP", dois: [doi]});
                    if (!response || response.errors?.[doi]) throw new Error("FORRT unavailable");
                    const result = response.results[doi];
                    next.set(doi, result ? {status: "matched", result, source: "extracted"} : {status: "no-match"});
                } catch {
                    next.set(doi, {status: "error", message: "FORRT unavailable"});
                }
                updateIndicatorPillBadges(root, next, redacts, scope, doi);
            };
            replaceIndicatorRow(badgeRow, shieldFromPageCss(buildRow({
                iconHtml: DOT_ICON("#853953"), accent: "#853953", available: false,
                title: "FORRT", subtitle: pending ? "Checking…" : "Unavailable",
                actionLabel: "Retry", onAction: pending ? undefined : () => { void retry(); },
                attr: "data-flora-badge-row", compact: wrapper.hasAttribute("data-flora-panel"),
            })));
        } else if (badgeRow) {
            replaceIndicatorRow(badgeRow, shieldFromPageCss(buildBadgeRow(signal, wrapper.hasAttribute("data-flora-panel"))));
        }
    }
}
