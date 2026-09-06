import {describe, it, expect, vi, afterEach} from "vitest";
import {RequestGate} from "../../src/shared/request-gate";

function deferredFetch() {
    const pending: Array<(r: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);
    return {fetchMock, pending};
}

describe("RequestGate", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("honours a longer cooldown returned by the final retry", async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response("", {status: 429, headers: {"retry-after": "1"}}))
            .mockResolvedValueOnce(new Response("", {status: 429, headers: {"retry-after": "60"}}))
            .mockResolvedValue(new Response("ok"));
        vi.stubGlobal("fetch", fetchMock);
        const gate = new RequestGate("Test", 1);
        const request = gate.fetch("https://x/1");
        await vi.advanceTimersByTimeAsync(1000);
        expect((await request).status).toBe(429);
        await expect(gate.fetch("https://x/2")).rejects.toThrow(/rate limited/);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(60000);
        expect((await gate.fetch("https://x/3")).status).toBe(200);
    });

    it("rechecks a cooldown learned while another request waits for its start slot", async () => {
        vi.useFakeTimers();
        const {fetchMock, pending} = deferredFetch();
        const gate = new RequestGate("Test", 2, 1000);
        const first = gate.fetch("https://x/1");
        const second = gate.fetch("https://x/2");
        const secondOutcome = second.then(() => "sent", (err: Error) => err.message);
        await vi.advanceTimersByTimeAsync(100);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        pending.shift()!(new Response("", {status: 429, headers: {"retry-after": "60"}}));
        await first;
        await vi.advanceTimersByTimeAsync(900);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(await secondOutcome).toMatch(/rate limited/);
    });

    it("preserves start spacing when a short cooldown moves multiple waiting requests", async () => {
        vi.useFakeTimers();
        const starts: number[] = [];
        const fetchMock = vi.fn(async () => {
            starts.push(Date.now());
            return starts.length === 1
                ? new Response("", {status: 429, headers: {"retry-after": "2"}})
                : new Response("ok");
        });
        vi.stubGlobal("fetch", fetchMock);
        const gate = new RequestGate("Test", 3, 100);
        const requests = [1, 2, 3].map(i => gate.fetch(`https://x/${i}`));
        await vi.advanceTimersByTimeAsync(2500);
        await Promise.all(requests);
        expect(starts).toHaveLength(4);
        for (let i = 1; i < starts.length; i++) {
            expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(100);
        }
    });

    it("keeps at most the configured number of requests in flight", async () => {
        const {fetchMock, pending} = deferredFetch();
        const gate = new RequestGate("Test", 2);
        const calls = [1, 2, 3, 4].map((i) => gate.fetch(`https://x/${i}`));
        await Promise.resolve();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        pending.shift()!(new Response("", {status: 200}));
        await calls[0];
        expect(fetchMock).toHaveBeenCalledTimes(3);
        for (const resolve of pending.splice(0)) resolve(new Response("", {status: 200}));
        await Promise.all(calls.slice(1, 3));
        expect(fetchMock).toHaveBeenCalledTimes(4);
        pending.shift()!(new Response("", {status: 200}));
        await Promise.all(calls);
        vi.unstubAllGlobals();
    });

    it("waits out Retry-After on a 429 and retries once", async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response("", {status: 429, headers: {"retry-after": "2"}}))
            .mockResolvedValueOnce(new Response("ok", {status: 200}));
        vi.stubGlobal("fetch", fetchMock);
        const gate = new RequestGate("Test", 1);
        const request = gate.fetch("https://x/1");
        await vi.advanceTimersByTimeAsync(1_999);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2);
        expect((await request).status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("blocks the platform on a long Retry-After instead of queueing behind it", async () => {
        const fetchMock = vi.fn()
            .mockResolvedValue(new Response("", {status: 429, headers: {"retry-after": "39000"}}));
        vi.stubGlobal("fetch", fetchMock);
        const gate = new RequestGate("Test", 2);
        expect((await gate.fetch("https://x/1")).status).toBe(429);
        await expect(gate.fetch("https://x/2")).rejects.toThrow(/rate limited/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        vi.unstubAllGlobals();
    });
});
