import {afterEach, expect, it, vi} from "vitest";
import {fetchWithDeadline, runWorkerRequest, cancelWorkerRequest, beginCancellableWork, cancelWork, endCancellableWork} from "../../src/shared/work-cancellation";
import {SharedRequest} from "../../src/shared/shared-request";
import {RequestGate} from "../../src/shared/request-gate";

import {safeSendMessage} from "../../src/shared/messages";

afterEach(() => { endCancellableWork(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("aborts a stalled response body at its deadline", async () => {
    vi.useFakeTimers();
    // Use a real streaming Response; the fetch stub only supplies the transport.
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => new Response(new ReadableStream({
        start(controller) { init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason), {once: true}); },
    }))));
    const response = await fetchWithDeadline("https://example.org/body", {}, 100);
    const outcome = expect(response.text()).rejects.toMatchObject({name: "TimeoutError"});
    await vi.advanceTimersByTimeAsync(100);
    await outcome;
});

it("cancels an active transport and removes queued requests before they start", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
        calls.push(url);
        return new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), {once: true}));
    }));
    const gate = new RequestGate("test", 1);
    const controller = new AbortController();
    const first = gate.fetch("https://example.org/active", {signal: controller.signal});
    const queued = gate.fetch("https://example.org/queued", {signal: controller.signal});
    const outcomes = Promise.allSettled([first, queued]);
    await Promise.resolve();
    controller.abort();
    expect((await outcomes).map(r => r.status)).toEqual(["rejected", "rejected"]);
    expect(calls).toEqual(["https://example.org/active"]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok")));
    expect((await gate.fetch("https://example.org/next")).status).toBe(200);
});

it("keeps shared work alive for another caller, then aborts when the last caller leaves", async () => {
    let transport!: AbortSignal;
    const shared = new SharedRequest(signal => {
        transport = signal;
        return new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    });
    const first = new AbortController();
    const second = new AbortController();
    const outcomes = Promise.allSettled([shared.subscribe(first.signal), shared.subscribe(second.signal)]);
    await Promise.resolve();
    first.abort();
    expect(transport.aborted).toBe(false);
    second.abort();
    expect(transport.aborted).toBe(true);
    expect((await outcomes).every(r => r.status === "rejected")).toBe(true);
});

it("does not let another document cancel a worker request with the same id", async () => {
    const request = {requestId: "same-id"};
    const sender = {tab: {id: 1}, documentId: "document-a"} as chrome.runtime.MessageSender;
    let signal!: AbortSignal;
    const pending = runWorkerRequest(request, sender, current => {
        signal = current!;
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    });
    const outcome = expect(pending).rejects.toMatchObject({name: "AbortError"});
    cancelWorkerRequest(request, {...sender, documentId: "document-b"});
    expect(signal.aborted).toBe(false);
    cancelWorkerRequest(request, sender);
    await outcome;
});


it("cancels worker messages on HTTP pages and permits user actions after the pass ends", async () => {
    vi.stubGlobal("crypto", {getRandomValues: crypto.getRandomValues.bind(crypto)});
    chrome.runtime.sendMessage = vi.fn().mockImplementation((message) => message.type === "FLORA_CANCEL_REQUEST"
        ? Promise.resolve() : new Promise(() => {}));
    beginCancellableWork();
    const request = safeSendMessage({type: "FLORA_LOOKUP", dois: ["10.1234/a"]});
    const outcome = expect(request).rejects.toMatchObject({name: "AbortError"});
    cancelWork();
    await outcome;
    const calls = vi.mocked(chrome.runtime.sendMessage).mock.calls;
    expect(calls[1][0]).toEqual({type: "FLORA_CANCEL_REQUEST", requestId: calls[0][0].requestId});
    endCancellableWork();
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({setId: "new-set"});
    expect(await safeSendMessage({type: "FLORA_CREATE_SET", dois: ["10.1234/a"]})).toEqual({setId: "new-set"});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("citation")));
    expect(await (await fetchWithDeadline("https://example.org/citation")).text()).toBe("citation");
});

it("keeps an explicit user request independent while a scan is being cancelled", async () => {
    let transport!: AbortSignal;
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
        transport = init.signal!;
        return new Response("citation");
    }));
    beginCancellableWork();
    const response = await fetchWithDeadline("https://example.org/citation", {signal: null});
    cancelWork();
    expect(transport.aborted).toBe(false);
    expect(await response.text()).toBe("citation");
});
