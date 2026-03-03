import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { lookupDOIs } from "../../src/shared/flora-api";
import type { DoiString } from "../../src/shared/types";

const API_URL = "https://flora.research.example/api/replications";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function doi(s: string): DoiString {
  return s as DoiString;
}

describe("lookupDOIs", () => {
  it("returns matched results on 200", async () => {
    server.use(
      http.post(API_URL, () =>
        HttpResponse.json({
          results: [
            {
              doi: "10.1038/nature12373",
              replication_count: 3,
              reproduction_count: 1,
              has_failed_replication: false,
              flora_url: "https://flora.research.example/10.1038/nature12373",
              last_updated: "2024-01-15T00:00:00Z",
            },
          ],
        })
      )
    );

    const results = await lookupDOIs([doi("10.1038/nature12373")]);
    expect(results.size).toBe(1);
    expect(results.get(doi("10.1038/nature12373"))?.replication_count).toBe(3);
  });

  it("returns empty map on 200 with empty results", async () => {
    server.use(
      http.post(API_URL, () => HttpResponse.json({ results: [] }))
    );

    const results = await lookupDOIs([doi("10.9999/nonexistent")]);
    expect(results.size).toBe(0);
  });

  it("returns empty map when called with empty array", async () => {
    const results = await lookupDOIs([]);
    expect(results.size).toBe(0);
  });

  it("throws on 429 rate limit", async () => {
    server.use(
      http.post(API_URL, () => new HttpResponse(null, { status: 429 }))
    );

    await expect(lookupDOIs([doi("10.1038/test")])).rejects.toThrow(
      "FLoRA API error: 429"
    );
  });

  it("throws on 500 server error", async () => {
    server.use(
      http.post(API_URL, () => new HttpResponse(null, { status: 500 }))
    );

    await expect(lookupDOIs([doi("10.1038/test")])).rejects.toThrow(
      "FLoRA API error: 500"
    );
  });

  it("throws on network timeout", async () => {
    server.use(
      http.post(API_URL, () => HttpResponse.error())
    );

    await expect(lookupDOIs([doi("10.1038/test")])).rejects.toThrow();
  });

  it("throws on Zod schema mismatch (missing required field)", async () => {
    server.use(
      http.post(API_URL, () =>
        HttpResponse.json({
          results: [
            {
              doi: "10.1038/nature12373",
              // missing replication_count and other fields
            },
          ],
        })
      )
    );

    await expect(lookupDOIs([doi("10.1038/nature12373")])).rejects.toThrow();
  });

  it("throws on completely unexpected response shape", async () => {
    server.use(
      http.post(API_URL, () =>
        HttpResponse.json({ data: "unexpected" })
      )
    );

    await expect(lookupDOIs([doi("10.1038/test")])).rejects.toThrow();
  });

  it("throws when response has null fields where numbers expected", async () => {
    server.use(
      http.post(API_URL, () =>
        HttpResponse.json({
          results: [
            {
              doi: "10.1038/nature12373",
              replication_count: null,
              reproduction_count: 1,
              has_failed_replication: false,
              flora_url: "https://flora.research.example/10.1038/nature12373",
              last_updated: "2024-01-15T00:00:00Z",
            },
          ],
        })
      )
    );

    await expect(lookupDOIs([doi("10.1038/nature12373")])).rejects.toThrow();
  });
});
