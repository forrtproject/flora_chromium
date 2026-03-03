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
  const badgeClass = r.has_failed_replication
    ? "badge--warning"
    : "badge--success";

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
  badge.href = r.flora_url;
  badge.target = "_blank";
  badge.rel = "noopener";
  badge.innerHTML = `
    <span class="badge-label">FLoRA</span>
    <span class="badge-count">${r.replication_count} repl</span>
    ${r.reproduction_count > 0 ? `<span class="badge-count">${r.reproduction_count} repro</span>` : ""}
    ${r.has_failed_replication ? '<span class="badge-alert">failed replication</span>' : ""}
  `;

  shadow.appendChild(badge);
  titleEl.insertAdjacentElement("afterend", host);
}
