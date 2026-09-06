/**
 * Builds the diagnostic report a user attaches to a GitHub issue.
 *
 * The report is meant to be read by a stranger on a public issue tracker, so
 * it carries the extension/browser build, the settings that change behaviour,
 * and the captured log — but never the user's contact email, which is a
 * setting we hold only to put in the Crossref/OpenAlex polite pool.
 *
 * Getting it into the issue has two routes. Preferred is GitHub's own `?body=`
 * prefill, which is a documented, stable interface — but a URL can only carry
 * so much, so that path trims the log to its most recent entries. The full log
 * is handed to the issue-form content script, which swaps it in once the page
 * loads. Either way something useful lands in the issue: the DOM-dependent step
 * only ever upgrades a trimmed log to a complete one.
 */

import { redactDebugText } from "./debug-redact";
import { recentDebugEntries, type DebugLogEntry, type RuntimeErrorInfo } from "./debug";
import { readDebugLog } from "./debug-log";
import { safeSendMessage } from "./messages";
import { getSettings } from "./settings";
import { getBlockedDomains } from "./domains";
import { getHiddenCommenters } from "./pubpeer-filter";

/**
 * GitHub caps an issue body at 65,536 characters. Keep the log well under that
 * so the surrounding template and the user's own description always fit.
 */
const MAX_REPORT_CHARS = 50_000;

/**
 * Ceiling for a prefilled issue link. GitHub answers 414 somewhere above 8 KB;
 * this leaves room to spare, since percent-encoding a log inflates it roughly
 * threefold and the exact threshold isn't contractual.
 */
const MAX_ISSUE_URL_CHARS = 6_000;

/** Below this many entries a trimmed log isn't worth the space it costs. */
const MIN_USEFUL_ENTRIES = 5;

const ISSUE_URL = "https://github.com/forrtproject/chromium-extension/issues/new";

export interface DebugReportContext {
  /** Page the user was on when they hit the problem, if known. */
  pageUrl?: string | null;
  error?: RuntimeErrorInfo | null;
}

/** The report's parts, kept separate so the log can be re-rendered shorter. */
export interface DebugReportData {
  environment: string[];
  settings: string[];
  entries: DebugLogEntry[];
  error?: RuntimeErrorInfo | null;
}

const MAX_STACK_CHARS = 2_000;

function errorSection(error: RuntimeErrorInfo): string[] {
  const lines = ["### Error", "", `**${error.message}**`, ""];
  if (error.where) lines.push(`Raised in: \`${error.where}\``, "");
  if (error.stack) {
    lines.push("```", error.stack.slice(0, MAX_STACK_CHARS), "```", "");
  }
  return lines;
}

function formatTimestamp(t: number): string {
  const d = new Date(t);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** One log line, e.g. `12:04:31.882  [example.com] ERROR  Lookup failed`. */
export function formatDebugEntry(entry: DebugLogEntry): string {
  const level = entry.level === "log" ? "INFO" : entry.level.toUpperCase();
  return `${formatTimestamp(entry.t)}  [${entry.ctx}] ${level.padEnd(5)}  ${entry.msg}`;
}

export function extensionVersion(): string {
  try {
    return chrome.runtime.getManifest().version || "unknown";
  } catch {
    return "unknown";
  }
}

function extensionIdentity(): string {
  try {
    const manifest = chrome.runtime.getManifest();
    return `${manifest.name} ${manifest.version}`;
  } catch {
    return "unknown";
  }
}

function userAgent(): string {
  try {
    return navigator.userAgent;
  } catch {
    return "unknown";
  }
}

/**
 * Render the report body. `maxEntries` keeps only the newest entries — the
 * failure is almost always at the end of a session — and says so in the
 * heading, so a trimmed log is never mistaken for a complete one.
 */
export function renderDebugReport(
  data: DebugReportData,
  maxEntries?: number
): string {
  const total = data.entries.length;
  const shown =
    maxEntries == null || maxEntries >= total
      ? data.entries
      : data.entries.slice(total - Math.max(0, maxEntries));
  const omitted = total - shown.length;

  const heading =
    omitted > 0
      ? `### Debug log (most recent ${shown.length} of ${total} entries)`
      : `### Debug log (${total} ${total === 1 ? "entry" : "entries"})`;

  const lines: string[] = [
    ...(data.error ? errorSection(data.error) : []),
    "### Environment",
    "",
    ...data.environment.map((line) => `- ${line}`),
    "",
    "### Settings",
    "",
    ...data.settings.map((line) => `- ${line}`),
    "",
    heading,
    "",
  ];

  if (shown.length === 0) {
    lines.push(
      "_No entries captured. Turn debug mode on, reproduce the problem, then copy the report again._"
    );
    return redactDebugText(lines.join("\n"));
  }

  let body = redactDebugText(shown.map(formatDebugEntry).join("\n"));
  if (omitted > 0) body = `… ${omitted} earlier entries trimmed …\n${body}`;
  if (body.length > MAX_REPORT_CHARS) {
    body = `… earlier entries trimmed …\n${body.slice(body.length - MAX_REPORT_CHARS)}`;
  }

  lines.push("```", body, "```");
  return redactDebugText(lines.join("\n"));
}

/** Gather the report's parts without rendering them. */
export async function collectDebugReport(
  context: DebugReportContext = {}
): Promise<DebugReportData> {
  const [stored, settings, blockedDomains, mutedCommenters] = await Promise.all([
    readDebugLog(),
    getSettings(),
    getBlockedDomains(),
    getHiddenCommenters(),
  ]);

  const inMemory = recentDebugEntries();
  const entries = stored.length > 0 ? stored : inMemory;

  const environment = [
    `Extension: ${extensionIdentity()}`,
    `User agent: ${userAgent()}`,
    `Report generated: ${new Date().toISOString()}`,
    `Log source: ${stored.length > 0 ? "debug mode (full)" : "in-memory tail (debug mode off)"}`,
  ];
  if (context.pageUrl) environment.push(`Page: ${context.pageUrl}`);

  const settingsLines = [
    // The address itself is never included — only whether one is configured,
    // which is what distinguishes "setup incomplete" from a real bug.
    `Contact email configured: ${settings.email.trim() ? "yes" : "no"}`,
    `Citation style: ${settings.citationStyle}`,
    `Cache limit: ${settings.cacheQuotaMb === 0 ? "unlimited" : `${settings.cacheQuotaMb} MB`}`,
    `Blocked domains: ${blockedDomains.length}`,
    `Muted PubPeer commenters: ${mutedCommenters.length}`,
  ];

  return { environment, settings: settingsLines, entries, error: context.error ?? null };
}

/** Collect and render the full report the user can copy, save or attach. */
export async function buildDebugReport(
  context: DebugReportContext = {}
): Promise<{ text: string; entryCount: number; data: DebugReportData }> {
  const data = await collectDebugReport(context);
  return {
    text: renderDebugReport(data),
    entryCount: data.entries.length,
    data,
  };
}

/**
 * Park a report with the service worker for the issue form to claim. Returns
 * false when the worker didn't acknowledge, so the caller can fall back to
 * opening an issue that asks the user to paste it instead.
 */
export async function stashIssueReport(report: string): Promise<boolean> {
  const ack = await safeSendMessage<{ ok?: boolean }>({
    type: "FLORA_STASH_REPORT",
    report,
  });
  return ack?.ok === true;
}

/** Filename for the downloadable copy of a report. */
export function debugReportFilename(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `forrt-ore-debug-${stamp}.md`;
}

// ── Issue body ──────────────────────────────────────────────────────────────

/**
 * Fences around the report inside an issue body. The issue-form content script
 * looks for these to replace a URL-trimmed log with the complete one; they are
 * HTML comments, so they stay invisible in the posted issue either way.
 */
export const REPORT_START = "<!-- ORE-DEBUG-REPORT:START -->";
export const REPORT_END = "<!-- ORE-DEBUG-REPORT:END -->";

/** Stands in for the report when it was too long to travel in the URL. */
export const REPORT_PLACEHOLDER = `${REPORT_START}\n_Attaching the debug log…_\n${REPORT_END}`;

const REPORT_BLOCK_PATTERN =
  /<!--\s*ORE-DEBUG-REPORT:START\s*-->[\s\S]*?<!--\s*ORE-DEBUG-REPORT:END\s*-->/;

function fenced(report: string): string {
  return `${REPORT_START}\n${report}\n${REPORT_END}`;
}

/**
 * Put the full report into an issue body, replacing a trimmed one if the URL
 * already carried it. Returns null when there is nothing to do, so a re-render
 * of the form can't append a second copy.
 */
export function insertReportIntoIssueBody(
  body: string,
  report: string
): string | null {
  const block = fenced(report);
  if (body.includes(block)) return null;
  // Function replacement: a `$&` inside a captured log line must stay literal.
  if (REPORT_BLOCK_PATTERN.test(body)) return body.replace(REPORT_BLOCK_PATTERN, () => block);
  // The fence is gone (the user edited it away, or GitHub applied its own
  // template) — append rather than lose the report.
  return `${body.trimEnd()}\n\n${block}\n`;
}

const MAX_TITLE_CHARS = 80;

function issueTitle(domain: string | null | undefined, error?: RuntimeErrorInfo | null): string {
  if (error) {
    const summary = error.message.replace(/\s+/g, " ").trim();
    const named = /^[A-Za-z]*(?:Error|Exception):/.test(summary) ? summary : `Error: ${summary}`;
    return named.length > MAX_TITLE_CHARS ? `${named.slice(0, MAX_TITLE_CHARS)}…` : named;
  }
  return domain ? `Issue on domain: ${domain}` : "Issue report";
}

function issueBody(
  domain: string | null | undefined,
  reportSection: string,
  error?: RuntimeErrorInfo | null
): string {
  return [
    ...(error
      ? [
        "**ORE hit an error.**",
        "",
        `\`${error.message}\`${error.where ? ` — in \`${error.where}\`` : ""}`,
        "",
      ]
      : []),
    "**What happened?**",
    "",
    "",
    "**What did you expect?**",
    "",
    "",
    ...(domain ? [`**Domain:** ${domain}`, ""] : []),
    `**Extension version:** ${extensionVersion()}`,
    "",
    "**Debug report**",
    "",
    reportSection,
    "",
  ].join("\n");
}

function linkFor(
  domain: string | null | undefined,
  reportSection: string,
  error?: RuntimeErrorInfo | null
): string {
  const params = new URLSearchParams({
    title: redactDebugText(issueTitle(domain, error)),
    body: redactDebugText(issueBody(domain, reportSection, error)),
    labels: error ? "bug" : domain ? "domain-issue" : "bug",
  });
  return `${ISSUE_URL}?${params.toString()}`;
}

export interface IssueLink {
  url: string;
  /** True when the log travelled in the URL and needs no help from the page. */
  embedded: boolean;
  /** Entries the URL had room for; 0 when none were embedded. */
  embeddedEntries: number;
}

/**
 * Build the prefilled new-issue link. Fits as much of the log into the URL as
 * GitHub will accept — newest entries first — so the issue is useful even if
 * the content script never gets to swap in the full log.
 */
export function issueUrl(options: {
  domain?: string | null;
  report?: DebugReportData | null;
  error?: RuntimeErrorInfo | null;
}): IssueLink {
  const { domain, report } = options;
  const error = options.error ?? report?.error ?? null;

  if (!report || report.entries.length === 0) {
    const hint = report
      ? REPORT_PLACEHOLDER
      : "<!-- Optional: turn on debug mode from the ORE toolbar menu, reproduce the problem, then report it again — the log comes with it. -->";
    return { url: linkFor(domain, hint, error), embedded: false, embeddedEntries: 0 };
  }

  const data = error && !report.error ? { ...report, error } : report;

  const total = data.entries.length;
  const fits = (count: number): boolean =>
    linkFor(domain, fenced(renderDebugReport(data, count)), error).length <= MAX_ISSUE_URL_CHARS;

  // Binary search the entry count rather than slicing the rendered string:
  // trimming whole entries keeps the markdown (and its code fence) intact.
  let lo = 0;
  let hi = total;
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (best < Math.min(MIN_USEFUL_ENTRIES, total)) {
    // Not even a useful tail fits — leave it to the content script entirely.
    return { url: linkFor(domain, REPORT_PLACEHOLDER, error), embedded: false, embeddedEntries: 0 };
  }

  return {
    url: linkFor(domain, fenced(renderDebugReport(data, best)), error),
    embedded: true,
    embeddedEntries: best,
  };
}

export function isOwnRepoUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /(^|\.)github\.com$/.test(parsed.hostname)
      && parsed.pathname.startsWith("/forrtproject/chromium-extension");
  } catch {
    return false;
  }
}

/** True when a URL is the new-issue form on the extension's own repository. */
export function isIssueFormUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "") === ISSUE_URL &&
      // The template chooser lives one level up and has no body field.
      !parsed.pathname.endsWith("/choose")
    );
  } catch {
    return false;
  }
}
