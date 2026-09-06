/** Defer provider traffic; false means cancellation or page teardown stopped the wait. */
export function waitUntilVisible(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    if (document.visibilityState !== "hidden") return Promise.resolve(true);
    return new Promise(resolve => {
        const finish = (visible: boolean) => {
            document.removeEventListener("visibilitychange", onVisible);
            window.removeEventListener("pagehide", onPageHide);
            signal?.removeEventListener("abort", onAbort);
            resolve(visible);
        };
        const onVisible = () => {
            if (document.visibilityState !== "hidden") finish(true);
        };
        const onAbort = () => finish(false);
        const onPageHide = (event: PageTransitionEvent) => {
            // A bfcache page may become visible again; a discarded page will not.
            if (!event.persisted) finish(false);
        };
        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("pagehide", onPageHide);
        signal?.addEventListener("abort", onAbort, {once: true});
    });
}
