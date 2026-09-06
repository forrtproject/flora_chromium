/** A deduplicated request aborts its transport only after its last caller leaves. */
export class SharedRequest<T> {
  private controller = new AbortController();
  private pending: Promise<T> | null = null;
  private callers = 0;
  private settled = false;
  get aborted(): boolean { return this.controller.signal.aborted; }

  constructor(private readonly run: (signal: AbortSignal) => Promise<T>) {}

  subscribe(signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    this.callers++;
    if (!this.pending) {
      this.pending = Promise.resolve().then(() => this.run(this.controller.signal))
        .finally(() => { this.settled = true; });
    }
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (callback: () => void) => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", abort);
        this.callers--;
        if (!this.callers && !this.settled) this.controller.abort();
        callback();
      };
      const abort = () => finish(() => reject(signal?.reason));
      signal?.addEventListener("abort", abort, {once: true});
      this.pending!.then(value => finish(() => resolve(value)), err => finish(() => reject(err)));
    });
  }
}
