import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {fetchOpenAccess, _resetOpenAccessCacheForTesting} from "../../src/shared/openaccess";

const settings = vi.hoisted(() => ({email: "reader@example.org"}));
vi.mock("../../src/shared/settings", () => ({getSettings: async () => ({...settings})}));

beforeEach(() => {
    settings.email = "reader@example.org";
    _resetOpenAccessCacheForTesting();
    vi.mocked(chrome.storage.local.get).mockResolvedValue({});
});
afterEach(() => vi.unstubAllGlobals());

describe("Open Access request sharing", () => {
    it("uses one request per DOI and caps simultaneous requests on a repeated bibliography", async () => {
        let requests = 0;
        let active = 0;
        let maxActive = 0;
        vi.stubGlobal("fetch", vi.fn(async () => {
            requests++;
            maxActive = Math.max(maxActive, ++active);
            // Keep all initial requests pending long enough to expose duplicate work.
            await new Promise(resolve => setTimeout(resolve, 1));
            active--;
            return new Response(JSON.stringify({is_oa: false}), {status: 200});
        }));
        const results = await Promise.all(Array.from({length: 100}, (_, i) =>
            fetchOpenAccess(`10.1000/repeated-${i % 10}`)));
        expect(results).toHaveLength(100);
        expect(results.every(result => result?.isOa === false)).toBe(true);
        expect(requests).toBe(10);
        expect(maxActive).toBe(4);
    });

    it("shares a failed request but lets an explicit retry reach the provider", async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(null, {status: 503}))
            .mockResolvedValueOnce(new Response(JSON.stringify({is_oa: false})));
        vi.stubGlobal("fetch", fetchMock);
        expect(await Promise.all([fetchOpenAccess("10.1000/retry"), fetchOpenAccess("10.1000/retry")]))
            .toEqual([null, null]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(await fetchOpenAccess("10.1000/retry")).toMatchObject({isOa: false});
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not join a request using an email the user has corrected", async () => {
        let finishOld!: (response: Response) => void;
        const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => {
            finishOld = resolve;
        })).mockResolvedValueOnce(new Response(JSON.stringify({is_oa: false})));
        vi.stubGlobal("fetch", fetchMock);
        const old = fetchOpenAccess("10.1000/email");
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        settings.email = "corrected@example.org";
        expect(await fetchOpenAccess("10.1000/email")).toMatchObject({isOa: false});
        expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get("email")).toBe(settings.email);
        finishOld(new Response(null, {status: 422}));
        expect(await old).toBeNull();
    });
});
