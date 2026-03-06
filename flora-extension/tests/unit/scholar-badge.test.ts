import { describe, it, expect, beforeEach } from "vitest";
import { renderScholarBadge } from "../../src/content-scholar/badge";
import { mockResult } from "../helpers";

const MOCK_RESULT = mockResult();

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
    expect(badge?.textContent).toContain("3 replications");
  });

  it("does not double-render badges", () => {
    renderScholarBadge(row, { status: "matched", result: MOCK_RESULT });
    renderScholarBadge(row, { status: "matched", result: MOCK_RESULT });

    const hosts = row.querySelectorAll(".flora-scholar-badge-host");
    expect(hosts).toHaveLength(1);
  });

  it("shows success class when replications exist", () => {
    renderScholarBadge(row, { status: "matched", result: MOCK_RESULT });

    const host = row.querySelector(".flora-scholar-badge-host");
    const badge = host?.shadowRoot?.querySelector(".flora-scholar-badge");
    expect(badge?.classList.contains("badge--success")).toBe(true);
  });

  it("shows neutral class when only originals (no replications or reproductions)", () => {
    const noReplResult = mockResult();
    noReplResult.record.stats.n_replications_total = 0;
    noReplResult.record.stats.n_reproductions_total = 0;
    noReplResult.record.stats.n_originals_total = 5;
    renderScholarBadge(row, { status: "matched", result: noReplResult });

    const host = row.querySelector(".flora-scholar-badge-host");
    const badge = host?.shadowRoot?.querySelector(".flora-scholar-badge");
    expect(badge?.classList.contains("badge--neutral")).toBe(true);
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
