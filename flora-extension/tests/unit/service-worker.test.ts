import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DoiString, ReplicationResult } from "../../src/shared/types";
import type { LookupRequest, LookupResponse } from "../../src/shared/messages";

// We need to test the service worker's handleLookup logic.
// Since it's wired via chrome.runtime.onMessage, we capture the listener
// and invoke it directly.

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

// Mock flora-api before importing service worker
const mockLookupDOIs = vi.fn();
vi.mock("../../src/shared/flora-api", () => ({
  lookupDOIs: (...args: unknown[]) => mockLookupDOIs(...args),
}));

// Mock cache
const cacheStore = new Map<string, unknown>();
vi.mock("../../src/shared/cache", () => ({
  SessionCache: class {
    prefix: string;
    constructor(prefix: string) {
      this.prefix = prefix;
    }
    async get(key: string) {
      return cacheStore.get(`${this.prefix}:${key}`) ?? null;
    }
    async set(key: string, data: unknown) {
      cacheStore.set(`${this.prefix}:${key}`, data);
    }
  },
}));

describe("service-worker", () => {
  let messageHandler: (
    message: unknown,
    sender: unknown,
    sendResponse: (response: LookupResponse) => void
  ) => boolean | undefined;

  beforeEach(async () => {
    cacheStore.clear();
    mockLookupDOIs.mockReset();

    // Capture the listener registered by the service worker
    const addListenerMock = vi.fn();
    (chrome.runtime.onMessage.addListener as ReturnType<typeof vi.fn>) =
      addListenerMock;

    // Dynamically import the service worker to trigger registration
    vi.resetModules();
    await import("../../src/background/service-worker");

    messageHandler = addListenerMock.mock.calls[0][0];
  });

  function sendMessage(request: LookupRequest): Promise<LookupResponse> {
    return new Promise((resolve) => {
      messageHandler(request, {}, resolve);
    });
  }

  it("returns results for matched DOIs", async () => {
    mockLookupDOIs.mockResolvedValue(
      new Map([[doi("10.1038/nature12373"), MOCK_RESULT]])
    );

    const response = await sendMessage({
      type: "FLORA_LOOKUP",
      dois: [doi("10.1038/nature12373")],
    });

    expect(response.type).toBe("FLORA_LOOKUP_RESULT");
    expect(response.results["10.1038/nature12373"]).toEqual(MOCK_RESULT);
    expect(Object.keys(response.errors)).toHaveLength(0);
  });

  it("returns empty results for unmatched DOIs", async () => {
    mockLookupDOIs.mockResolvedValue(new Map());

    const response = await sendMessage({
      type: "FLORA_LOOKUP",
      dois: [doi("10.9999/nonexistent")],
    });

    expect(Object.keys(response.results)).toHaveLength(0);
    expect(Object.keys(response.errors)).toHaveLength(0);
  });

  it("uses cache on second request", async () => {
    mockLookupDOIs.mockResolvedValue(
      new Map([[doi("10.1038/nature12373"), MOCK_RESULT]])
    );

    // First call — hits API
    await sendMessage({
      type: "FLORA_LOOKUP",
      dois: [doi("10.1038/nature12373")],
    });
    expect(mockLookupDOIs).toHaveBeenCalledOnce();

    // Second call — should use cache
    const response = await sendMessage({
      type: "FLORA_LOOKUP",
      dois: [doi("10.1038/nature12373")],
    });
    expect(mockLookupDOIs).toHaveBeenCalledOnce(); // still 1
    expect(response.results["10.1038/nature12373"]).toEqual(MOCK_RESULT);
  });

  it("returns errors on API failure", async () => {
    mockLookupDOIs.mockRejectedValue(new Error("FLoRA API error: 500"));

    const response = await sendMessage({
      type: "FLORA_LOOKUP",
      dois: [doi("10.1038/nature12373")],
    });

    expect(Object.keys(response.results)).toHaveLength(0);
    expect(response.errors["10.1038/nature12373"]).toBe(
      "FLoRA API error: 500"
    );
  });

  it("ignores non-lookup messages", () => {
    const result = messageHandler({ type: "UNKNOWN" }, {}, vi.fn());
    expect(result).toBe(false);
  });

  it("splits cached and uncached DOIs in one request", async () => {
    // Pre-populate cache for one DOI
    cacheStore.set("flora:10.1038/nature12373", MOCK_RESULT);

    const otherResult: ReplicationResult = {
      ...MOCK_RESULT,
      doi: "10.1126/science.9999999",
    };
    mockLookupDOIs.mockResolvedValue(
      new Map([[doi("10.1126/science.9999999"), otherResult]])
    );

    const response = await sendMessage({
      type: "FLORA_LOOKUP",
      dois: [doi("10.1038/nature12373"), doi("10.1126/science.9999999")],
    });

    // Only the uncached DOI should have been fetched
    expect(mockLookupDOIs).toHaveBeenCalledWith([
      doi("10.1126/science.9999999"),
    ]);
    expect(response.results["10.1038/nature12373"]).toEqual(MOCK_RESULT);
    expect(response.results["10.1126/science.9999999"]).toEqual(otherResult);
  });
});
