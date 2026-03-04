import type { LookupState } from "../shared/types";
import styles from "./styles.css";

const BADGE_HOST_CLASS = "flora-scholar-badge-host";

export function renderScholarBadge(
  row: HTMLElement,
  state: LookupState
): void {
  if (state.status !== "matched") return;
  if (row.querySelector(`.${BADGE_HOST_CLASS}`)) return;

  const r = state.result;
  const stats = r.record.stats;
  const badgeClass = stats.n_replications_total > 0
    ? "badge--success"
    : "badge--neutral";

  const titleEl = row.querySelector(".gs_rt");
  if (!titleEl) return;

  const host = document.createElement("div");
  host.className = BADGE_HOST_CLASS;

  const shadow = host.attachShadow({ mode: "open" });

  const styleEl = document.createElement("style");
  styleEl.textContent = styles;
  shadow.appendChild(styleEl);

  const badge = document.createElement("a");
  badge.className = `flora-scholar-badge ${badgeClass}`;
  badge.href = `https://forrt.org/fred_repl_landing_page/?doi=${encodeURIComponent(r.doi)}`;
  badge.target = "_blank";
  badge.rel = "noopener";
  badge.innerHTML = `
    <span class="badge-label">FLoRA</span>
    <span class="badge-count">${stats.n_replications_total} repl</span>
    ${stats.n_reproductions_total > 0 ? `<span class="badge-count">${stats.n_reproductions_total} repro</span>` : ""}
  `;

  shadow.appendChild(badge);
  titleEl.insertAdjacentElement("afterend", host);
}
