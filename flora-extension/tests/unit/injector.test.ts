import { describe, it, expect, beforeEach } from "vitest";
import type { DoiString, LookupState, ReplicationResult } from "../../src/shared/types";
import { renderBanner, removeBanner, renderInlineBadges } from "../../src/content-general/injector";

function doi(s: string): DoiString {
  return s as DoiString;
}

const MOCK_RESULT: ReplicationResult = {
  doi: "10.1038/nature12373",
  replication_count: 3,
  reproduction_count: 1,
  has_failed_replication: false,
  flora_url: "https://flora.research.example/10.1038/nature12373",
  last_updated: "2024-01-15T00:00:00Z",
};

describe("injector", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.body.style.removeProperty("margin-top");
  });

  describe("renderBanner", () => {
    it("creates a Shadow DOM host when rendering loading state", () => {
      renderBanner(doi("10.1038/nature12373"), { status: "loading" });

      const host = document.getElementById("flora-banner-host");
      expect(host).not.toBeNull();
      expect(host?.shadowRoot).not.toBeNull();

      const bannerText = host?.shadowRoot?.querySelector(".flora-banner-text");
      expect(bannerText?.textContent).toContain("Checking");
    });

    it("updates banner content on matched state", () => {
      renderBanner(doi("10.1038/nature12373"), { status: "loading" });
      renderBanner(doi("10.1038/nature12373"), {
        status: "matched",
        result: MOCK_RESULT,
      });

      const host = document.getElementById("flora-banner-host");
      const bannerText = host?.shadowRoot?.querySelector(".flora-banner-text");
      expect(bannerText?.textContent).toContain("3 replication(s)");
      expect(bannerText?.textContent).toContain("1 reproduction(s)");
    });

    it("shows warning class for failed replications", () => {
      const failedResult = { ...MOCK_RESULT, has_failed_replication: true };
      renderBanner(doi("10.1038/nature12373"), {
        status: "matched",
        result: failedResult,
      });

      const host = document.getElementById("flora-banner-host");
      const inner = host?.shadowRoot?.querySelector(".flora-banner-inner");
      expect(inner?.classList.contains("flora-banner--warning")).toBe(true);
    });

    it("shows error state", () => {
      renderBanner(doi("10.1038/nature12373"), {
        status: "error",
        message: "API failed",
      });

      const host = document.getElementById("flora-banner-host");
      const inner = host?.shadowRoot?.querySelector(".flora-banner-inner");
      expect(inner?.classList.contains("flora-banner--error")).toBe(true);
      expect(inner?.textContent).toContain("API failed");
    });

    it("adjusts body margin-top for banner space", () => {
      renderBanner(doi("10.1038/nature12373"), { status: "loading" });
      expect(document.body.style.marginTop).toBe("40px");
    });
  });

  describe("removeBanner", () => {
    it("removes the banner host element", () => {
      renderBanner(doi("10.1038/nature12373"), { status: "loading" });
      expect(document.getElementById("flora-banner-host")).not.toBeNull();

      removeBanner();
      expect(document.getElementById("flora-banner-host")).toBeNull();
    });

    it("restores body margin-top", () => {
      renderBanner(doi("10.1038/nature12373"), { status: "loading" });
      removeBanner();
      expect(document.body.style.marginTop).toBe("");
    });
  });

  describe("renderInlineBadges", () => {
    it("inserts badge after DOI links", () => {
      document.body.innerHTML = `
        <a href="https://doi.org/10.1038/nature12373">Paper link</a>
      `;

      const state = new Map<DoiString, LookupState>();
      state.set(doi("10.1038/nature12373"), {
        status: "matched",
        result: MOCK_RESULT,
      });

      renderInlineBadges(state);

      const badge = document.querySelector(".flora-inline-badge");
      expect(badge).not.toBeNull();
      expect(badge?.shadowRoot).not.toBeNull();
    });

    it("does not duplicate badges on second call", () => {
      document.body.innerHTML = `
        <a href="https://doi.org/10.1038/nature12373">Paper link</a>
      `;

      const state = new Map<DoiString, LookupState>();
      state.set(doi("10.1038/nature12373"), {
        status: "matched",
        result: MOCK_RESULT,
      });

      renderInlineBadges(state);
      renderInlineBadges(state);

      const badges = document.querySelectorAll(".flora-inline-badge");
      expect(badges).toHaveLength(1);
    });

    it("skips links without DOIs", () => {
      document.body.innerHTML = `
        <a href="https://example.com/page">Regular link</a>
      `;

      const state = new Map<DoiString, LookupState>();
      renderInlineBadges(state);

      expect(document.querySelector(".flora-inline-badge")).toBeNull();
    });

    it("skips DOIs with no-match state", () => {
      document.body.innerHTML = `
        <a href="https://doi.org/10.1038/nature12373">Paper link</a>
      `;

      const state = new Map<DoiString, LookupState>();
      state.set(doi("10.1038/nature12373"), { status: "no-match" });

      renderInlineBadges(state);

      expect(document.querySelector(".flora-inline-badge")).toBeNull();
    });
  });
});
