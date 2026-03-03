import type { DoiString, LookupState } from "../shared/types";
import { normaliseDOI } from "../shared/doi-normalise";
import styles from "./styles.css";

const BANNER_HOST_ID = "flora-banner-host";
const BADGE_CLASS = "flora-inline-badge";

// Store shadow root reference since we use open mode
let bannerShadow: ShadowRoot | null = null;

// ──────────────────────────────────────────────
// Banner
// ──────────────────────────────────────────────

export function renderBanner(_doi: DoiString, state: LookupState): void {
  let host = document.getElementById(BANNER_HOST_ID);

  if (!host) {
    host = document.createElement("div");
    host.id = BANNER_HOST_ID;
    bannerShadow = host.attachShadow({ mode: "open" });

    const styleEl = document.createElement("style");
    styleEl.textContent = styles;
    bannerShadow.appendChild(styleEl);

    const container = document.createElement("div");
    container.className = "flora-banner";
    bannerShadow.appendChild(container);

    document.body.prepend(host);
    adjustPageForBanner();
  }

  const shadow = bannerShadow ?? host.shadowRoot!;
  const container = shadow.querySelector(".flora-banner")!;

  switch (state.status) {
    case "loading":
      container.innerHTML = `
        <div class="flora-banner-inner flora-banner--loading">
          <span class="flora-logo">FLoRA</span>
          <span class="flora-banner-text">Checking replication data\u2026</span>
        </div>`;
      break;

    case "matched": {
      const r = state.result;
      const cls = r.has_failed_replication
        ? "flora-banner--warning"
        : "flora-banner--success";
      container.innerHTML = `
        <div class="flora-banner-inner ${cls}">
          <span class="flora-logo">FLoRA</span>
          <span class="flora-banner-text">
            ${r.replication_count} replication(s), ${r.reproduction_count} reproduction(s)${r.has_failed_replication ? " \u2014 includes failed replications" : ""}
          </span>
          <a class="flora-banner-link" href="${escapeAttr(r.flora_url)}" target="_blank" rel="noopener">View on FLoRA</a>
          <button class="flora-banner-close" aria-label="Close">\u00d7</button>
        </div>`;
      shadow
        .querySelector(".flora-banner-close")
        ?.addEventListener("click", () => removeBanner());
      break;
    }

    case "error":
      container.innerHTML = `
        <div class="flora-banner-inner flora-banner--error">
          <span class="flora-logo">FLoRA</span>
          <span class="flora-banner-text">Error: ${escapeHtml(state.message)}</span>
          <button class="flora-banner-close" aria-label="Close">\u00d7</button>
        </div>`;
      shadow
        .querySelector(".flora-banner-close")
        ?.addEventListener("click", () => removeBanner());
      break;

    case "no-match":
    case "idle":
      removeBanner();
      break;
  }
}

export function removeBanner(): void {
  const host = document.getElementById(BANNER_HOST_ID);
  if (host) {
    host.remove();
    bannerShadow = null;
    restorePageAfterBanner();
  }
}

const BANNER_HEIGHT = 40;

function adjustPageForBanner(): void {
  document.body.style.setProperty(
    "margin-top",
    `${BANNER_HEIGHT}px`,
    "important"
  );
}

function restorePageAfterBanner(): void {
  document.body.style.removeProperty("margin-top");
}

// ──────────────────────────────────────────────
// Inline badges
// ──────────────────────────────────────────────

export function renderInlineBadges(
  pageState: Map<DoiString, LookupState>
): void {
  const allLinks = document.querySelectorAll<HTMLAnchorElement>("a[href]");

  for (const link of allLinks) {
    if (link.nextElementSibling?.classList.contains(BADGE_CLASS)) continue;

    const hrefMatch = link.href.match(/\b(10\.\d{4,}(?:\.\d+)*\/\S+)\b/);
    if (!hrefMatch) continue;

    const doi = normaliseDOI(hrefMatch[1]);
    if (!doi) continue;

    const state = pageState.get(doi);
    if (!state || state.status !== "matched") continue;

    if (!isVisible(link)) continue;

    const r = state.result;
    const badgeClass = r.has_failed_replication
      ? "badge--warning"
      : "badge--success";

    const badgeHost = document.createElement("span");
    badgeHost.className = BADGE_CLASS;
    const shadow = badgeHost.attachShadow({ mode: "open" });

    const styleEl = document.createElement("style");
    styleEl.textContent = styles;
    shadow.appendChild(styleEl);

    const badge = document.createElement("a");
    badge.className = `flora-badge ${badgeClass}`;
    badge.href = r.flora_url;
    badge.target = "_blank";
    badge.rel = "noopener";
    badge.title = `FLoRA: ${r.replication_count} replication(s), ${r.reproduction_count} reproduction(s)`;
    badge.innerHTML = `<span class="badge-icon">F</span> ${r.replication_count}R`;
    shadow.appendChild(badge);

    link.insertAdjacentElement("afterend", badgeHost);
  }
}

function isVisible(el: HTMLElement): boolean {
  const style = window.getComputedStyle(el);
  // offsetParent is null in jsdom; treat null offsetParent as visible
  // unless display is explicitly "none"
  return style.display !== "none" && style.visibility !== "hidden";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[c] ?? c;
  });
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
