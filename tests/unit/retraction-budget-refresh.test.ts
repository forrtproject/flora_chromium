import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {RET_MAP_KEY, RET_BUDGET_EVICTED_SYNC_KEY} from "../../src/shared/data-extract";

vi.mock("../../src/shared/settings", () => ({
    isSetupComplete: async () => true,
    getSettings: async () => ({cacheQuotaMb: 0}),
}));

const WEEK = 7 * 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const map = {retractions: {"10.1000/paper": "10.1000/notice"}, concerns: {}};
let store: Record<string, unknown>;
let remoteRequests: number;

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    store = {};
    remoteRequests = 0;
    vi.mocked(chrome.runtime.onMessage.addListener).mockClear();
    chrome.storage.local.get = vi.fn(async keys => {
        const wanted = keys === null ? Object.keys(store) : Array.isArray(keys) ? keys :
            typeof keys === "string" ? [keys] : Object.keys(keys ?? {});
        return structuredClone(Object.fromEntries(wanted.filter(key => key in store).map(key => [key, store[key]])));
    });
    chrome.storage.local.set = vi.fn(async items => {Object.assign(store, structuredClone(items));});
    chrome.storage.local.remove = vi.fn(async keys => {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    });
    chrome.storage.local.getBytesInUse = vi.fn(async keys =>
        (keys === null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys])
            .reduce((sum, key) => sum + (key in store ? new TextEncoder().encode(key + JSON.stringify(store[key])).length : 0), 0));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (url.startsWith("https://raw.githubusercontent.com/")) remoteRequests++;
        return new Response(JSON.stringify(map));
    }));
});
afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals();});

async function checkRetraction(): Promise<unknown> {
    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0];
    return new Promise(resolve => listener({type: "FLORA_RET_CHECK", dois: ["10.1000/paper"]}, {}, resolve));
}

describe("retraction refresh after cache budget eviction", () => {
    it("answers repeated checks from the bundle without re-downloading until weekly refresh", async () => {
        const {syncRetractionsInfo} = await import("../../src/background/service-worker");
        const {enforceCacheBudget} = await import("../../src/shared/cache-budget");
        await syncRetractionsInfo();
        expect(remoteRequests).toBe(1);
        await enforceCacheBudget(40); // too small to retain this provider map
        expect(store[RET_MAP_KEY]).toBeUndefined();
        expect(store[RET_BUDGET_EVICTED_SYNC_KEY]).toBe(NOW);
        for (let i = 0; i < 5; i++) {
            expect(await checkRetraction()).toMatchObject({results: [{originDoi: "10.1000/paper", doi: "10.1000/notice"}]});
            await syncRetractionsInfo();
            await enforceCacheBudget(40);
        }
        expect(remoteRequests).toBe(1);
        vi.setSystemTime(NOW + WEEK + 1);
        await syncRetractionsInfo();
        expect(remoteRequests).toBe(2);
        expect(store[RET_BUDGET_EVICTED_SYNC_KEY]).toBeUndefined();
        await enforceCacheBudget(40);
        expect(store[RET_BUDGET_EVICTED_SYNC_KEY]).toBe(NOW + WEEK + 1);
        await checkRetraction();
        await syncRetractionsInfo();
        expect(remoteRequests).toBe(2);
    });

    it("uses the current sync generation when refresh lands during budget accounting", async () => {
        store = {[RET_MAP_KEY]: map, synctime: NOW};
        const bytes = chrome.storage.local.getBytesInUse;
        vi.mocked(chrome.storage.local.getBytesInUse).mockImplementationOnce(async keys => {
            const size = await bytes(keys);
            store.synctime = NOW + 1; // a successful refresh after the sweep snapshot
            return size;
        });
        const {enforceCacheBudget} = await import("../../src/shared/cache-budget");
        await enforceCacheBudget(40);
        expect(store[RET_BUDGET_EVICTED_SYNC_KEY]).toBe(NOW + 1);
        const {syncRetractionsInfo} = await import("../../src/background/service-worker");
        await syncRetractionsInfo();
        expect(remoteRequests).toBe(0);
    });

    it("serializes publication with an eviction already between marker write and removal", async () => {
        vi.useRealTimers();
        const startedAt = Date.now();
        store = {[RET_MAP_KEY]: map, synctime: startedAt - WEEK - 1};
        let reachedRemoval!: () => void;
        let releaseRemoval!: () => void;
        const reached = new Promise<void>(resolve => {reachedRemoval = resolve;});
        const released = new Promise<void>(resolve => {releaseRemoval = resolve;});
        vi.mocked(chrome.storage.local.remove).mockImplementationOnce(async keys => {
            reachedRemoval();
            await released;
            for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
        });
        const {enforceCacheBudget} = await import("../../src/shared/cache-budget");
        const {syncRetractionsInfo} = await import("../../src/background/service-worker");
        const eviction = enforceCacheBudget(40);
        await reached;
        let published = false;
        const refresh = syncRetractionsInfo().then(() => {published = true;});
        try {
            // Let the fetch and JSON microtasks complete while removal is held.
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(remoteRequests).toBe(1); // network work is outside the storage lock
            expect(published).toBe(false);
        } finally {
            releaseRemoval();
            await Promise.all([eviction, refresh]);
        }
        expect(store[RET_MAP_KEY]).toEqual(map);
        expect(store.synctime).toBeGreaterThanOrEqual(startedAt);
        expect(store[RET_BUDGET_EVICTED_SYNC_KEY]).toBeUndefined();
    });

    it.each(["missing", "empty", "old-marker"])("still repairs a %s map without matching budget eviction", async kind => {
        store.synctime = NOW;
        if (kind === "empty") {
            store[RET_MAP_KEY] = {retractions: {}, concerns: {}};
            store[RET_BUDGET_EVICTED_SYNC_KEY] = NOW;
        }
        if (kind === "old-marker") store[RET_BUDGET_EVICTED_SYNC_KEY] = NOW - WEEK;
        const {syncRetractionsInfo} = await import("../../src/background/service-worker");
        await syncRetractionsInfo();
        expect(remoteRequests).toBe(1);
        expect(store[RET_MAP_KEY]).toEqual(map);
    });
});
