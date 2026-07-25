/**
 * Verify the Gemini browser setup before trusting it in a long run.
 *
 * Answers what can't be settled by reading docs:
 *   1. Is Google serving the app, or its "unusual traffic" bot check?
 *   2. Is the persistent profile still signed in?
 *   3. Do N tabs run in PARALLEL, or is Chrome throttling background tabs?
 *   4. Do Angular Material CDK overlays (the "Upload & tools" menu) lay out in
 *      EVERY tab concurrently? This is what allows the browser path to run
 *      without a global foreground mutex — if it ever regresses, uploads start
 *      timing out under concurrency and this is the probe that catches it.
 *   5. Does headless work with the already-authenticated profile? Google blocks
 *      headless *sign-in*, but the session already exists — so this may pass.
 *
 * Usage:
 *   npx tsx scripts/probe-browser.ts
 *   npx tsx scripts/probe-browser.ts --headless
 *   npx tsx scripts/probe-browser.ts --window-mode hidden --tabs 3
 */

import { chromium, type BrowserContext } from "playwright";
import { CONFIG } from "../config.js";
import { hideBrowserWindows } from "../src/utils/windowControl.js";

const args = process.argv.slice(2);
function argValue(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
  return args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
}

const headless = args.includes("--headless") || CONFIG.browser.headless;
const windowMode = argValue("window-mode") || CONFIG.browser.windowMode;
const tabCount = parseInt(argValue("tabs") || String(CONFIG.concurrency.browserTabs), 10);

console.log(`headless   : ${headless}`);
console.log(`windowMode : ${headless ? "n/a (headless)" : windowMode}`);
console.log(`tabs       : ${tabCount}`);
console.log(`profile    : ${CONFIG.paths.browserData.gemini}`);
console.log();

const offscreen = !headless && windowMode === "offscreen";

const context: BrowserContext = await chromium.launchPersistentContext(
  CONFIG.paths.browserData.gemini,
  {
    channel: CONFIG.browser.channel,
    headless,
    viewport: offscreen ? null : { width: 1280, height: 900 },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      ...(offscreen ? ["--window-position=-32000,-32000", "--window-size=1280,900"] : []),
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  },
);

if (!headless && windowMode === "hidden") {
  await hideBrowserWindows(CONFIG.paths.browserData.gemini);
}

let anyFailure = false;

try {
  const started = Date.now();

  // Open every tab at once, and drive a real CDK overlay in each with NO mutex.
  // If background tabs were throttled, later tabs would take dramatically
  // longer; if overlays needed the foreground, all but one would fail.
  const results = await Promise.all(
    Array.from({ length: tabCount }, async (_, i) => {
      const t0 = Date.now();
      const page = await context.newPage();
      try {
        await page.goto(CONFIG.gemini.url, { timeout: 60_000, waitUntil: "load" });

        // Checked before any Gemini selector: the bot-check page has none of
        // them, so otherwise this shows up as a confusing selector timeout.
        const rateLimited = /\/sorry\/|consent\.google\.com/.test(page.url());
        if (rateLimited) {
          return { tab: i + 1, ms: Date.now() - t0, signedIn: false, modelVisible: false,
                   overlayOk: false, rateLimited: true, visibility: "?", url: page.url() };
        }

        await page.waitForSelector("input-area-v2", { timeout: 30_000 });

        // The composer only renders for a signed-in session; a sign-in wall
        // shows an account chooser instead.
        const composer = await page
          .locator('div.ql-editor[aria-label="Enter a prompt for Gemini"]')
          .count();
        const url = page.url();
        const signedIn = composer > 0 && !/accounts\.google\.com/.test(url);

        // What this tab believes about its own focus/visibility. Playwright's
        // focus emulation should report "visible" even in a background tab —
        // that is precisely why overlays work without a mutex.
        const visibility = await page.evaluate(
          () => `${document.visibilityState}/focus=${document.hasFocus()}`,
        );

        // Confirm the picker exposes the configured model label.
        let modelVisible = false;
        try {
          const picker = page.locator('button[aria-label^="Open mode picker"]');
          await picker.waitFor({ state: "visible", timeout: 5_000 });
          const label = (await picker.getAttribute("aria-label")) ?? "";
          if (label.toLowerCase().includes(CONFIG.gemini.model.toLowerCase())) {
            modelVisible = true;
          } else {
            await picker.click();
            modelVisible =
              (await page
                .locator('gem-menu-item[role="menuitem"]')
                .filter({ hasText: new RegExp(CONFIG.gemini.model.replace(".", "\\."), "i") })
                .count()) > 0;
            await page.keyboard.press("Escape").catch(() => {});
            await page.waitForTimeout(300);
          }
        } catch {
          modelVisible = false;
        }

        // The decisive test: open the upload overlay with no foreground mutex.
        let overlayOk = false;
        try {
          const btn = page.locator('button[aria-label="Upload & tools"]');
          await btn.waitFor({ state: "visible", timeout: 20_000 });
          await btn.click({ timeout: 10_000 });
          await page
            .locator('[role="menuitem"]')
            .filter({ hasText: /^Upload files/i })
            .first()
            .waitFor({ state: "visible", timeout: 15_000 });
          overlayOk = true;
          await page.keyboard.press("Escape").catch(() => {});
        } catch {
          overlayOk = false;
        }

        return { tab: i + 1, ms: Date.now() - t0, signedIn, modelVisible, overlayOk,
                 rateLimited: false, visibility, url };
      } finally {
        await page.close().catch(() => {});
      }
    }),
  );

  const wallClock = Date.now() - started;
  const slowest = Math.max(...results.map((r) => r.ms));

  console.log("Per-tab results:");
  for (const r of results) {
    console.log(
      `  tab ${r.tab}: ${String(r.ms).padStart(6)}ms  signedIn=${r.signedIn}  ` +
        `overlay=${r.overlayOk}  vis=${r.visibility}  model visible=${r.modelVisible}`,
    );
  }

  console.log(`\nwall clock  : ${wallClock}ms`);
  console.log(`slowest tab : ${slowest}ms`);

  if (results.some((r) => r.rateLimited)) {
    anyFailure = true;
    console.log(
      `\n[FAIL] Google served its "unusual traffic" bot check instead of Gemini.\n` +
        `       The browser path is rate-limited on this IP/account. It clears on its\n` +
        `       own; until it does, lower concurrency.browserTabs / raise\n` +
        `       browser.tabStaggerMs, or run that stage with --uploader=api.`,
    );
  } else {
    // Genuine parallelism means total time ≈ slowest tab, not the sum of all tabs.
    const sequentialish = wallClock > slowest * (tabCount * 0.6);
    console.log(
      sequentialish
        ? `\n[WARN] Tabs look SERIALISED — wall clock is close to the sum of tab times.\n` +
            `       Background-tab throttling may still be active.`
        : `\n[OK]   Tabs ran in PARALLEL (wall clock ≈ slowest tab).`,
    );

    const badOverlay = results.filter((r) => !r.overlayOk);
    if (badOverlay.length > 0) {
      anyFailure = true;
      console.log(
        `\n[FAIL] ${badOverlay.length}/${tabCount} tab(s) could not open the "Upload & tools"\n` +
          `       overlay concurrently. The browser path relies on overlays laying out in\n` +
          `       every tab; if this regressed, uploads will time out under concurrency.\n` +
          `       Workaround: set concurrency.browserTabs = 1.`,
      );
    } else {
      console.log(`\n[OK]   CDK overlays opened concurrently in all ${tabCount} tab(s) — no foreground mutex needed.`);
    }

    const signedOut = results.filter((r) => !r.signedIn);
    if (signedOut.length > 0) {
      anyFailure = true;
      console.log(
        `\n[FAIL] ${signedOut.length}/${tabCount} tab(s) are NOT signed in.` +
          (headless
            ? `\n       Headless is not usable with this profile — keep browser.headless = false.`
            : `\n       Run: npm run setup-auth:gemini`),
      );
    } else {
      console.log(
        `\n[OK]   Signed in on all ${tabCount} tab(s)` +
          (headless ? " — headless works with this profile." : "."),
      );
    }

    if (results.some((r) => !r.modelVisible)) {
      console.log(
        `\n[WARN] Model "${CONFIG.gemini.model}" was not found in the picker.\n` +
          `       selectGeminiModel soft-fails, so runs would silently use the default model.\n` +
          `       Check the exact label in the Gemini UI and update CONFIG.gemini.model.`,
      );
    }
  }

  if (!headless && windowMode !== "normal") {
    console.log(
      `\nCheck your desktop: with windowMode="${windowMode}" no browser window should be visible.`,
    );
  }
} finally {
  await context.close();
}

process.exit(anyFailure ? 1 : 0);
