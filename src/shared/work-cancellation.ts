// Each content-script context owns its scan's cancellation signal.
let controller = new AbortController();
let started = false;
let cancelledPage: string | null = null;
/** Automatic passes stay stopped on this page until navigation or an explicit resume. */
export function canStartAutomaticWork(): boolean {
  if (cancelledPage !== null && cancelledPage !== location.href) cancelledPage = null;
  return cancelledPage === null;
}
export function resumeAutomaticWork(): void { cancelledPage = null; }
export const activeWorkSignal = (): AbortSignal | undefined => started ? controller.signal : undefined;
export const workSignal = (): AbortSignal => controller.signal;
export function beginCancellableWork(): void {
  started = true;
  if (controller.signal.aborted) controller = new AbortController();
}
export function endCancellableWork(): void { started = false; }
export function cancelWork(): void {
  cancelledPage = location.href;
  controller.abort(new DOMException("Work cancelled", "AbortError"));
}

export function abortableDelay(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, {once: true});
  });
}

/** Bound both headers and response-body reads; cancellation aborts the transport. */
export async function fetchWithDeadline(url: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  // Explicit null keeps user-triggered requests independent of the page scan.
  const parent = init.signal === undefined ? activeWorkSignal() : init.signal;
  parent?.throwIfAborted();
  const deadline = new AbortController();
  const abort = () => deadline.abort(parent?.reason);
  const cleanup = () => { clearTimeout(timer); parent?.removeEventListener("abort", abort); };
  const timer = setTimeout(() => deadline.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);
  parent?.addEventListener("abort", abort, {once: true});
  deadline.signal.addEventListener("abort", cleanup, {once: true});
  try {
    // The deadline deliberately remains armed after headers arrive, covering
    // a body that stalls. Its bounded lifetime also releases the parent listener.
    return await fetch(url, {...init, signal: deadline.signal});
  } catch (err) {
    cleanup();
    throw err;
  }
}

// Requests already sent to the worker must be cancelled there too. A caller
// can cancel only its own document/frame, never another tab's request id.
const workerRequests = new Map<string, AbortController>();
function requestKey(message: unknown, sender: chrome.runtime.MessageSender): string | null {
  const id = (message as {requestId?: unknown} | null)?.requestId;
  if (typeof id !== "string" || id.length > 100 || sender.tab?.id == null) return null;
  return `${sender.tab.id}:${sender.documentId ?? sender.frameId ?? 0}:${id}`;
}
export function cancelWorkerRequest(message: unknown, sender: chrome.runtime.MessageSender): void {
  const key = requestKey(message, sender);
  if (key) workerRequests.get(key)?.abort(new DOMException("Work cancelled", "AbortError"));
}
export async function runWorkerRequest<T>(message: unknown, sender: chrome.runtime.MessageSender, run: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  const key = requestKey(message, sender);
  if (!key) return run();
  const request = new AbortController();
  workerRequests.set(key, request);
  try { return await run(request.signal); }
  finally { if (workerRequests.get(key) === request) workerRequests.delete(key); }
}
