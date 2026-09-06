/** Centralised extension settings stored in chrome.storage.sync. */

import { debugError } from "./debug";

export interface FloraSettings {
  /** Contact email for Crossref/OpenAlex polite pool (required). */
  email: string;
  /** Citation format id used by the pill's Copy citation row (see citation.ts). */
  citationStyle: string;
  /**
   * Shared soft cap on disposable provider caches in MB. 0 = unlimited. With the
   * "unlimitedStorage" permission the browser lifts the ~10 MB hard cap, so
   * this is a housekeeping bound: provider data is evicted in batches by write age. Settings and
   * diagnostic logs are excluded; blobs are evicted as a unit.
   */
  cacheQuotaMb: number;
  /**
   * With debug mode on, keep a one-line "Done in … · Copy log" toast up after
   * each pass so the log for a slow or wrong pass is one click away.
   */
  offerLogCopyAfterPass: boolean;
}

const STORAGE_KEY = "flora_settings";

const DEFAULTS: FloraSettings = {
  email: "",
  citationStyle: "apa",
  cacheQuotaMb: 50,
  offerLogCopyAfterPass: false,
};

let cachedSettings: FloraSettings | null = null;
let settingsListenerInstalled = false;

function installSettingsInvalidation(): void {
  if (settingsListenerInstalled) return;
  settingsListenerInstalled = true;
  try {
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area === "sync" && changes[STORAGE_KEY]) {
        const stored = changes[STORAGE_KEY].newValue as Partial<FloraSettings> | undefined;
        cachedSettings = { ...DEFAULTS, ...stored };
      }
    });
  } catch {
    // Storage change events are unavailable in tests and some non-extension contexts.
  }
}

/** Read current settings (returns defaults for any missing keys). */
export async function getSettings(): Promise<FloraSettings> {
  installSettingsInvalidation();
  if (cachedSettings) return cachedSettings;
  try {
    const raw = await chrome.storage.sync.get(STORAGE_KEY);
    const stored = raw[STORAGE_KEY] as Partial<FloraSettings> | undefined;
    cachedSettings = { ...DEFAULTS, ...stored };
    return cachedSettings;
  } catch (err) {
    debugError("Settings: read failed — falling back to defaults:", err);
    cachedSettings = { ...DEFAULTS };
    return cachedSettings;
  }
}

/** Persist settings (merges with existing). */
export async function saveSettings(
  partial: Partial<FloraSettings>
): Promise<void> {
  const current = await getSettings();
  cachedSettings = { ...current, ...partial };
  await chrome.storage.sync.set({ [STORAGE_KEY]: cachedSettings });
}

/** Test-only: drop the cached settings so the next read hits storage again. */
export function _resetSettingsCacheForTesting(): void {
  cachedSettings = null;
}

/** Returns true if the user has completed initial setup (email provided). */
export async function isSetupComplete(): Promise<boolean> {
  const { email } = await getSettings();
  return email.trim().length > 0;
}
