import { describe, it, expect, beforeEach } from "vitest";
import type { ReplicationResult } from "../../src/shared/types";
import { renderScholarBadge } from "../../src/content-scholar/badge";

const MOCK_RESULT: ReplicationResult = {
  doi: "10.1038/nature12373",
  replication_count: 3,
  reproduction_count: 1,
  has_failed_replication: false,
  flora_url: "https://flora.research.example/10.1038/nature12373",
  last_updated: "2024-01-15T00:00:00Z",
};

describe("renderScholarBadge", () => {
  let row: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    row = document.createElement("div");
    row.classList.add("gs_r", "gs_or", "gs_scl");
    row.innerHTML = `
      <div class="gs_ri">
        <h3 class="gs_rt"><a href="#">Title</a></h3>
        <div class="gs_a">Authors</div>
      </div>
    `;
    document.body.appendChild(row);
  });

  it("inserts a Shadow DOM badge after .gs_rt", () => {
    renderScholarBadge(row, { status: "matched", result: MOCK_RESULT });

    const host = row.querySelector(".flora-scholar-badge-host");
    expect(host).not.toBeNull();
    expect(host?.shadowRoot).not.toBeNull();

    const badge = host?.shadowRoot?.querySelector(".flora-scholar-badge");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain("3 repl");
  });

  it("does not double-render badges", () => {
    renderScholarBadge(row, { status: "matched", result: MOCK_RESULT });
    renderScholarBadge(row, { status: "matched", result: MOCK_RESULT });

    const hosts = row.querySelectorAll(".flora-scholar-badge-host");
    expect(hosts).toHaveLength(1);
  });

  it("shows warning class for failed replications", () => {
    const failedResult = { ...MOCK_RESULT, has_failed_replication: true };
    renderScholarBadge(row, { status: "matched", result: failedResult });

    const host = row.querySelector(".flora-scholar-badge-host");
    const badge = host?.shadowRoot?.querySelector(".flora-scholar-badge");
    expect(badge?.classList.contains("badge--warning")).toBe(true);
    expect(badge?.textContent).toContain("failed replication");
  });

  it("shows success class for clean replications", () => {
    renderScholarBadge(row, { status: "matched", result: MOCK_RESULT });

    const host = row.querySelector(".flora-scholar-badge-host");
    const badge = host?.shadowRoot?.querySelector(".flora-scholar-badge");
    expect(badge?.classList.contains("badge--success")).toBe(true);
  });

  it("does nothing for non-matched states", () => {
    renderScholarBadge(row, { status: "no-match" });
    expect(row.querySelector(".flora-scholar-badge-host")).toBeNull();
  });

  it("does nothing if row has no .gs_rt element", () => {
    const emptyRow = document.createElement("div");
    renderScholarBadge(emptyRow, { status: "matched", result: MOCK_RESULT });
    expect(emptyRow.querySelector(".flora-scholar-badge-host")).toBeNull();
  });
});
