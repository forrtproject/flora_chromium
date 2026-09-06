import { getSettings, saveSettings } from "../shared/settings";
import { getBlockedDomains, saveBlockedDomains } from "../shared/domains";
import { CITATION_FORMATS, citationFormat, fetchCitation } from "../shared/citation";
import {
  getHiddenCommenters,
  isHiddenCommenter,
  saveHiddenCommenters,
} from "../shared/pubpeer-filter";
import { debugError, isDebugEnabledAsync, setDebug } from "../shared/debug";
import { clearDebugLog } from "../shared/debug-log";
import {
  buildDebugReport,
  debugReportFilename,
  issueUrl,
  stashIssueReport,
  type DebugReportData,
} from "../shared/debug-report";

// ── Email form ──────────────────────────────────────────────────────

const form = document.getElementById("settings-form") as HTMLFormElement;
const emailInput = document.getElementById("email-input") as HTMLInputElement;
const saveBtn = document.getElementById("save-btn") as HTMLButtonElement;
const statusMsg = document.getElementById("status-msg") as HTMLParagraphElement;

getSettings().then(({ email }) => {
  emailInput.value = email;
  if (email) saveBtn.textContent = "Save";
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = emailInput.value.trim();

  saveBtn.disabled = true;
  try {
    await saveSettings({ email });
    statusMsg.textContent =
      email
        ? "Email saved. Reload open tabs to use it for lookups."
        : "Email removed. Reload open tabs. Title matching and open-access lookups need an email; other checks still work.";
    statusMsg.className = "status success";
    statusMsg.hidden = false;
    saveBtn.textContent = email ? "Save" : "Save contact email";
  } catch (err) {
    debugError("Settings: save failed —", err);
    statusMsg.textContent = "Failed to save — please try again.";
    statusMsg.className = "status error";
    statusMsg.hidden = false;
  } finally {
    saveBtn.disabled = false;
  }
});

// ── Citation style ──────────────────────────────────────────────────

const citationStyleSelect = document.getElementById("citation-style-select") as HTMLSelectElement;
const citationPreview = document.getElementById("citation-style-preview") as HTMLParagraphElement;

// Ioannidis (2005) — a stable, widely-known record to render the sample from.
const SAMPLE_DOI = "10.1371/journal.pmed.0020124";

for (const format of CITATION_FORMATS) {
  const option = document.createElement("option");
  option.value = format.id;
  option.textContent = format.label;
  citationStyleSelect.appendChild(option);
}

let sampleToken = 0;

async function showCitationSample(formatId: string): Promise<void> {
  const token = ++sampleToken;
  citationPreview.className = "citation-sample";
  citationPreview.textContent = "Rendering a sample…";
  citationPreview.hidden = false;
  const sample = await fetchCitation(SAMPLE_DOI, formatId);
  if (token !== sampleToken) return;
  if (!sample) {
    citationPreview.textContent = "Sample unavailable — Crossref could not be reached.";
    citationPreview.className = "citation-sample error";
    return;
  }
  // tidyCitationHtml allows only bare <i>/<em>/<b>/<strong>/<sub>/<sup>.
  if (sample.html) citationPreview.innerHTML = sample.html;
  else citationPreview.textContent = sample.text;
}

getSettings().then(({ citationStyle }) => {
  citationStyleSelect.value = citationFormat(citationStyle).id;
  void showCitationSample(citationStyleSelect.value);
});

citationStyleSelect.addEventListener("change", async () => {
  const citationStyle = citationFormat(citationStyleSelect.value).id;
  await saveSettings({ citationStyle });
  void showCitationSample(citationStyle);
});

// ── Cache storage quota ─────────────────────────────────────────────

const cacheQuotaInput = document.getElementById("cache-quota-input") as HTMLInputElement;
const cacheQuotaSaveBtn = document.getElementById("cache-quota-save-btn") as HTMLButtonElement;
const cacheQuotaStatus = document.getElementById("cache-quota-status") as HTMLParagraphElement;

getSettings().then(({ cacheQuotaMb }) => {
  cacheQuotaInput.value = String(cacheQuotaMb);
});

cacheQuotaSaveBtn.addEventListener("click", async () => {
  const raw = parseInt(cacheQuotaInput.value, 10);
  const cacheQuotaMb = isNaN(raw) || raw < 0 ? 50 : raw;
  cacheQuotaInput.value = String(cacheQuotaMb);
  cacheQuotaSaveBtn.disabled = true;
  try {
    await saveSettings({ cacheQuotaMb });
    cacheQuotaStatus.textContent = cacheQuotaMb === 0
      ? "Storage limit removed — cache is unlimited."
      : `Storage limit set to ${cacheQuotaMb} MB.`;
    cacheQuotaStatus.className = "status domain-status success";
    cacheQuotaStatus.hidden = false;
    setTimeout(() => { cacheQuotaStatus.hidden = true; }, 3000);
  } catch (err) {
    debugError("Settings: cache quota save failed —", err);
    cacheQuotaStatus.textContent = "Failed to save — please try again.";
    cacheQuotaStatus.className = "status domain-status error";
    cacheQuotaStatus.hidden = false;
  } finally {
    cacheQuotaSaveBtn.disabled = false;
  }
});

// ── Domain blocklist ────────────────────────────────────────────────

const domainInput = document.getElementById("domain-input") as HTMLInputElement;
const addDomainBtn = document.getElementById("add-domain-btn") as HTMLButtonElement;
const domainList = document.getElementById("domain-list") as HTMLDivElement;
const domainStatusMsg = document.getElementById("domain-status-msg") as HTMLParagraphElement;

let blocked: string[] = [];

function renderBlockedList(): void {
  domainList.innerHTML = "";

  if (blocked.length === 0) {
    const empty = document.createElement("div");
    empty.className = "domain-empty";
    empty.textContent = "No domains blocked — ORE is active on all sites.";
    domainList.appendChild(empty);
    return;
  }

  const sorted = [...blocked].sort((a, b) => a.localeCompare(b));

  for (const domain of sorted) {
    const row = document.createElement("div");
    row.className = "domain-row";

    const label = document.createElement("span");
    label.className = "domain-name";
    label.textContent = domain;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "domain-remove";
    removeBtn.setAttribute("aria-label", "Unblock");
    removeBtn.innerHTML = "&times;";
    removeBtn.addEventListener("click", () => unblockDomain(domain));

    row.appendChild(label);
    row.appendChild(removeBtn);
    domainList.appendChild(row);
  }
}

async function unblockDomain(domain: string): Promise<void> {
  blocked = blocked.filter((d) => d !== domain);
  await saveBlockedDomains(blocked);
  renderBlockedList();
  showDomainStatus(`Unblocked ${domain}`, "success");
}

async function blockDomain(): Promise<void> {
  const raw = domainInput.value.trim().toLowerCase();
  if (!raw) return;

  // Strip protocol & path
  const domain = raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "");

  if (
    !domain ||
    !/^[a-z0-9]([a-z0-9\-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]*[a-z0-9])?)+$/.test(domain)
  ) {
    showDomainStatus("Invalid domain format.", "error");
    return;
  }

  if (blocked.includes(domain)) {
    showDomainStatus(`${domain} is already blocked.`, "error");
    return;
  }

  blocked.push(domain);
  await saveBlockedDomains(blocked);
  domainInput.value = "";
  renderBlockedList();
  showDomainStatus(`Blocked ${domain}`, "success");
}

function showDomainStatus(msg: string, type: "success" | "error"): void {
  domainStatusMsg.textContent = msg;
  domainStatusMsg.className = `status domain-status ${type}`;
  domainStatusMsg.hidden = false;
  setTimeout(() => {
    domainStatusMsg.hidden = true;
  }, 3000);
}

// Listeners
addDomainBtn.addEventListener("click", blockDomain);
domainInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    blockDomain();
  }
});

// Init
getBlockedDomains().then((b) => {
  blocked = b;
  renderBlockedList();
});

// ── Muted PubPeer commenters ────────────────────────────────────────

const commenterInput = document.getElementById("commenter-input") as HTMLInputElement;
const addCommenterBtn = document.getElementById("add-commenter-btn") as HTMLButtonElement;
const commenterList = document.getElementById("commenter-list") as HTMLDivElement;
const commenterStatusMsg = document.getElementById("commenter-status-msg") as HTMLParagraphElement;

let mutedCommenters: string[] = [];

function renderCommenterList(): void {
  commenterList.innerHTML = "";

  if (mutedCommenters.length === 0) {
    const empty = document.createElement("div");
    empty.className = "domain-empty";
    empty.textContent = "No commenters muted — all PubPeer comments are shown.";
    commenterList.appendChild(empty);
    return;
  }

  const sorted = [...mutedCommenters].sort((a, b) => a.localeCompare(b));

  for (const id of sorted) {
    const row = document.createElement("div");
    row.className = "domain-row";

    const label = document.createElement("span");
    label.className = "domain-name";
    label.textContent = id;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "domain-remove";
    removeBtn.setAttribute("aria-label", `Unmute ${id}`);
    removeBtn.innerHTML = "&times;";
    removeBtn.addEventListener("click", () => unmuteCommenter(id));

    row.appendChild(label);
    row.appendChild(removeBtn);
    commenterList.appendChild(row);
  }
}

async function unmuteCommenter(id: string): Promise<void> {
  mutedCommenters = mutedCommenters.filter((c) => c !== id);
  await saveHiddenCommenters(mutedCommenters);
  renderCommenterList();
  showCommenterStatus(`Unmuted ${id}`, "success");
}

async function muteCommenter(): Promise<void> {
  const id = commenterInput.value.trim();
  if (!id) return;

  if (isHiddenCommenter(id, mutedCommenters)) {
    showCommenterStatus(`${id} is already muted.`, "error");
    return;
  }

  mutedCommenters.push(id);
  await saveHiddenCommenters(mutedCommenters);
  commenterInput.value = "";
  renderCommenterList();
  showCommenterStatus(`Muted ${id}`, "success");
}

function showCommenterStatus(msg: string, type: "success" | "error"): void {
  commenterStatusMsg.textContent = msg;
  commenterStatusMsg.className = `status domain-status ${type}`;
  commenterStatusMsg.hidden = false;
  setTimeout(() => {
    commenterStatusMsg.hidden = true;
  }, 3000);
}

addCommenterBtn.addEventListener("click", muteCommenter);
commenterInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    muteCommenter();
  }
});

getHiddenCommenters().then((ids) => {
  mutedCommenters = ids;
  renderCommenterList();
});

// ── Debug mode & issue reports ──────────────────────────────────────

const debugToggle = document.getElementById("debug-toggle") as HTMLInputElement;
const debugPreview = document.getElementById("debug-preview") as HTMLPreElement;
const debugStatus = document.getElementById("debug-status") as HTMLParagraphElement;
const debugReportBtn = document.getElementById("debug-report-btn") as HTMLButtonElement;
const debugReportLabel = document.getElementById("debug-report-label")!;
const debugCopyBtn = document.getElementById("debug-copy-btn") as HTMLButtonElement;
const debugDownloadBtn = document.getElementById("debug-download-btn") as HTMLButtonElement;
const debugRefreshBtn = document.getElementById("debug-refresh-btn") as HTMLButtonElement;
const debugClearBtn = document.getElementById("debug-clear-btn") as HTMLButtonElement;

/** Latest rendered report — what the copy/download/issue buttons act on. */
let debugReport = "";

function updateDebugUI(enabled: boolean): void {
  debugToggle.checked = enabled;
  debugPreview.hidden = !enabled;
  for (const control of [debugCopyBtn, debugDownloadBtn, debugRefreshBtn, debugClearBtn]) {
    control.hidden = !enabled;
  }
  debugReportLabel.textContent = enabled ? "Report an issue with this log" : "Report an issue";
}

function showDebugStatus(msg: string, type: "success" | "error"): void {
  debugStatus.textContent = msg;
  debugStatus.className = `status domain-status ${type}`;
  debugStatus.hidden = false;
  setTimeout(() => {
    debugStatus.hidden = true;
  }, 4000);
}

async function refreshDebugReport(): Promise<DebugReportData> {
  const { text, entryCount, data } = await buildDebugReport();
  debugReport = text;
  debugPreview.textContent = text;
  debugPreview.classList.toggle("empty", entryCount === 0);
  return data;
}

async function copyDebugReport(): Promise<boolean> {
  await refreshDebugReport();
  try {
    await navigator.clipboard.writeText(debugReport);
    return true;
  } catch (err) {
    debugError("Settings: copying the debug report failed —", err);
    return false;
  }
}

isDebugEnabledAsync().then((enabled) => {
  updateDebugUI(enabled);
  if (enabled) void refreshDebugReport();
});

debugToggle.addEventListener("change", () => {
  setDebug(debugToggle.checked);
  updateDebugUI(debugToggle.checked);
  if (debugToggle.checked) void refreshDebugReport();
  showDebugStatus(
    debugToggle.checked
      ? "Debug mode on — reload the page that misbehaves, reproduce the problem, then come back and refresh the report."
      : "Debug mode off. The log already captured is kept until you clear it.",
    "success"
  );
});

debugRefreshBtn.addEventListener("click", () => {
  void refreshDebugReport().then(() => showDebugStatus("Report refreshed.", "success"));
});

debugCopyBtn.addEventListener("click", async () => {
  if (await copyDebugReport()) {
    showDebugStatus("Report copied to the clipboard.", "success");
  } else {
    showDebugStatus(
      "Couldn't reach the clipboard — select the report below and copy it manually.",
      "error"
    );
  }
});

debugDownloadBtn.addEventListener("click", async () => {
  await refreshDebugReport();
  const blob = new Blob([debugReport], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = debugReportFilename();
  link.click();
  URL.revokeObjectURL(url);
  showDebugStatus("Report downloaded — attach the file to your issue.", "success");
});

debugReportBtn.addEventListener("click", async () => {
  if (!debugToggle.checked) {
    chrome.tabs.create({ url: issueUrl({}).url });
    showDebugStatus("Opening a GitHub issue.", "success");
    return;
  }

  const data = await refreshDebugReport();
  const link = issueUrl({ report: data });
  const stashed = await stashIssueReport(debugReport);
  // Clipboard as well: if GitHub ever reshapes its issue form, a paste still
  // beats sending the user back here to fetch the report by hand.
  await navigator.clipboard.writeText(debugReport).catch(() => {});

  chrome.tabs.create({ url: link.url });

  const attached = link.embedded || stashed;
  showDebugStatus(
    attached
      ? "Opening a GitHub issue with the report filled in."
      : "Couldn't attach the report — it's on your clipboard, paste it into the issue.",
    attached ? "success" : "error"
  );
});

debugClearBtn.addEventListener("click", async () => {
  await clearDebugLog();
  await refreshDebugReport();
  showDebugStatus("Debug log cleared.", "success");
});
