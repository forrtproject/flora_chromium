/**
 * Debug logger — gated by a flag in chrome.storage.local.
 *
 * When debug mode is on, every debugLog/Warn/Error call is both printed to the
 * console and captured into a persistent log the user can attach to an issue
 * report (see debug-log.ts for the store and debug-report.ts for the report).
 *
 * Capture is deliberately one-way: contexts that can't own the store (content
 * scripts, popup, options) batch their entries and ship them to the service
 * worker, which is the single writer. The worker installs a direct sink at
 * startup so its own entries skip the message round-trip.
 */

import { redactDebugText } from "./debug-redact";

export type DebugLevel = "log" | "warn" | "error";

/** One captured line. Kept small — hundreds of these are persisted at a time. */
export interface DebugLogEntry {
  /** Epoch milliseconds. */
  t: number;
  level: DebugLevel;
  /** Where it came from: "background", "popup", "options", or a page hostname. */
  ctx: string;
  msg: string;
}

/** Receives batches of captured entries. Installed by the service worker. */
export type DebugSink = (entries: DebugLogEntry[]) => void;

export interface RuntimeErrorInfo {
  message: string;
  stack?: string;
  where?: string;
}

export type RuntimeErrorListener = (info: RuntimeErrorInfo) => void;

export const DEBUG_FLAG_KEY = "flora_debug";

/** Longest single captured message; anything beyond this is truncated. */
const MAX_MESSAGE_CHARS = 2000;
/** Entries are shipped once the batch reaches this size… */
const FLUSH_AT_ENTRIES = 25;
/** …or after this long, whichever comes first. */
const FLUSH_DELAY_MS = 800;

const RECENT_LIMIT = 60;

const OWN_REPO_PATH = "/forrtproject/chromium-extension";

function isOwnIssueTracker(): boolean {
  try {
    if (typeof location === "undefined") return false;
    return /(^|\.)github\.com$/.test(location.hostname) && location.pathname.startsWith(OWN_REPO_PATH);
  } catch {
    return false;
  }
}

let _enabled = false;
let _initialized = false;

let sink: DebugSink | null = null;
let pending: DebugLogEntry[] = [];
let recent: DebugLogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let context: string | null = null;
let onRuntimeError: RuntimeErrorListener | null = null;

/** MV3 service workers have no `window`; every other extension context does. */
function isServiceWorker(): boolean {
  return typeof window === "undefined" && typeof self !== "undefined";
}

/** Human-readable label for the context this logger instance runs in. */
function detectContext(): string {
  if (isServiceWorker()) return "background";
  try {
    if (typeof location === "undefined") return "unknown";
    if (location.protocol === "chrome-extension:") {
      const page = location.pathname.split("/").pop() ?? "";
      return page.replace(/\.html$/, "") || "extension";
    }
    return location.hostname || "page";
  } catch {
    return "unknown";
  }
}

const MAX_STACK_FRAMES = 8;

function formatError(err: Error): string {
  const head = `${err.name}: ${err.message}`;
  const frames = (err.stack ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, MAX_STACK_FRAMES);
  const cause = err.cause instanceof Error ? `\ncaused by ${err.cause.name}: ${err.cause.message}` : "";
  return frames.length > 0 ? `${head}\n${frames.join("\n")}${cause}` : `${head}${cause}`;
}

function stringifyArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return formatError(arg);
  if (arg === null) return "null";
  if (arg === undefined) return "undefined";
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    // Circular or otherwise unserialisable — the type name is still a clue.
    return Object.prototype.toString.call(arg);
  }
}

function formatMessage(args: unknown[]): string {
  const text = redactDebugText(args.map(stringifyArg).join(" "));
  return text.length > MAX_MESSAGE_CHARS
    ? `${text.slice(0, MAX_MESSAGE_CHARS)}… (truncated)`
    : text;
}

function flush(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pending.length === 0) return;

  const batch = pending;
  pending = [];

  if (sink) {
    sink(batch);
    return;
  }

  try {
    // Fire-and-forget: a missing receiver (worker asleep mid-teardown, or an
    // invalidated context after a reload) must never surface as an error, and
    // logging that failure here would recurse straight back into capture.
    const sent = chrome.runtime.sendMessage({
      type: "FLORA_DEBUG_ENTRIES",
      entries: batch,
    }) as Promise<unknown> | undefined;
    void sent?.catch(() => {});
  } catch {
    // Extension context gone — drop the batch.
  }
}

function capture(level: DebugLevel, args: unknown[]): void {
  if (isOwnIssueTracker()) return;
  if (context === null) context = detectContext();
  const entry: DebugLogEntry = { t: Date.now(), level, ctx: context, msg: formatMessage(args) };

  recent.push(entry);
  if (recent.length > RECENT_LIMIT) recent.shift();

  if (!_enabled) return;
  pending.push(entry);

  if (pending.length >= FLUSH_AT_ENTRIES) {
    flush();
  } else if (flushTimer === null) {
    flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
  }
}

export function recentDebugEntries(): DebugLogEntry[] {
  return [...recent];
}

export function setRuntimeErrorListener(listener: RuntimeErrorListener | null): void {
  onRuntimeError = listener;
}

function notifyRuntimeError(info: RuntimeErrorInfo): void {
  try {
    onRuntimeError?.(info);
  } catch {
    onRuntimeError = null;
  }
}

/**
 * True when a stack/URL belongs to this extension. Content scripts share the
 * page's error events, so without this filter an issue report would fill up
 * with unrelated errors from whatever site the user happened to be reading.
 */
function isOwnCode(text: string): boolean {
  if (isServiceWorker()) return true;
  try {
    return text.includes(`chrome-extension://${chrome.runtime.id}`);
  } catch {
    return false;
  }
}

/**
 * Capture uncaught errors and rejected promises while debug mode is on — the
 * failures worth reporting are usually the ones no debugLog call anticipated.
 */
function installErrorCapture(): void {
  const target: EventTarget | undefined =
    typeof self !== "undefined" ? (self as unknown as EventTarget) : undefined;
  if (!target) return;

  target.addEventListener("error", (event) => {
    const e = event as ErrorEvent;
    const origin = e.filename || (e.error instanceof Error ? e.error.stack ?? "" : "");
    if (!isOwnCode(origin)) return;
    const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : "";
    capture("error", [`Uncaught ${e.message}${where}`]);
    notifyRuntimeError({
      message: e.message,
      stack: e.error instanceof Error ? e.error.stack : undefined,
      where: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined,
    });
  });

  target.addEventListener("unhandledrejection", (event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    const stack = reason instanceof Error ? reason.stack ?? "" : "";
    if (!isOwnCode(stack)) return;
    const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : stringifyArg(reason);
    capture("error", [`Unhandled rejection: ${message}`]);
    notifyRuntimeError({ message, stack: stack || undefined });
  });
}

function init(): void {
  if (_initialized) return;
  _initialized = true;

  try {
    chrome.storage.local.get(DEBUG_FLAG_KEY, (result) => {
      _enabled = result?.[DEBUG_FLAG_KEY] === true;
    });

    // React to live changes (the options/popup toggle, or the console)
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[DEBUG_FLAG_KEY]) {
        const next = changes[DEBUG_FLAG_KEY].newValue === true;
        // Ship whatever was captured before a switch-off so the tail of a
        // session isn't lost between the last flush and the toggle.
        if (_enabled && !next) flush();
        _enabled = next;
      }
    });

    installErrorCapture();
  } catch {
    // chrome.storage not available (e.g. in tests) — stay disabled
  }
}

init();

/**
 * Route captured entries straight to a local store instead of messaging the
 * service worker. Called by the worker itself, which owns the store.
 */
export function setDebugSink(next: DebugSink | null): void {
  sink = next;
  if (sink) flush();
}

/**
 * Enable or disable debug logging at runtime. Used by the options page and the
 * popup toggle; also callable from the browser console:
 *   chrome.storage.local.set({ flora_debug: true })
 */
export function setDebug(enabled: boolean): void {
  if (_enabled && !enabled) flush();
  _enabled = enabled;
  try {
    chrome.storage.local.set({ [DEBUG_FLAG_KEY]: enabled });
  } catch {
    // storage unavailable
  }
}

/** Read the persisted debug flag (the in-memory copy can lag a fresh context). */
export async function isDebugEnabledAsync(): Promise<boolean> {
  try {
    const raw = await chrome.storage.local.get(DEBUG_FLAG_KEY);
    _enabled = raw?.[DEBUG_FLAG_KEY] === true;
  } catch {
    // storage unavailable — fall through to the in-memory value
  }
  return _enabled;
}

export function isDebugEnabled(): boolean {
  return _enabled;
}

/** Ship any buffered entries now (e.g. before a popup closes). */
export function flushDebugLog(): void {
  flush();
}

export function debugLog(...args: unknown[]): void {
  if (!_enabled) return;
  capture("log", args);
  console.log("[FLoRA]", ...args);
}

export function debugWarn(...args: unknown[]): void {
  capture("warn", args);
  if (!_enabled) return;
  console.warn("[FLoRA]", ...args);
}

export function debugError(...args: unknown[]): void {
  capture("error", args);
  if (!_enabled) return;
  console.error("[FLoRA]", ...args);
}

/** Test-only: reset module state between cases. */
export function _resetDebugForTesting(): void {
  _enabled = false;
  sink = null;
  pending = [];
  recent = [];
  onRuntimeError = null;
  context = null;
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
