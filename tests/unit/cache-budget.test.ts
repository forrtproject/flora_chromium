import {beforeEach, describe, expect, it, vi} from "vitest";
import {enforceCacheBudget} from "../../src/shared/cache-budget";

describe("shared provider cache budget", () => {
  let store: Record<string, unknown>;
  beforeEach(() => {
    store = {};
    chrome.storage.local.get = vi.fn(async () => structuredClone(store));
    chrome.storage.local.remove = vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    });
    chrome.storage.local.getBytesInUse = vi.fn(async (keys: string | string[] | null) =>
      (keys === null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys])
        .reduce((sum, key) => sum + (key in store ? new TextEncoder().encode(key + JSON.stringify(store[key])).length : 0), 0),
    );
  });

  it("evicts across provider families while preserving settings and diagnostics", async () => {
    store = {
      "flora:old": {data: "x".repeat(200), createdAt: 1, expiresAt: Date.now() - 1},
      flora_oa_blob: {doi: {v: "x".repeat(200), t: 2}},
      flora_citation_blob: {doi: {v: "x".repeat(200), t: 3}},
      RetractionLookupLocal: {retractions: {doi: "x".repeat(200)}, concerns: {}},
      flora_settings: {email: "keep@example.org"},
      flora_debug_log: ["keep"],
    };
    await enforceCacheBudget(300);
    expect(store.flora_settings).toEqual({email: "keep@example.org"});
    expect(store.flora_debug_log).toEqual(["keep"]);
    expect(store["flora:old"]).toBeUndefined();
    expect(store.flora_oa_blob).toBeUndefined();
    expect(store.flora_citation_blob).toBeDefined();
    const disposable = Object.keys(store).filter(k => !["flora_settings", "flora_debug_log"].includes(k));
    expect(await chrome.storage.local.getBytesInUse(disposable)).toBeLessThanOrEqual(300);
    expect(vi.mocked(chrome.storage.local.getBytesInUse).mock.calls.every(([keys]) => Array.isArray(keys))).toBe(true);
  });

  it("keeps a freshly synced retraction map before older provider blobs", async () => {
    store = {
      flora_oa_blob: {doi: {v: "x".repeat(200), t: 1}},
      RetractionLookupLocal: {retractions: {doi: "x".repeat(200)}, concerns: {}},
      synctime: 2,
    };
    await enforceCacheBudget(330);
    expect(store.flora_oa_blob).toBeUndefined();
    expect(store.RetractionLookupLocal).toBeDefined();
    expect(store.synctime).toBe(2);
  });

  it("does not evict provider data just because unrelated local data is large", async () => {
    store = {flora_debug_log: ["x".repeat(10000)], flora_oa_blob: {doi: {v: true, t: 1}}};
    await enforceCacheBudget(100);
    expect(chrome.storage.local.remove).not.toHaveBeenCalled();
  });

  it("treats zero as unlimited", async () => {
    store = {flora_oa_blob: {doi: {v: "x".repeat(1000), t: 1}}};
    await enforceCacheBudget(0);
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(chrome.storage.local.remove).not.toHaveBeenCalled();
  });
});
