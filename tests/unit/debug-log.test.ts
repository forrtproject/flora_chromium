import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import {
  _resetDebugForTesting,
  debugError,
  debugLog,
  recentDebugEntries,
  flushDebugLog,
  isDebugEnabled,
  setDebug,
  setDebugSink,
  type DebugLogEntry,
} from "@shared/debug";
import {
  MAX_LOG_ENTRIES,
  _resetDebugLogForTesting,
  appendDebugEntries,
  clearDebugLog,
  installDebugLogStore,
  readDebugLog,
  DEBUG_LOG_KEY,
} from "@shared/debug-log";
import {
  REPORT_PLACEHOLDER,
  REPORT_START,
  buildDebugReport,
  formatDebugEntry,
  insertReportIntoIssueBody,
  isIssueFormUrl,
  issueUrl,
  renderDebugReport,
} from "@shared/debug-report";
import { _resetSettingsCacheForTesting } from "@shared/settings";

/** Backing store so local-storage reads see what the writes put there. */
let localStore: Record<string, unknown> = {};

function entry(msg: string, t = 0): DebugLogEntry {
  return { t, level: "log", ctx: "test", msg };
}

beforeEach(() => {
  localStore = {};
  chrome.runtime.getManifest = vi.fn(() => ({
    name: "FORRT ORE",
    version: "9.8.7",
  }) as chrome.runtime.Manifest);
  chrome.storage.local.get = vi.fn((keys: string | string[]) => {
    const names = typeof keys === "string" ? [keys] : keys;
    const out: Record<string, unknown> = {};
    for (const name of names) {
      if (name in localStore) out[name] = localStore[name];
    }
    return Promise.resolve(out);
  }) as unknown as typeof chrome.storage.local.get;
  chrome.storage.local.set = vi.fn((items: Record<string, unknown>) => {
    Object.assign(localStore, items);
    return Promise.resolve();
  }) as unknown as typeof chrome.storage.local.set;

  _resetDebugForTesting();
  _resetDebugLogForTesting();
  _resetSettingsCacheForTesting();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("debug capture", () => {
  it("captures nothing while debug mode is off", () => {
    const sink = vi.fn();
    setDebugSink(sink);

    debugLog("looked up 3 DOIs");
    flushDebugLog();

    expect(isDebugEnabled()).toBe(false);
    expect(sink).not.toHaveBeenCalled();
  });

  it("ships captured entries to the sink once debug mode is on", () => {
    const sink = vi.fn();
    setDebugSink(sink);
    setDebug(true);

    debugLog("looked up", 3, "DOIs");
    debugError(new Error("lookup failed"));
    flushDebugLog();

    expect(sink).toHaveBeenCalledTimes(1);
    const entries = sink.mock.calls[0][0] as DebugLogEntry[];
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ level: "log", msg: "looked up 3 DOIs" });
    expect(entries[1].level).toBe("error");
    expect(entries[1].msg).toMatch(/^Error: lookup failed/);
    expect(entries[1].msg).toMatch(/\n\s*at /);
  });

  it("flushes on its own once the batch grows past the threshold", () => {
    const sink = vi.fn();
    setDebugSink(sink);
    setDebug(true);

    for (let i = 0; i < 25; i++) debugLog(`entry ${i}`);

    expect(sink).toHaveBeenCalledTimes(1);
    expect((sink.mock.calls[0][0] as DebugLogEntry[]).length).toBe(25);
  });

  it("flushes a partial batch after the debounce elapses", () => {
    vi.useFakeTimers();
    const sink = vi.fn();
    setDebugSink(sink);
    setDebug(true);

    debugLog("only one");
    expect(sink).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("flushes the tail of a session when debug mode is switched off", () => {
    const sink = vi.fn();
    setDebugSink(sink);
    setDebug(true);

    debugLog("the last thing that happened");
    setDebug(false);

    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("truncates a very long message instead of storing it whole", () => {
    const sink = vi.fn();
    setDebugSink(sink);
    setDebug(true);

    debugLog("x".repeat(5000));
    flushDebugLog();

    const [captured] = sink.mock.calls[0][0] as DebugLogEntry[];
    expect(captured.msg.length).toBeLessThan(2100);
    expect(captured.msg).toMatch(/truncated/);
  });
});

describe("debug log store", () => {
  it("persists appended entries and reads them back oldest first", async () => {
    vi.useFakeTimers();
    await appendDebugEntries([entry("first", 1), entry("second", 2)]);
    await vi.advanceTimersByTimeAsync(600);

    expect(localStore[DEBUG_LOG_KEY]).toHaveLength(2);
    const log = await readDebugLog();
    expect(log.map((e) => e.msg)).toEqual(["first", "second"]);
  });

  it("picks up an existing log after the worker restarts", async () => {
    vi.useFakeTimers();
    localStore[DEBUG_LOG_KEY] = [entry("from a previous session", 1)];

    await appendDebugEntries([entry("after restart", 2)]);
    await vi.advanceTimersByTimeAsync(600);

    const log = await readDebugLog();
    expect(log.map((e) => e.msg)).toEqual(["from a previous session", "after restart"]);
  });

  it("keeps only the newest entries once the cap is reached", async () => {
    const entries = Array.from({ length: MAX_LOG_ENTRIES + 50 }, (_, i) => entry(`e${i}`, i));
    await appendDebugEntries(entries);

    const log = await readDebugLog();
    expect(log).toHaveLength(MAX_LOG_ENTRIES);
    expect(log[0].msg).toBe("e50");
    expect(log[log.length - 1].msg).toBe(`e${MAX_LOG_ENTRIES + 49}`);
  });

  it("ignores an empty batch", async () => {
    await appendDebugEntries([]);
    expect(await readDebugLog()).toEqual([]);
  });

  it("clears both the in-memory log and storage", async () => {
    await appendDebugEntries([entry("something", 1)]);
    await clearDebugLog();

    expect(await readDebugLog()).toEqual([]);
    expect(localStore[DEBUG_LOG_KEY]).toEqual([]);
  });

  it("does not resurrect cleared entries from a pending write", async () => {
    vi.useFakeTimers();
    await appendDebugEntries([entry("stale", 1)]);
    await clearDebugLog();
    await vi.advanceTimersByTimeAsync(600);

    expect(localStore[DEBUG_LOG_KEY]).toEqual([]);
  });

  it("drops its pending write when another context clears the log", async () => {
    vi.useFakeTimers();
    installDebugLogStore();
    const listener = (chrome.storage.onChanged.addListener as ReturnType<typeof vi.fn>).mock
      .calls.at(-1)![0] as (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => void;

    await appendDebugEntries([entry("stale", 1)]);
    // The options page clears the key; the worker only sees the change event.
    localStore[DEBUG_LOG_KEY] = [];
    listener({ [DEBUG_LOG_KEY]: { oldValue: [entry("stale", 1)], newValue: [] } }, "local");
    await vi.advanceTimersByTimeAsync(600);

    expect(localStore[DEBUG_LOG_KEY]).toEqual([]);
    expect(await readDebugLog()).toEqual([]);
  });
});

describe("debug report", () => {
  it("formats an entry with its time, context and level", () => {
    const line = formatDebugEntry({
      t: new Date(2026, 0, 2, 12, 4, 31, 882).getTime(),
      level: "error",
      ctx: "example.com",
      msg: "Lookup failed",
    });
    expect(line).toContain("12:04:31.882");
    expect(line).toContain("[example.com]");
    expect(line).toContain("ERROR");
    expect(line).toContain("Lookup failed");
  });

  it("labels an empty log rather than pretending it captured something", () => {
    const report = renderDebugReport({
      environment: ["Extension: ORE 1.0"],
      settings: ["Citation style: apa"],
      entries: [],
    });
    expect(report).toContain("No entries captured");
    expect(report).toContain("Extension: ORE 1.0");
  });

  it("says so when it renders only the tail of a log", () => {
    const data = {
      environment: [],
      settings: [],
      entries: Array.from({ length: 20 }, (_, i) => entry(`e${i}`, i)),
    };
    const report = renderDebugReport(data, 5);

    expect(report).toContain("most recent 5 of 20 entries");
    expect(report).toContain("15 earlier entries trimmed");
    expect(report).toContain("e19");
    expect(report).not.toContain("e14 ");
  });

  it("never includes the user's contact email", async () => {
    chrome.storage.sync.get = vi.fn().mockResolvedValue({
      flora_settings: { email: "someone@university.edu", citationStyle: "apa" },
    }) as unknown as typeof chrome.storage.sync.get;
    _resetSettingsCacheForTesting();

    // Simulate an older persisted failure log, before capture-time redaction.
    localStore[DEBUG_LOG_KEY] = [entry(
      "Citation: https://api.crossref.org/works/10.1234%2Fabc/transform?mailto=someone%40university.edu failed; contact someone@university.edu", 1,
    )];
    const { text, entryCount } = await buildDebugReport();

    expect(entryCount).toBe(1);
    expect(text).not.toContain("someone@university.edu");
    expect(text).toContain("Contact email configured: yes");
    expect(text).not.toContain("someone%40university.edu");
    expect(text).toContain("10.1234%2Fabc/transform?mailto=[redacted]");
  });

  it("redacts contact addresses before capturing failure diagnostics", () => {
    debugError("request failed", new Error("https://api.crossref.org/works/10.1234/abc?mailto=someone%40university.edu&rows=5; someone@university.edu"));
    const captured = recentDebugEntries();
    expect(captured[0].msg).not.toMatch(/someone(?:@|%40)university\.edu/);
    const report = renderDebugReport({environment: [], settings: [], entries: captured});
    expect(report).not.toMatch(/someone(?:@|%40)university\.edu/);
    expect(report).toContain("mailto=[redacted]&rows=5");
    expect(report).toContain("10.1234/abc");
  });

  it("redacts addresses in issue error summaries even without a captured log", () => {
    const { url } = issueUrl({error: {message: "Failed for someone@university.edu", stack: "https://api.crossref.org/?mailto=someone%40university.edu"}});
    const parsed = new URL(url);
    expect(parsed.searchParams.get("title")).not.toContain("someone@");
    expect(parsed.searchParams.get("body")).not.toMatch(/someone(?:@|%40)university\.edu/);
    expect(parsed.searchParams.get("body")).toContain("[redacted");
  });

  it("builds an issue URL that names the domain", () => {
    const { url } = issueUrl({ domain: "example.com" });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://github.com/forrtproject/chromium-extension/issues/new"
    );
    expect(parsed.searchParams.get("title")).toBe("Issue on domain: example.com");
    expect(parsed.searchParams.get("labels")).toBe("domain-issue");
    expect(parsed.searchParams.get("body")).toContain("**Domain:** example.com");
  });

  it("tells the user how to produce a log when there isn't one", () => {
    const body = bodyOf(issueUrl({ domain: "example.com" }));
    expect(body).toContain("debug mode");
    expect(body).not.toContain(REPORT_START);
  });

  it("always includes the installed extension version in the issue body", () => {
    const links = [
      issueUrl({ domain: "example.com" }),
      issueUrl({ report: { environment: [], settings: [], entries: [] } }),
      issueUrl({
        report: {
          environment: [],
          settings: [],
          entries: [entry("one logged event")],
        },
      }),
    ];

    for (const link of links) {
      expect(bodyOf(link)).toContain("**Extension version:** 9.8.7");
    }
  });
});

describe("prefilled issue link", () => {
  const data = (count: number) => ({
    environment: ["Extension: ORE 1.0"],
    settings: ["Citation style: apa"],
    entries: Array.from({ length: count }, (_, i) => entry(`looked up 10.1234/abc-${i}`, i)),
  });

  it("carries a short log in the URL, needing nothing from the page", () => {
    const link = issueUrl({ domain: "example.com", report: data(10) });

    expect(link.embedded).toBe(true);
    expect(link.embeddedEntries).toBe(10);
    expect(bodyOf(link)).toContain("looked up 10.1234/abc-9");
  });

  it("keeps a long log's most recent entries and stays under the URL limit", () => {
    const link = issueUrl({ domain: "example.com", report: data(800) });

    expect(link.embedded).toBe(true);
    expect(link.embeddedEntries).toBeGreaterThanOrEqual(5);
    expect(link.embeddedEntries).toBeLessThan(800);
    expect(link.url.length).toBeLessThanOrEqual(6000);
    // The tail is what matters — that's where the failure is.
    expect(bodyOf(link)).toContain("looked up 10.1234/abc-799");
    expect(bodyOf(link)).toContain("most recent");
  });

  it("falls back to the placeholder when not even a useful tail fits", () => {
    const huge = {
      environment: [],
      settings: [],
      entries: [entry("x".repeat(10_000), 1)],
    };
    const link = issueUrl({ domain: "example.com", report: huge });

    expect(link.embedded).toBe(false);
    expect(bodyOf(link)).toContain(REPORT_START);
  });

  it("leaves a slot when the log is empty", () => {
    const link = issueUrl({ report: { environment: [], settings: [], entries: [] } });
    expect(link.embedded).toBe(false);
    expect(bodyOf(link)).toContain(REPORT_START);
  });
});

describe("issue form autofill", () => {
  it("upgrades a URL-trimmed log to the full one, keeping the rest of the body", () => {
    const trimmed = issueUrl({
      domain: "example.com",
      report: {
        environment: [],
        settings: [],
        entries: Array.from({ length: 400 }, (_, i) => entry(`e${i}`, i)),
      },
    });
    const filled = insertReportIntoIssueBody(bodyOf(trimmed), "### Debug log\nthe whole thing");

    expect(filled).not.toBeNull();
    expect(filled).toContain("**What happened?**");
    expect(filled).toContain("the whole thing");
    expect(filled).not.toContain("most recent");
    // Exactly one fenced report block survives.
    expect(filled!.split(REPORT_START)).toHaveLength(2);
  });

  it("swaps the placeholder for the report", () => {
    const filled = insertReportIntoIssueBody(
      issueUrlBody(),
      "### Debug log\nfine"
    );
    expect(filled).toContain("### Debug log");
    expect(filled).not.toContain("_Attaching the debug log…_");
  });

  it("leaves `$&` and friends in a log line literal", () => {
    const filled = insertReportIntoIssueBody(REPORT_PLACEHOLDER, "cost $& $1 $`");
    expect(filled).toContain("cost $& $1 $`");
  });

  it("appends when the fence is gone rather than dropping the report", () => {
    const filled = insertReportIntoIssueBody("I deleted the comment", "the report");
    expect(filled).toContain("I deleted the comment");
    expect(filled).toContain("the report");
  });

  it("does nothing when the report is already in the body", () => {
    const body = insertReportIntoIssueBody(REPORT_PLACEHOLDER, "the report")!;
    expect(insertReportIntoIssueBody(body, "the report")).toBeNull();
  });

  it("recognises only ORE's own new-issue form", () => {
    expect(
      isIssueFormUrl("https://github.com/forrtproject/chromium-extension/issues/new?title=x")
    ).toBe(true);
    expect(
      isIssueFormUrl("https://github.com/forrtproject/chromium-extension/issues/new/choose")
    ).toBe(false);
    expect(
      isIssueFormUrl("https://github.com/forrtproject/chromium-extension/issues/42")
    ).toBe(false);
    expect(isIssueFormUrl("https://github.com/someone/else/issues/new")).toBe(false);
    expect(isIssueFormUrl("not a url")).toBe(false);
  });
});

function bodyOf(link: { url: string }): string {
  return new URL(link.url).searchParams.get("body")!;
}

/** An issue body holding the placeholder, i.e. the log didn't fit the URL. */
function issueUrlBody(): string {
  return bodyOf(
    issueUrl({
      domain: "example.com",
      report: { environment: [], settings: [], entries: [entry("x".repeat(10_000), 1)] },
    })
  );
}
