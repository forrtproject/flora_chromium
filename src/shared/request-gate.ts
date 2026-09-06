import {debugWarn} from "./debug";

/** Run `worker` over `items` with at most `limit` in flight. */
export async function mapWithLimit<T>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<void>,
): Promise<void> {
    let next = 0;
    const runners = Array.from({length: Math.min(limit, items.length)}, async () => {
        while (next < items.length) {
            await worker(items[next++]);
        }
    });
    await Promise.all(runners);
}

const DEFAULT_BACKOFF_MS = 1_000;
/** Longest pause a request will sit out; a longer Retry-After blocks the platform instead. */
const MAX_WAIT_MS = 5_000;

function parseRetryAfter(header: string | null): number | null {
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return seconds * 1000;
    const at = Date.parse(header);
    return Number.isNaN(at) ? null : at - Date.now();
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Per-platform fetch gate: caps concurrent requests, spaces their starts by
 * `minIntervalMs`, and on HTTP 429 pauses the platform for `Retry-After`
 * (default 1 s). A short pause is waited out and the request retried once; a
 * long one (an exhausted daily budget) blocks the platform until it lapses,
 * and requests arriving meanwhile fail at once instead of queueing.
 */
export class RequestGate {
    private active = 0;
    private readonly waiting: Array<() => void> = [];
    private blockedUntil = 0;
    private nextStartAt = 0;

    constructor(
        private readonly name: string,
        private readonly maxConcurrent: number,
        private readonly minIntervalMs = 0,
    ) {}

    async fetch(url: string, init?: RequestInit): Promise<Response> {
        await this.acquire();
        try {
            for (let attempt = 0; ; attempt++) {
                const now = Date.now();
                const startAt = Math.max(now, this.nextStartAt, this.blockedUntil);
                if (startAt - now > MAX_WAIT_MS) {
                    throw new Error(`${this.name} rate limited (paused for another ${Math.round((startAt - now) / 1000)} s)`);
                }
                this.nextStartAt = startAt + this.minIntervalMs;
                if (startAt > now) await sleep(startAt - now);

                // Another in-flight request may have extended the platform's
                // cooldown while this request waited for its reserved start.
                while (this.blockedUntil > Date.now()) {
                    const remaining = this.blockedUntil - Date.now();
                    if (remaining > MAX_WAIT_MS) {
                        throw new Error(`${this.name} rate limited (paused for another ${Math.round(remaining / 1000)} s)`);
                    }
                    await sleep(remaining);
                }

                const response = await fetch(url, init);
                if (response.status !== 429) return response;

                const backoff = parseRetryAfter(response.headers.get("retry-after")) ?? DEFAULT_BACKOFF_MS;
                this.blockedUntil = Math.max(this.blockedUntil, Date.now() + backoff);
                if (attempt > 0) return response;
                if (backoff > MAX_WAIT_MS) {
                    debugWarn(`${this.name}: HTTP 429 with Retry-After ${Math.round(backoff / 1000)} s — pausing this platform until then`);
                    return response;
                }
                debugWarn(`${this.name}: HTTP 429 — pausing ${backoff} ms, then retrying once`);
            }
        } finally {
            this.release();
        }
    }

    private acquire(): Promise<void> {
        if (this.active < this.maxConcurrent) {
            this.active++;
            return Promise.resolve();
        }
        return new Promise((resolve) => this.waiting.push(() => { this.active++; resolve(); }));
    }

    private release(): void {
        this.active--;
        this.waiting.shift()?.();
    }
}
