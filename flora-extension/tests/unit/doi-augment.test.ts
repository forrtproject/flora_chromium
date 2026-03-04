import { describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { normalizeTitle, similarity, augmentDOIs } from "../../src/shared/doi-augment";

const OPENALEX_URL = "https://api.openalex.org/works";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("normalizeTitle", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeTitle("Hello, World!")).toBe("hello world");
  });

  it("collapses multiple spaces", () => {
    expect(normalizeTitle("  foo   bar  ")).toBe("foo bar");
  });

  it("handles empty string", () => {
    expect(normalizeTitle("")).toBe("");
  });

  it("preserves numbers and words", () => {
    expect(normalizeTitle("Study 1: Results (2024)")).toBe(
      "study 1 results 2024"
    );
  });
});

describe("similarity", () => {
  it("returns 1.0 for identical strings", () => {
    expect(similarity("hello", "hello")).toBe(1.0);
  });

  it("returns high score for similar strings", () => {
    const score = similarity(
      "the effect of sleep on memory",
      "the effects of sleep on memory"
    );
    expect(score).toBeGreaterThan(0.8);
  });

  it("returns low score for different strings", () => {
    const score = similarity("quantum physics", "baking chocolate cake");
    expect(score).toBeLessThan(0.5);
  });

  it("returns 1.0 for two empty strings", () => {
    expect(similarity("", "")).toBe(1.0);
  });

  it("handles one empty string", () => {
    expect(similarity("hello", "")).toBe(0);
  });
});

describe("augmentDOIs", () => {
  beforeEach(() => {
    // Reset storage mock
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      {}
    );
    (chrome.storage.local.set as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined
    );
  });

  it("returns resolved DOI when OpenAlex finds a match", async () => {
    server.use(
      http.get(OPENALEX_URL, () =>
        HttpResponse.json({
          results: [
            {
              doi: "https://doi.org/10.1038/nature12373",
              title: "The Effect of Sleep on Memory Consolidation",
            },
          ],
        })
      )
    );

    const results = await augmentDOIs([
      "The Effect of Sleep on Memory Consolidation",
    ]);

    expect(results.get("The Effect of Sleep on Memory Consolidation")).toBe(
      "10.1038/nature12373"
    );
  });

  it("returns null when no match found", async () => {
    server.use(
      http.get(OPENALEX_URL, () => HttpResponse.json({ results: [] }))
    );

    const results = await augmentDOIs(["Some Obscure Title Nobody Wrote"]);
    expect(results.get("Some Obscure Title Nobody Wrote")).toBeNull();
  });

  it("returns null on API error", async () => {
    server.use(
      http.get(OPENALEX_URL, () => new HttpResponse(null, { status: 500 }))
    );

    const results = await augmentDOIs(["Test Title"]);
    expect(results.get("Test Title")).toBeNull();
  });

  it("returns empty map for empty input", async () => {
    const results = await augmentDOIs([]);
    expect(results.size).toBe(0);
  });

  it("uses cached results on second call", async () => {
    // Pre-populate cache
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      "flora_doi:test title": { found: true, doi: "10.1234/cached" },
    });

    const results = await augmentDOIs(["Test Title"]);
    expect(results.get("Test Title")).toBe("10.1234/cached");
  });

  it("rejects low-similarity matches", async () => {
    server.use(
      http.get(OPENALEX_URL, () =>
        HttpResponse.json({
          results: [
            {
              doi: "https://doi.org/10.1038/wrong",
              title: "A Completely Different Paper About Quantum Physics",
            },
          ],
        })
      )
    );

    const results = await augmentDOIs(["The Effect of Sleep on Memory"]);
    expect(results.get("The Effect of Sleep on Memory")).toBeNull();
  });

  it("handles multiple titles in one batch", async () => {
    server.use(
      http.get(OPENALEX_URL, () =>
        HttpResponse.json({
          results: [
            {
              doi: "https://doi.org/10.1038/paper1",
              title: "First Paper Title",
            },
            {
              doi: "https://doi.org/10.1126/paper2",
              title: "Second Paper Title",
            },
          ],
        })
      )
    );

    const results = await augmentDOIs([
      "First Paper Title",
      "Second Paper Title",
      "Third Unknown Title",
    ]);

    expect(results.get("First Paper Title")).toBe("10.1038/paper1");
    expect(results.get("Second Paper Title")).toBe("10.1126/paper2");
    expect(results.get("Third Unknown Title")).toBeNull();
  });
});
