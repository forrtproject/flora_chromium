import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { atlasDoiUrl, bindAtlasLink, needsAtlasSet } from "../../src/shared/flora-atlas";
import { doi } from "../helpers";
import type { DoiString } from "../../src/shared/types";

function dois(count: number, tag: string): DoiString[] {
    return Array.from({ length: count }, (_, i) => doi(`10.1234/journal.${tag}.article.${i}`));
}

function anchor(): HTMLAnchorElement {
    const el = document.createElement("a");
    document.body.appendChild(el);
    return el;
}

function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("atlas links for long DOI lists", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
        vi.mocked(chrome.runtime.sendMessage).mockReset();
        vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
            type: "FLORA_CREATE_SET_RESULT",
            setId: "abc123",
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("keeps a short list on the ?doi= URL and asks for no set", async () => {
        const few = dois(3, "short");
        const el = anchor();

        bindAtlasLink(el, few);
        await flush();

        expect(el.href).toBe(atlasDoiUrl(few));
        expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it("swaps a long list onto the ?set= URL", async () => {
        const many = dois(100, "swap");
        expect(needsAtlasSet(many)).toBe(true);
        const el = anchor();

        bindAtlasLink(el, many);
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
            type: "FLORA_CREATE_SET",
            dois: many,
        });

        await flush();
        expect(el.href).toBe("https://forrt.org/flora-replication-atlas/?set=abc123");
    });

    it("creates one set for a list rendered twice", async () => {
        const many = dois(100, "repeat");

        bindAtlasLink(anchor(), many);
        await flush();
        bindAtlasLink(anchor(), many);
        await flush();

        expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("falls back to the ?doi= URL when the set cannot be created", async () => {
        vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
            type: "FLORA_CREATE_SET_RESULT",
            setId: null,
        });
        const many = dois(100, "fallback");
        const el = anchor();

        bindAtlasLink(el, many);
        await flush();

        expect(el.href).toBe(atlasDoiUrl(many));
    });

    it("retries the set after a failed attempt", async () => {
        vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce({
            type: "FLORA_CREATE_SET_RESULT",
            setId: null,
        });
        const many = dois(100, "retry");

        bindAtlasLink(anchor(), many);
        await flush();
        const el = anchor();
        bindAtlasLink(el, many);
        await flush();

        expect(el.href).toBe("https://forrt.org/flora-replication-atlas/?set=abc123");
    });

    it("reserves a tab on a click made before the set id arrives, then navigates it", async () => {
        const reserved = { opener: {} as unknown, location: { replace: vi.fn() } };
        const open = vi.fn().mockReturnValue(reserved);
        vi.stubGlobal("open", open);
        let release: (value: unknown) => void = () => { };
        vi.mocked(chrome.runtime.sendMessage).mockReturnValue(
            new Promise((resolve) => { release = resolve; })
        );
        const el = anchor();
        bindAtlasLink(el, dois(100, "click"));

        const click = new MouseEvent("click", { cancelable: true });
        el.dispatchEvent(click);

        expect(click.defaultPrevented).toBe(true);
        expect(open).toHaveBeenCalledWith("", "_blank");
        expect(reserved.opener).toBeNull();
        expect(reserved.location.replace).not.toHaveBeenCalled();

        release({ type: "FLORA_CREATE_SET_RESULT", setId: "abc123" });
        await flush();

        expect(reserved.location.replace).toHaveBeenCalledWith(
            "https://forrt.org/flora-replication-atlas/?set=abc123"
        );
    });

    it("navigates the reserved tab to the ?doi= URL when the set fails", async () => {
        const reserved = { opener: {} as unknown, location: { replace: vi.fn() } };
        vi.stubGlobal("open", vi.fn().mockReturnValue(reserved));
        let release: (value: unknown) => void = () => { };
        vi.mocked(chrome.runtime.sendMessage).mockReturnValue(
            new Promise((resolve) => { release = resolve; })
        );
        const many = dois(100, "click-fails");
        const el = anchor();
        bindAtlasLink(el, many);

        el.dispatchEvent(new MouseEvent("click", { cancelable: true }));
        release({ type: "FLORA_CREATE_SET_RESULT", setId: null });
        await flush();

        expect(reserved.location.replace).toHaveBeenCalledWith(atlasDoiUrl(many));
    });

    it("lets the browser follow the link when the tab cannot be reserved", async () => {
        vi.stubGlobal("open", vi.fn().mockReturnValue(null));
        vi.mocked(chrome.runtime.sendMessage).mockReturnValue(new Promise(() => { }));
        const el = anchor();
        bindAtlasLink(el, dois(100, "blocked"));

        let heldByBinding = true;
        el.addEventListener("click", (event) => {
            heldByBinding = event.defaultPrevented;
            event.preventDefault();
        });
        el.dispatchEvent(new MouseEvent("click", { cancelable: true }));

        expect(heldByBinding).toBe(false);
    });

});
