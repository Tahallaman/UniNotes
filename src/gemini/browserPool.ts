/**
 * Shared Gemini browser context with a bounded tab pool.
 *
 * Why tabs rather than multiple browsers: a Chromium persistent profile
 * directory can only be opened by one process at a time, and the Google session
 * lives in that profile (cookies alone in a fresh context give a logged-out
 * page). So parallelism has to be N tabs inside ONE context.
 *
 * The anti-throttle launch flags below are load-bearing. Chrome throttles
 * background tabs to roughly 1% CPU, so without them only the foreground tab
 * would make real progress and the pool would be close to pointless.
 */

import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { CONFIG } from "../../config.js";
import { log } from "../utils/logger.js";
import { createLimiter } from "../utils/limit.js";
import { hideBrowserWindows } from "../utils/windowControl.js";

/** Park the window far outside any plausible desktop area. */
const OFFSCREEN_POSITION = "-32000,-32000";

const tabLimit = createLimiter(CONFIG.concurrency.browserTabs);

/**
 * Serialises access to the system clipboard.
 *
 * This is the ONE genuinely shared resource in the browser path. There is a
 * single clipboard per browser, so if tab A clicks "Copy" and tab B clicks
 * "Copy" before A reads back, A silently receives B's response and writes it
 * into A's lecture file. That is cross-lecture data corruption, not a formatting
 * glitch, so the click and the read must be atomic — see extractResponseMarkdown.
 *
 * Deliberately NOT used for Material overlays (upload menu, model picker) or for
 * execCommand text insertion. Those were previously serialised on the assumption
 * that CDK overlays only lay out in the foreground tab; measurement disproved it.
 * Playwright enables per-page focus emulation, so every pooled tab reports
 * document.visibilityState="visible" and hasFocus()=true regardless of which tab
 * the window is actually showing, and overlays lay out fine in all of them.
 * Verified: 3 concurrent tabs opened the "Upload & tools" overlay and inserted
 * distinct prompts via execCommand with no mutex at all, 3/3 successful.
 */
const clipboardMutex = createLimiter(1);

/**
 * Run a clipboard-dependent interaction exclusively.
 *
 * `fn` MUST contain both the copy click and the read-back. Keep it short: this
 * is the only remaining serialisation point in the browser path.
 */
export async function withClipboard<T>(page: Page, fn: () => Promise<T>): Promise<T> {
  return clipboardMutex(async () => {
    // ~16ms measured, and the async clipboard API is genuinely focus-sensitive
    // in ways focus emulation doesn't always cover. Cheap insurance on the most
    // fragile interaction we have.
    await page.bringToFront().catch(() => {
      // Headless, or the tab is gone; the read may still succeed.
    });
    return fn();
  });
}

/**
 * Google's abuse interstitial, served in place of the app itself.
 *
 * Worth detecting explicitly: it renders no Gemini DOM at all, so it otherwise
 * surfaces as `waitForSelector("input-area-v2") timed out`, which reads like a
 * slow page rather than "you have been rate-limited and no retry will help".
 */
export class GeminiRateLimitedError extends Error {
  readonly retryable = false;
  constructor(url: string) {
    super(
      `Google served its "unusual traffic" check instead of Gemini (${url}). ` +
        `The browser path is being rate-limited. Wait for it to clear, lower ` +
        `concurrency.browserTabs, or switch that stage to the api provider.`,
    );
    this.name = "GeminiRateLimitedError";
  }
}

/** Throw a clear error if Google bounced us to the bot check. */
export function assertNotRateLimited(page: Page): void {
  const url = page.url();
  if (/\/sorry\/|consent\.google\.com/.test(url)) {
    throw new GeminiRateLimitedError(url);
  }
}

let contextPromise: Promise<BrowserContext> | null = null;

/**
 * Space out the START of each unit of browser work.
 *
 * Opening N fresh Gemini conversations in the same instant is a recognisable
 * automation signature: during this work Google served its "unusual traffic"
 * interstitial after a burst of concurrent runs, locking the profile out
 * entirely. Staggering costs a few seconds once per part and makes the traffic
 * pattern far less bursty. The long waits still overlap, so throughput is
 * essentially unaffected.
 */
let lastStart = 0;
let paceChain: Promise<void> = Promise.resolve();
function pace(): Promise<void> {
  const gap = CONFIG.browser.tabStaggerMs;
  if (gap <= 0) return Promise.resolve();
  paceChain = paceChain.then(async () => {
    const since = Date.now() - lastStart;
    // Jitter so the gaps aren't metronomically identical either.
    const wait = gap - since + Math.random() * gap * 0.4;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastStart = Date.now();
  });
  return paceChain;
}

function launchArgs(windowMode: string): string[] {
  const args = [
    // Keep Google from spotting the automation during sign-in.
    "--disable-blink-features=AutomationControlled",
    // Without these three, background tabs are throttled to ~1% CPU and the
    // whole tab pool degrades to roughly serial execution.
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ];

  if (windowMode === "offscreen") {
    args.push(`--window-position=${OFFSCREEN_POSITION}`, "--window-size=1280,900");
  }

  return args;
}

/**
 * Launch (once) and return the shared Gemini context.
 *
 * Always a persistent context backed by browser-data/gemini/. Google auth needs
 * the full profile state — service workers, IndexedDB, device fingerprint
 * continuity — not just cookies.
 */
export function getGeminiContext(): Promise<BrowserContext> {
  if (!contextPromise) {
    contextPromise = (async () => {
      const { headless, windowMode } = CONFIG.browser;
      const offscreen = !headless && windowMode === "offscreen";

      log.info(
        `Launching Gemini browser (headless=${headless}, windowMode=${headless ? "n/a" : windowMode}, ` +
          `maxTabs=${CONFIG.concurrency.browserTabs})`,
      );

      const context = await chromium.launchPersistentContext(CONFIG.paths.browserData.gemini, {
        channel: CONFIG.browser.channel,
        headless,
        // viewport:null lets the real window govern size, which is what makes
        // --window-position actually take effect.
        viewport: offscreen ? null : { width: 1280, height: 900 },
        args: launchArgs(headless ? "normal" : windowMode),
        ignoreDefaultArgs: ["--enable-automation"],
      });

      if (!headless && windowMode === "hidden") {
        await hideBrowserWindows(CONFIG.paths.browserData.gemini);
      }

      // Needed to read Gemini's "Copy" button output, which yields the real
      // markdown source. Scraping innerText instead loses every markdown marker
      // because the page shows rendered HTML. Non-fatal: extraction falls back.
      await context
        .grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: new URL(CONFIG.gemini.url).origin,
        })
        .catch((err) => {
          log.warn(`Could not grant clipboard permissions: ${err instanceof Error ? err.message : String(err)}`);
        });

      return context;
    })().catch((err) => {
      contextPromise = null;
      throw err;
    });
  }
  return contextPromise;
}

/**
 * Run `fn` on a dedicated tab, waiting for a free slot first.
 *
 * The tab is always closed afterwards — a fresh tab per unit of work is what
 * gives each part its own Gemini conversation, which the pipeline relies on
 * (Gemini ignores subsequent uploads within one conversation).
 */
export async function withTab<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  return tabLimit(async () => {
    const context = await getGeminiContext();
    await pace();
    const page = await context.newPage();
    try {
      return await fn(page);
    } finally {
      await page.close().catch(() => {
        // Tab may already be gone if the browser crashed; nothing useful to do.
      });
    }
  });
}

/** Close the shared context at the end of a run. Safe to call when never launched. */
export async function closeGeminiBrowser(): Promise<void> {
  if (!contextPromise) return;
  const pending = contextPromise;
  contextPromise = null;
  try {
    const context = await pending;
    await context.close();
    log.info("Gemini browser closed.");
  } catch (err) {
    log.warn(`Error closing Gemini browser: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Auth mode: opens a visible window for manual Google login.
 *
 * Deliberately bypasses the pool — sign-in must be visible and headed
 * regardless of the configured window mode, because Google blocks sign-in from
 * headless and you need to actually see the form.
 */
export async function authGemini(): Promise<void> {
  log.info("Opening Gemini for manual Google login...");
  const context = await chromium.launchPersistentContext(CONFIG.paths.browserData.gemini, {
    channel: CONFIG.browser.channel,
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(CONFIG.gemini.url, { timeout: 30_000 });

  log.info("Complete Google login in the browser, then close the window.");
  log.info("The session is saved automatically in the browser profile.");

  while (context.pages().length > 0) {
    await new Promise<void>((r) => setTimeout(r, 2_000));
  }

  await context.close().catch(() => {});
  log.info("Gemini auth browser closed. Session saved in persistent profile.");
}

/** Per-tab debug screenshot path — a fixed filename would collide across tabs. */
export function debugScreenshotPath(tag: string): string {
  const safe = tag.replace(/[^\w.-]+/g, "-").slice(0, 60);
  return path.join(CONFIG.paths.temp, `gemini-debug-${safe}-${Date.now()}.png`);
}
