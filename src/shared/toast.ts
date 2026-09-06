// Transient confirmation toast for pill actions (copy DOI, copy citation).
//
// The pill's own buttons flash an icon and change their tooltip, but a tooltip
// only reports to a reader already hovering the button they just clicked. The
// toast confirms the action landed — and, more importantly, reports when it
// did not, which the optimistic icon flash cannot.
//
// One toast element is reused: a second action replaces the first rather than
// stacking, so rapid clicks down a reference list never pile up.

import {WORK_TOAST_ID} from "./progress-toast";

const TOAST_ID = "flora-action-toast";
const ALERT_TOAST_ID = "flora-alert-toast";

export type ToastTone = "success" | "error" | "pending" | "info";

const TONE_BACKGROUND: Record<ToastTone, string> = {
    success: "linear-gradient(135deg,#853953,#612D53)",
    error: "linear-gradient(135deg,#b3261e,#8c1d18)",
    pending: "linear-gradient(135deg,#853953,#612D53)",
    info: "#f1f5f9",
};

const CHECK_SVG =
    `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" style="display:block;flex-shrink:0;">` +
    `<path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 ` +
    `1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"></path></svg>`;

const ALERT_SVG =
    `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" style="display:block;flex-shrink:0;">` +
    `<path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 ` +
    `1.75 0 0 1-1.543-2.575Zm-.061 8.201a.75.75 0 0 1 .75-.75h1.708a.75.75 0 0 1 0 1.5H7.146a.75.75 0 0 1 ` +
    `-.75-.75Zm.75-5.248a.75.75 0 0 1 1.5 0v3a.75.75 0 0 1-1.5 0Z"></path>` +
    `<circle cx="8" cy="12" r="1"></circle></svg>`;

const INFO_SVG =
    `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="display:block;flex-shrink:0;">` +
    `<circle cx="8" cy="8" r="6.25"/><path d="M8 7v4" stroke-linecap="round"/>` +
    `<circle cx="8" cy="4.75" r=".75" fill="currentColor" stroke="none"/></svg>`;

const SPIN_KEYFRAMES = "@keyframes flora-toast-spin{to{transform:rotate(360deg)}}";

const ACTION_STYLE =
    "all:unset;box-sizing:border-box;border:1px solid rgba(255,255,255,0.45);color:#fff;" +
    "font-family:inherit;font-size:11px;font-weight:600;line-height:1.3;padding:3px 9px;" +
    "border-radius:5px;cursor:pointer;pointer-events:auto;white-space:nowrap;flex-shrink:0;";

const CLOSE_STYLE =
    "all:unset;box-sizing:border-box;color:rgba(255,255,255,0.75);font-family:inherit;" +
    "font-size:13px;line-height:1;padding:2px 4px;border-radius:4px;cursor:pointer;" +
    "pointer-events:auto;flex-shrink:0;";

let dismissTimer: ReturnType<typeof setTimeout> | null = null;
let removeTimer: ReturnType<typeof setTimeout> | null = null;

function hostId(action: ToastAction | undefined): string {
    return action ? ALERT_TOAST_ID : TOAST_ID;
}

function positionAlert(): void {
    const alert = document.getElementById(ALERT_TOAST_ID);
    if (!alert) return;
    const routine = document.getElementById(TOAST_ID);
    const base = parseInt(bottomOffset(), 10);
    alert.style.bottom = routine ? `${base + (routine.offsetHeight || 34) + 10}px` : `${base}px`;
}

function clearTimers(): void {
    if (dismissTimer) {
        clearTimeout(dismissTimer);
        dismissTimer = null;
    }
    if (removeTimer) {
        clearTimeout(removeTimer);
        removeTimer = null;
    }
}

/**
 * Sit above the progress toast when it is on screen — both anchor to the
 * bottom-right corner, and a citation fetch can easily overlap a page scan.
 * Measured, since a wrapped stage label makes it taller; the fallback covers
 * a layout-less document (tests).
 */
function bottomOffset(): string {
    const working = document.getElementById(WORK_TOAST_ID);
    if (!working) return "18px";
    return `${18 + (working.offsetHeight || 46) + 10}px`;
}

function ensureToast(id: string): HTMLElement {
    const existing = document.getElementById(id);
    if (existing) return existing;

    const host = document.createElement("div");
    host.id = id;
    // Marks the toast as FLoRA's own so the DOI extractor doesn't rescan its
    // text and the DOM listener doesn't treat it as a page change.
    host.setAttribute("data-flora-ui", "");
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");

    const style = document.createElement("style");
    style.textContent = SPIN_KEYFRAMES +
        "#flora-action-toast[data-flora-tone=info] button:focus-visible," +
        "#flora-alert-toast[data-flora-tone=info] button:focus-visible" +
        "{outline:2px solid #64748b;outline-offset:2px;}";
    host.appendChild(style);

    document.body.appendChild(host);
    return host;
}

function iconFor(tone: ToastTone): HTMLElement {
    const icon = document.createElement("span");
    if (tone === "pending") {
        icon.style.cssText =
            "width:12px;height:12px;border-radius:50%;flex-shrink:0;box-sizing:border-box;" +
            "border:2px solid rgba(255,255,255,0.35);border-top-color:#fff;" +
            "animation:flora-toast-spin 0.7s linear infinite;";
        return icon;
    }
    icon.style.cssText = "display:flex;align-items:center;line-height:0;flex-shrink:0;";
    icon.innerHTML = tone === "success" ? CHECK_SVG : tone === "info" ? INFO_SVG : ALERT_SVG;
    return icon;
}

export interface ToastAction {
    label: string;
    onClick: () => void | Promise<void>;
}

export interface ToastOptions {
    tone?: ToastTone;
    /** Milliseconds before the toast fades. 0 keeps it up until it is replaced. */
    duration?: number;
    action?: ToastAction;
    /** Keep asynchronous recovery available until its owner dismisses the alert. */
    dismissOnAction?: boolean;
}

/**
 * Show a toast in the bottom-right corner. Returns the toast element so a
 * caller can keep a reference, though replacing it via another `showToast`
 * call is the normal way to update it.
 */
export function showToast(message: string, options: ToastOptions = {}): HTMLElement {
    const tone = options.tone ?? "success";
    const action = options.action;
    const duration = options.duration ?? (action ? 0 : tone === "error" ? 2600 : 2000);

    if (!action) clearTimers();
    const host = ensureToast(hostId(action));
    host.setAttribute("data-flora-tone", tone);

    // Keep the <style> child (the spinner keyframes) and rebuild the content.
    for (const child of [...host.children]) {
        if (child.tagName !== "STYLE") child.remove();
    }

    host.style.cssText =
        `position:fixed;bottom:${bottomOffset()};right:18px;z-index:2147483647;` +
        `display:flex;align-items:center;gap:8px;pointer-events:${action ? "auto" : "none"};` +
        `background:${TONE_BACKGROUND[tone]};color:${tone === "info" ? "#334155" : "#fff"};` +
        (tone === "info" ? "border:1px solid #cbd5e1;" : "") +
        "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
        "font-size:12px;font-weight:500;line-height:1.4;padding:8px 12px;border-radius:8px;" +
        `max-width:280px;box-shadow:${tone === "info" ? "0 2px 8px rgba(15,23,42,0.10)" : "0 4px 16px rgba(0,0,0,0.18)"};` +
        "opacity:0;transform:translateY(6px);transition:opacity 0.18s ease,transform 0.18s ease;";

    host.appendChild(iconFor(tone));

    const label = document.createElement("span");
    label.textContent = message;
    host.appendChild(label);

    if (action) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = action.label;
        button.style.cssText = ACTION_STYLE + (tone === "info" ? "color:#334155;background:#fff;border-color:#94a3b8;" : "");
        button.addEventListener("click", () => {
            void action.onClick();
            if (options.dismissOnAction !== false) dismissAlertToast();
        });
        host.appendChild(button);

        const close = document.createElement("button");
        close.type = "button";
        close.textContent = "\u00d7";
        close.title = "Dismiss";
        close.setAttribute("aria-label", "Dismiss");
        close.style.cssText = CLOSE_STYLE + (tone === "info" ? "color:#64748b;" : "");
        close.addEventListener("click", () => dismissAlertToast());
        host.appendChild(close);
    }

    requestAnimationFrame(() => {
        host.style.opacity = "1";
        host.style.transform = "translateY(0)";
    });

    if (duration > 0) {
        dismissTimer = setTimeout(() => {
            host.style.opacity = "0";
            host.style.transform = "translateY(6px)";
            removeTimer = setTimeout(() => {
                host.remove();
                positionAlert();
            }, 200);
        }, duration);
    }

    positionAlert();
    return host;
}

/** Remove the toast immediately — used by tests and teardown. */
export function dismissToast(): void {
    clearTimers();
    document.getElementById(TOAST_ID)?.remove();
    document.getElementById(ALERT_TOAST_ID)?.remove();
}

export function dismissAlertToast(): void {
    document.getElementById(ALERT_TOAST_ID)?.remove();
}
