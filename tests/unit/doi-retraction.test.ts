import {describe, it, expect, vi, beforeEach} from "vitest";
import {doi} from "../helpers";

// retractionCheck now runs in the content scripts purely as a thin client: it
// asks the background service worker (which owns the data) for a verdict. These
// tests pin that message contract; the lookup logic itself is covered by the
// service-worker tests.
describe("doi retraction content helper", () => {
    beforeEach(() => {
        vi.resetModules();
        (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockReset();
    });

    it("requests retraction checks from the background service worker", async () => {
        const originalDoi = doi("10.1038/nature12373");
        (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
            type: "FLORA_RET_CHECK_RESULT",
            results: [{originDoi: originalDoi, doi: "10.1038/retraction", kind: "retraction"}],
        });

        const {retractionCheck} = await import("../../src/shared/doi-retraction");
        const result = await retractionCheck([originalDoi]);

        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            type: "FLORA_RET_CHECK",
            dois: [originalDoi],
        });
        expect(result).toEqual([
            {originDoi: originalDoi, doi: "10.1038/retraction", kind: "retraction"},
        ]);
    });

    it("passes expression-of-concern verdicts through unchanged", async () => {
        const originalDoi = doi("10.5678/eoc-paper");
        (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
            type: "FLORA_RET_CHECK_RESULT",
            results: [{originDoi: originalDoi, doi: "10.5678/eoc-notice", kind: "concern"}],
        });

        const {retractionCheck} = await import("../../src/shared/doi-retraction");
        await expect(retractionCheck([originalDoi])).resolves.toEqual([
            {originDoi: originalDoi, doi: "10.5678/eoc-notice", kind: "concern"},
        ]);
    });

    it("coalesces same-tick checks into one message", async () => {
        const retracted = doi("10.1038/nature12373");
        const clean = doi("10.1234/fine");
        (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
            type: "FLORA_RET_CHECK_RESULT",
            results: [{originDoi: retracted, doi: "10.1038/retraction", kind: "retraction"}],
        });

        const {retractionCheck} = await import("../../src/shared/doi-retraction");
        const [first, second] = await Promise.all([
            retractionCheck([retracted]),
            retractionCheck([clean]),
        ]);

        expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            type: "FLORA_RET_CHECK",
            dois: [retracted, clean],
        });
        // Each caller gets only what it asked about.
        expect(first).toEqual([{originDoi: retracted, doi: "10.1038/retraction", kind: "retraction"}]);
        expect(second).toEqual([]);
    });

    it("rejects unexpected responses instead of treating them as no notices", async () => {
        (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
            type: "FLORA_LOOKUP_RESULT",
            results: {},
            errors: {},
        });

        const {retractionCheck} = await import("../../src/shared/doi-retraction");
        await expect(retractionCheck([doi("10.1038/nature12373")])).rejects.toThrow("unavailable");
    });

    it("preserves a worker error and allows the next attempt to confirm no notices", async () => {
        vi.mocked(chrome.runtime.sendMessage)
            .mockResolvedValueOnce({type: "FLORA_RET_CHECK_RESULT", results: [], error: "Retraction data unavailable"})
            .mockResolvedValueOnce({type: "FLORA_RET_CHECK_RESULT", results: []});
        const {retractionCheck} = await import("../../src/shared/doi-retraction");
        await expect(retractionCheck([doi("10.1234/paper")])).rejects.toThrow("Retraction data unavailable");
        await expect(retractionCheck([doi("10.1234/paper")])).resolves.toEqual([]);
        expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
    });

    it("gives up on a worker that never answers so the pass can continue", async () => {
        vi.useFakeTimers();
        try {
            (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
            const {retractionCheck, RETRACTION_CHECK_TIMEOUT_MS} = await import("../../src/shared/doi-retraction");
            const pending = retractionCheck([doi("10.1038/nature12373")]);
            const assertion = expect(pending).rejects.toThrow("timed out");
            await vi.advanceTimersByTimeAsync(RETRACTION_CHECK_TIMEOUT_MS + 1);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });
});
