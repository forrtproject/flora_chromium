/** Defer provider traffic in background tabs; recheck page/cancellation state after awaiting. */
export function waitUntilVisible(): Promise<void> {
    if (document.visibilityState !== "hidden") return Promise.resolve();
    return new Promise(resolve => {
        const onVisible = () => {
            if (document.visibilityState === "hidden") return;
            document.removeEventListener("visibilitychange", onVisible);
            resolve();
        };
        document.addEventListener("visibilitychange", onVisible);
    });
}
