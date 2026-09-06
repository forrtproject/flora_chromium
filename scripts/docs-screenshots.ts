// Regenerates the screenshots used by the documentation site in docs/img/.
//
//   npm run build && npm run docs:screenshots
//   npm run docs:screenshots -- --settings-only
//
// Two sources, both rendered in Chrome for Testing (see tests/visual/README.md
// for the first-run extraction gotcha on macOS):
//
//   * dist/walkthrough.html — the in-extension tour. Its demos are built by
//     the extension's own components (see src/walkthrough/demos.ts), so these
//     images track the real UI rather than a mock of it. We capture the demo
//     column alone, without the tour's prose and navigation chrome.
//   * dist/options.html and dist/popup.html — the real settings and popup UI,
//     rendered with a minimal `chrome.*` stub so they run outside an
//     extension host.

import {
  Browser as BrowserName,
  computeExecutablePath,
  detectBrowserPlatform,
  install,
} from "@puppeteer/browsers";
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(REPO_ROOT, "docs", "img");

/** Walkthrough step index -> screenshot file name; null for prose-only steps. */
const WALKTHROUGH_STEPS: (string | null)[] = [
  null, // welcome
  "scholar-confirmed-doi",
  "scholar-unconfirmed-doi",
  "pills-and-side-tab",
  "pill-icons",
  "retractions-and-concerns",
  "meta-report-panel",
  "spreadsheet-detection",
  null, // closing
];

// Enough of the extension APIs for options.js / popup.js to initialise.
const CHROME_STUB = `
window.chrome = {
  storage: {
    sync: { get: (k, cb) => (cb ? cb({}) : Promise.resolve({})), set: (v, cb) => (cb ? cb() : Promise.resolve()) },
    local: { get: (k, cb) => (cb ? cb({}) : Promise.resolve({})), set: (v, cb) => (cb ? cb() : Promise.resolve()), getBytesInUse: () => Promise.resolve(0) },
    session: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
    onChanged: { addListener: () => {} },
  },
  runtime: { sendMessage: () => Promise.resolve({}), getURL: (p) => p, openOptionsPage: () => {}, lastError: null },
  tabs: { query: () => Promise.resolve([{ id: 1, url: "https://journals.sagepub.com/doi/10.1177/0956797612441216" }]) },
};
`;

async function ensureChrome(): Promise<string> {
  const platform = detectBrowserPlatform();
  if (!platform) throw new Error("Unsupported platform for Chrome for Testing");
  const cacheDir = path.join(os.homedir(), ".cache", "puppeteer");
  const buildId = "152.0.7977.75"; // Match tests/visual/run.ts.
  const execPath = computeExecutablePath({ browser: BrowserName.CHROME, buildId, cacheDir });
  if (!existsSync(execPath)) {
    console.log(`Installing Chrome for Testing (${buildId}) into ${cacheDir} …`);
    await install({ browser: BrowserName.CHROME, buildId, cacheDir });
  }
  return execPath;
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  if (!existsSync(path.join(REPO_ROOT, "dist", "walkthrough.html"))) {
    throw new Error("dist/ not found — run `npm run build` first");
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: await ensureChrome(),
    headless: true, // Chrome for Testing matches the headless visual harness.
    args: ["--force-color-profile=srgb", "--hide-scrollbars", "--force-device-scale-factor=2"],
  });

  try {
    // ── Walkthrough demos ──────────────────────────────────────────────────
    if (!process.argv.includes("--settings-only")) {
      const tour = await browser.newPage();
      await tour.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
      await tour.goto(`file://${REPO_ROOT}/dist/walkthrough.html`, { waitUntil: "networkidle0" });
      await settle(1500);

      for (const [i, name] of WALKTHROUGH_STEPS.entries()) {
        if (!name) continue;
        await tour.evaluate((step) => {
          document.querySelector<HTMLElement>(`.wt-dot[data-step="${step}"]`)?.click();
        }, i);
        await settle(3000); // let the step's entrance animation and lookups finish
        // Most steps frame their demo in a browser mock; the legend steps don't.
        const step = `#step-${i}`;
        const target =
          (await tour.$(`${step} .mock-browser`)) ??
          (await tour.$(`${step} .demo-board`)) ??
          (await tour.$(`${step} .step-demo`));
        if (!target) {
          console.warn(`no demo element for step ${i} (${name}) — skipped`);
          continue;
        }
        await target.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
        console.log(`captured ${name}`);
    }
    await tour.close();
    }

    // ── Settings page ──────────────────────────────────────────────────────
    const options = await browser.newPage();
    await options.setViewport({ width: 1100, height: 760, deviceScaleFactor: 2 });
    await options.evaluateOnNewDocument(CHROME_STUB);
    await options.goto(`file://${REPO_ROOT}/dist/options.html`, { waitUntil: "networkidle0" });
    await options.waitForSelector("#email-input");
    // DOM readiness can precede the cards' fade-in. Capture their final state,
    // and loaded fonts, rather than a translucent intermediate animation frame.
    await options.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(document.getAnimations().filter(animation =>
        animation.effect?.getComputedTiming().iterations !== Infinity,
      ).map(animation => animation.finished));
    });
    await options.screenshot({ path: path.join(OUT_DIR, "settings.png") });
    console.log("captured settings");
    await options.close();

    // ── Toolbar popup ──────────────────────────────────────────────────────
    if (!process.argv.includes("--settings-only")) {
      const popup = await browser.newPage();
      await popup.setViewport({ width: 420, height: 420, deviceScaleFactor: 2 });
      await popup.evaluateOnNewDocument(CHROME_STUB);
      await popup.goto(`file://${REPO_ROOT}/dist/popup.html`, { waitUntil: "networkidle0" });
      await settle(1200);
      const body = await popup.$("body");
      await body!.screenshot({ path: path.join(OUT_DIR, "popup.png") });
      console.log("captured popup");
      await popup.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
