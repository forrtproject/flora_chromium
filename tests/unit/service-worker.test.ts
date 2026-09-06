import {describe, it, expect, vi, beforeEach} from "vitest";
import type {
    LookupRequest,
    LookupResponse,
    RetractionCheckResponse,
} from "../../src/shared/messages";
import type {RetractionMaps} from "../../src/shared/data-extract";
import {RET_MAP_KEY} from "../../src/shared/data-extract";
import {doi, mockResult} from "../helpers";
import {MONTH_MS} from "../../src/shared/cache";


const MOCK_RESULT = mockResult();

// Mock flora-api before importing service worker
const mockLookupDOIs = vi.fn();
vi.mock("../../src/shared/flora-api", () => ({
    lookupDOIs: (...args: unknown[]) => mockLookupDOIs(...args),
}));

const mockResolvePmcIds = vi.fn();
vi.mock("../../src/shared/pmc-resolve", () => ({
    resolvePmcIds: (...args: unknown[]) => mockResolvePmcIds(...args),
}));

// Mock settings
vi.mock("../../src/shared/settings", () => ({
    isSetupComplete: vi.fn().mockResolvedValue(true),
    getSettings: vi.fn().mockResolvedValue({email: "test@example.com", cacheQuotaMb: 500}),
}));

const mockStorageSync = vi.fn().mockResolvedValue(true);
vi.mock("../../src/shared/data-extract", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/shared/data-extract")>()),
    storageSync: () => mockStorageSync(),
}));

// Mock cache
const cacheStore = new Map<string, unknown>();
// Records every cache.set(key, data, ttlMs) so tests can assert TTL is applied.
const cacheSetCalls: Array<{key: string; data: unknown; ttlMs: number | null}> = [];
// When set, cache.set throws (simulates a storage-quota write failure).
let cacheSetError: Error | null = null;
vi.mock("../../src/shared/cache", async () => ({
    // Real constant, so a change to the TTL in src is visible to the assertions.
    MONTH_MS: (await vi.importActual<typeof import("../../src/shared/cache")>(
        "../../src/shared/cache",
    )).MONTH_MS,
    LocalCache: class {
        prefix: string;

        constructor(prefix: string) {
            this.prefix = prefix;
        }

        setQuota(_bytes: number) {}

        async get(key: string) {
            return cacheStore.has(`${this.prefix}:${key}`)
                ? cacheStore.get(`${this.prefix}:${key}`)
                : undefined;
        }

        async set(key: string, data: unknown, ttlMs: number | null) {
            cacheSetCalls.push({key, data, ttlMs});
            if (cacheSetError) throw cacheSetError;
            cacheStore.set(`${this.prefix}:${key}`, data);
        }

        async getMany(keys: string[]) {
            const out = new Map<string, unknown>();
            for (const key of keys) {
                const full = `${this.prefix}:${key}`;
                if (cacheStore.has(full)) out.set(key, cacheStore.get(full));
            }
            return out;
        }

        async setMany(entries: Array<[string, unknown]>, ttlMs: number | null) {
            for (const [key, data] of entries) {
                cacheSetCalls.push({key, data, ttlMs});
            }
            if (cacheSetError) throw cacheSetError;
            for (const [key, data] of entries) {
                cacheStore.set(`${this.prefix}:${key}`, data);
            }
        }
    },
}));

describe("service-worker", () => {
    let messageHandler: (
        message: unknown,
        sender: unknown,
        sendResponse: (response: unknown) => void
    ) => boolean | undefined;
    let alarmHandler: (alarm: {name: string}) => void;
    let storageChangeHandlers: Array<
        (changes: Record<string, {newValue?: unknown}>, area: string) => void
    >;
    let pendingMapReads: Array<(result: unknown) => void>;

    beforeEach(async () => {
        cacheStore.clear();
        cacheSetCalls.length = 0;
        cacheSetError = null;
        mockLookupDOIs.mockReset();
        mockResolvePmcIds.mockReset();
        mockStorageSync.mockClear();
        (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
        (chrome.alarms.get as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(undefined);
        (chrome.alarms.create as ReturnType<typeof vi.fn>).mockReset();


        const addListenerMock = vi.fn();
        (chrome.runtime.onMessage.addListener as ReturnType<typeof vi.fn>) =
            addListenerMock;
        const alarmListenerMock = vi.fn();
        (chrome.alarms.onAlarm.addListener as ReturnType<typeof vi.fn>) =
            alarmListenerMock;
        storageChangeHandlers = [];
        pendingMapReads = [];
        (chrome.storage.onChanged.addListener as ReturnType<typeof vi.fn>) =
            vi.fn((fn) => storageChangeHandlers.push(fn));

        vi.resetModules();
        await import("../../src/background/service-worker");

        messageHandler = addListenerMock.mock.calls[0][0];
        alarmHandler = alarmListenerMock.mock.calls[0][0];
    });

    function sendMessage(request: LookupRequest): Promise<LookupResponse> {
        return new Promise((resolve) => {
            messageHandler(request, {}, resolve as (r: unknown) => void);
        });
    }

    function sendRetractionCheck(dois: string[]): Promise<RetractionCheckResponse> {
        return new Promise((resolve) => {
            messageHandler(
                {type: "FLORA_RET_CHECK", dois},
                {},
                resolve as (r: unknown) => void
            );
        });
    }

    function storeRetractionMap(map: RetractionMaps): void {
        (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockImplementation(
            async (keys: unknown) => {
                const wants = (key: string) =>
                    keys === key || (Array.isArray(keys) && keys.includes(key));
                if (wants(RET_MAP_KEY)) return {[RET_MAP_KEY]: map};
                return {};
            }
        );
    }

    function blockRetractionMapReads(): void {
        (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockImplementation(
            (keys: unknown) => {
                const wants = (key: string) =>
                    keys === key || (Array.isArray(keys) && keys.includes(key));
                if (!wants(RET_MAP_KEY)) return Promise.resolve({});
                return new Promise((resolve) => pendingMapReads.push(resolve));
            }
        );
    }

    function releaseMapRead(index: number, map: RetractionMaps): void {
        pendingMapReads[index]({[RET_MAP_KEY]: map});
    }

    function landRetractionSync(map: RetractionMaps): void {
        for (const fn of storageChangeHandlers) fn({[RET_MAP_KEY]: {newValue: map}}, "local");
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

        await sendMessage({
            type: "FLORA_LOOKUP",
            dois: [doi("10.1038/nature12373")],
        });
        expect(mockLookupDOIs).toHaveBeenCalledOnce();

        const response = await sendMessage({
            type: "FLORA_LOOKUP",
            dois: [doi("10.1038/nature12373")],
        });
        expect(mockLookupDOIs).toHaveBeenCalledOnce();
        expect(response.results["10.1038/nature12373"]).toEqual(MOCK_RESULT);
    });

    it("re-queries no-match DOIs (does not negative-cache)", async () => {
        // FORRT may add a record later, so an unmatched DOI must hit the API
        // again on the next request rather than being suppressed by the cache.
        mockLookupDOIs.mockResolvedValue(new Map());

        await sendMessage({
            type: "FLORA_LOOKUP",
            dois: [doi("10.9999/not.yet.in.forrt")],
        });
        expect(mockLookupDOIs).toHaveBeenCalledOnce();

        const response = await sendMessage({
            type: "FLORA_LOOKUP",
            dois: [doi("10.9999/not.yet.in.forrt")],
        });
        // Second request re-hits the API instead of serving a cached no-match.
        expect(mockLookupDOIs).toHaveBeenCalledTimes(2);
        expect(Object.keys(response.results)).toHaveLength(0);
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

    it("shares a caught batch failure with concurrent callers without caching it", async () => {
        let finish!: () => void;
        const pending = new Promise<void>(resolve => { finish = resolve; });
        mockLookupDOIs.mockImplementation(async (_dois, errors) => {
            await pending;
            errors["10.1038/nature12373"] = "FLoRA API error: 503";
            return new Map();
        });
        const request: LookupRequest = {type: "FLORA_LOOKUP", dois: [doi("10.1038/nature12373")]};
        const first = sendMessage(request);
        await vi.waitFor(() => expect(mockLookupDOIs).toHaveBeenCalledOnce());
        const second = sendMessage(request);
        // Let the second cache read reach the shared in-flight request.
        await Promise.resolve();
        finish();
        for (const response of await Promise.all([first, second])) {
            expect(response.errors["10.1038/nature12373"]).toMatch(/503/);
            expect(response.results).toEqual({});
        }
        expect(mockLookupDOIs).toHaveBeenCalledOnce();
        expect(cacheSetCalls).toHaveLength(0);
    });

    it("applies a finite TTL to lookup cache writes (not forever)", async () => {
        mockLookupDOIs.mockResolvedValue(
            new Map([[doi("10.1038/nature12373"), MOCK_RESULT]])
        );

        await sendMessage({
            type: "FLORA_LOOKUP",
            dois: [doi("10.1038/nature12373")],
        });

        expect(cacheSetCalls).toHaveLength(1);
        // A finite TTL, not null/forever — this is what makes eviction possible.
        expect(cacheSetCalls[0].ttlMs).toBe(MONTH_MS);
        expect(MONTH_MS).toBeGreaterThan(0);
    });

    it("does not turn a cache-WRITE failure into a lookup error", async () => {
        // The API returns a real result, but persisting it to storage fails
        // (e.g. quota). The result must still be returned and NOT reported as an
        // error — this is the storage-quota time-bomb regression.
        mockLookupDOIs.mockResolvedValue(
            new Map([[doi("10.1038/nature12373"), MOCK_RESULT]])
        );
        cacheSetError = new Error("QUOTA_BYTES quota exceeded");

        const response = await sendMessage({
            type: "FLORA_LOOKUP",
            dois: [doi("10.1038/nature12373")],
        });

        expect(response.results["10.1038/nature12373"]).toEqual(MOCK_RESULT);
        expect(Object.keys(response.errors)).toHaveLength(0);
        // The write was attempted (and threw) but did not corrupt the response.
        expect(cacheSetCalls).toHaveLength(1);
    });

    it("does not claim an async response for a lookup with no dois", () => {
        const sendResponse = vi.fn();
        const claimed = messageHandler({type: "FLORA_LOOKUP"}, {}, sendResponse);

        expect(claimed).toBeFalsy();
        expect(sendResponse).not.toHaveBeenCalled();
    });

    it("answers a setup-dismiss request even when session storage fails", async () => {
        (chrome.storage.session.set as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
            new Error("session storage unavailable")
        );

        const response = await new Promise((resolve) => {
            messageHandler({type: "FLORA_DISMISS_SETUP"}, {}, resolve as (r: unknown) => void);
        });

        expect(response).toEqual({ok: false});
    });

    it("ignores non-lookup messages", () => {
        const result = messageHandler({type: "UNKNOWN"}, {}, vi.fn());
        expect(result).toBe(false);
    });

    describe("retraction checks", () => {
        it("returns the notice DOI for a retracted paper in the synced map", async () => {
            storeRetractionMap({
                retractions: {"10.1234/paper": "10.1234/notice"},
                concerns: {},
            });

            const response = await sendRetractionCheck([doi("10.1234/paper")]);
            expect(response.type).toBe("FLORA_RET_CHECK_RESULT");
            expect(response.results).toEqual([
                {originDoi: "10.1234/paper", doi: "10.1234/notice", kind: "retraction"},
            ]);
        });

        it("tags expressions of concern as 'concern'", async () => {
            storeRetractionMap({
                retractions: {},
                concerns: {"10.5678/eoc-paper": "10.5678/eoc-notice"},
            });

            const response = await sendRetractionCheck([doi("10.5678/eoc-paper")]);
            expect(response.results).toEqual([
                {originDoi: "10.5678/eoc-paper", doi: "10.5678/eoc-notice", kind: "concern"},
            ]);
        });

        it("prefers retraction over concern when a DOI is in both maps", async () => {
            storeRetractionMap({
                retractions: {"10.1234/dual": "10.1234/dual-retraction"},
                concerns: {"10.1234/dual": "10.1234/dual-concern"},
            });

            const response = await sendRetractionCheck([doi("10.1234/dual")]);
            expect(response.results).toEqual([
                {originDoi: "10.1234/dual", doi: "10.1234/dual-retraction", kind: "retraction"},
            ]);
        });

        it("matches mixed-case source keys against lowercased DOI input", async () => {
            // Retraction Watch publishes DOIs in publisher case; normaliseDOI
            // lowercases lookups, so the worker must lowercase the source keys.
            storeRetractionMap({
                retractions: {"10.1016/S0140-6736(20)32656-8": "10.1016/S0140-6736(22)02370-4"},
                concerns: {"10.1056/NEJMicm2518379": "10.1056/NEJMicm9999999"},
            });

            // Lookups arrive already lowercased (normaliseDOI runs before the
            // message is sent); the source keys are in publisher case.
            const retracted = await sendRetractionCheck([doi("10.1016/s0140-6736(20)32656-8")]);
            expect(retracted.results).toEqual([
                {
                    originDoi: "10.1016/s0140-6736(20)32656-8",
                    doi: "10.1016/S0140-6736(22)02370-4",
                    kind: "retraction",
                },
            ]);

            const concerned = await sendRetractionCheck([doi("10.1056/nejmicm2518379")]);
            expect(concerned.results).toEqual([
                {
                    originDoi: "10.1056/nejmicm2518379",
                    doi: "10.1056/NEJMicm9999999",
                    kind: "concern",
                },
            ]);
        });

        it("returns nothing for a DOI in neither map", async () => {
            storeRetractionMap({
                retractions: {"10.1234/keep": "10.1234/retraction"},
                concerns: {},
            });

            const response = await sendRetractionCheck([doi("10.9999/not-there")]);
            expect(response.results).toEqual([]);
        });

        it("falls back to the bundled JSON when storage is empty", async () => {
            // Storage empty (default mock); the worker fetches the packaged
            // dist/retractions.json and lowercases its keys.
            const bundled: RetractionMaps = {
                retractions: {"10.1000/Bundled": "10.1000/bundled-notice"},
                concerns: {},
            };
            const fetchMock = vi.fn(async (url: string) => ({
                ok: true,
                status: 200,
                json: async () =>
                    String(url).includes("retractions.json")
                        ? bundled
                        : {retractions: {}, concerns: {}},
            }));
            vi.stubGlobal("fetch", fetchMock);

            const response = await sendRetractionCheck([doi("10.1000/bundled")]);
            expect(response.results).toEqual([
                {originDoi: "10.1000/bundled", doi: "10.1000/bundled-notice", kind: "retraction"},
            ]);
            expect(fetchMock).toHaveBeenCalledWith(
                "chrome-extension://test-extension-id/dist/retractions.json"
            );
            vi.unstubAllGlobals();
        });

        it("reports an error when no data source is available", async () => {
            const fetchMock = vi.fn(async () => ({ok: false, status: 404, json: async () => ({})}));
            vi.stubGlobal("fetch", fetchMock);

            const response = await sendRetractionCheck([doi("10.1234/paper")]);
            expect(response.results).toEqual([]);
            expect(response.error).toBeTruthy();
            vi.unstubAllGlobals();
        });
    });

    describe("retraction cache invalidation", () => {
        const PRE_SYNC: RetractionMaps = {
            retractions: {"10.1000/old": "10.1000/old-notice"},
            concerns: {},
        };
        const POST_SYNC: RetractionMaps = {
            retractions: {"10.1000/old": "10.1000/old-notice", "10.1000/fresh": "10.1000/fresh-notice"},
            concerns: {},
        };
        const FRESH_HIT = {
            originDoi: "10.1000/fresh",
            doi: "10.1000/fresh-notice",
            kind: "retraction",
        };

        it("does not cache a map read before a sync landed", async () => {
            blockRetractionMapReads();
            const duringSync = sendRetractionCheck([doi("10.1000/fresh")]);
            await vi.waitFor(() => expect(pendingMapReads).toHaveLength(1));

            landRetractionSync(POST_SYNC);
            releaseMapRead(0, PRE_SYNC);
            expect((await duringSync).results).toEqual([]);

            const afterSync = sendRetractionCheck([doi("10.1000/fresh")]);
            await vi.waitFor(() => expect(pendingMapReads).toHaveLength(2));
            releaseMapRead(1, POST_SYNC);

            expect((await afterSync).results).toEqual([FRESH_HIT]);
        });

        it("keeps the newer load when a superseded one finishes", async () => {
            blockRetractionMapReads();
            const superseded = sendRetractionCheck([doi("10.1000/fresh")]);
            await vi.waitFor(() => expect(pendingMapReads).toHaveLength(1));

            landRetractionSync(POST_SYNC);
            const reload = sendRetractionCheck([doi("10.1000/fresh")]);
            await vi.waitFor(() => expect(pendingMapReads).toHaveLength(2));

            releaseMapRead(0, PRE_SYNC);
            await superseded;

            const shouldReuseReload = sendRetractionCheck([doi("10.1000/fresh")]);
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(pendingMapReads).toHaveLength(2);

            releaseMapRead(1, POST_SYNC);
            expect((await reload).results).toEqual([FRESH_HIT]);
            expect((await shouldReuseReload).results).toEqual([FRESH_HIT]);
        });
    });

    describe("scheduled retraction refresh", () => {
        it("creates a daily alarm when none exists", async () => {
            await vi.waitFor(() =>
                expect(chrome.alarms.create).toHaveBeenCalledWith(
                    "flora-retraction-sync",
                    {periodInMinutes: 60 * 24}
                )
            );
        });

        it("does not recreate an existing alarm", async () => {
            (chrome.alarms.get as ReturnType<typeof vi.fn>).mockResolvedValue({
                name: "flora-retraction-sync",
            });
            (chrome.alarms.create as ReturnType<typeof vi.fn>).mockClear();

            vi.resetModules();
            await import("../../src/background/service-worker");

            await vi.waitFor(() => expect(chrome.alarms.get).toHaveBeenCalled());
            expect(chrome.alarms.create).not.toHaveBeenCalled();
        });

        it("syncs retraction data when the alarm fires", async () => {
            alarmHandler({name: "flora-retraction-sync"});

            await vi.waitFor(() => expect(mockStorageSync).toHaveBeenCalled());
            expect(chrome.storage.local.set).toHaveBeenCalledWith(
                expect.objectContaining({synctime: expect.any(Number)})
            );
        });

        it("ignores alarms belonging to other features", async () => {
            alarmHandler({name: "some-other-alarm"});

            await Promise.resolve();
            expect(mockStorageSync).not.toHaveBeenCalled();
        });
    });

    it("splits cached and uncached DOIs in one request", async () => {
        cacheStore.set("flora:10.1038/nature12373", MOCK_RESULT);

        const otherResult = mockResult({doi: "10.1126/science.9999999"});
        mockLookupDOIs.mockResolvedValue(
            new Map([[doi("10.1126/science.9999999"), otherResult]])
        );

        const response = await sendMessage({
            type: "FLORA_LOOKUP",
            dois: [doi("10.1038/nature12373"), doi("10.1126/science.9999999")],
        });

        expect(mockLookupDOIs).toHaveBeenCalledWith([
            doi("10.1126/science.9999999"),
        ], expect.any(Object), expect.any(AbortSignal));
        expect(response.results["10.1038/nature12373"]).toEqual(MOCK_RESULT);
        expect(response.results["10.1126/science.9999999"]).toEqual(otherResult);
    });

    it("caches a shared lookup when its originating tab cancels", async () => {
        let complete!: (value: Map<string, typeof MOCK_RESULT>) => void;
        mockLookupDOIs.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
        const send = (tabId: number, requestId: string) => new Promise<LookupResponse>(resolve => {
            messageHandler({type: "FLORA_LOOKUP", requestId, dois: [MOCK_RESULT.doi]},
                {tab: {id: tabId}, documentId: "document"}, resolve as (r: unknown) => void);
        });
        const first = send(1, "first");
        await vi.waitFor(() => expect(mockLookupDOIs).toHaveBeenCalledTimes(1));
        const second = send(2, "second");
        // Both callers have crossed the cache read before cancelling the owner.
        await new Promise(resolve => setTimeout(resolve, 0));
        messageHandler({type: "FLORA_CANCEL_REQUEST", requestId: "first"},
            {tab: {id: 1}, documentId: "document"}, () => {});
        complete(new Map([[MOCK_RESULT.doi, MOCK_RESULT]]));
        await first;
        expect((await second).results[MOCK_RESULT.doi]).toEqual(MOCK_RESULT);
        expect(cacheStore.get(`flora:${MOCK_RESULT.doi}`)).toEqual(MOCK_RESULT);
        expect(mockLookupDOIs).toHaveBeenCalledTimes(1);
    });

    describe("PMC id resolution", () => {
        function sendPmcResolve(pmcids: string[]): Promise<{results: Record<string, string | null>}> {
            return new Promise((resolve) => {
                messageHandler(
                    {type: "FLORA_PMC_RESOLVE", pmcids},
                    {},
                    resolve as (r: unknown) => void
                );
            });
        }

        it("answers with the converter's PMC id → DOI mapping", async () => {
            mockResolvePmcIds.mockResolvedValue(
                new Map([
                    ["PMC12638941", doi("10.1038/s41531-025-01179-6")],
                    ["PMC99999999", null],
                ])
            );

            const response = await sendPmcResolve(["PMC12638941", "PMC99999999"]);

            expect(mockResolvePmcIds).toHaveBeenCalledWith(["PMC12638941", "PMC99999999"], "pmcid", undefined);
            expect(response.results).toEqual({
                PMC12638941: "10.1038/s41531-025-01179-6",
                PMC99999999: null,
            });
        });

        it("answers with an empty mapping when resolution throws", async () => {
            mockResolvePmcIds.mockRejectedValue(new Error("offline"));

            const response = await sendPmcResolve(["PMC12638941"]);
            expect(response.results).toEqual({});
        });
    });
});
