import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { CONFIG } from "../../config.js";
import { log } from "../utils/logger.js";
import { lectureExists, type NewLecture } from "../db/tracker.js";
import {
  downloadUrl as buildDownloadUrl,
  isPanoptoAppUrl,
  isPanoptoConfigured,
  PanoptoNotConfiguredError,
  subscriptionsUrl,
} from "./endpoints.js";

const STORAGE_STATE_PATH = path.join(
  CONFIG.paths.browserData.panopto,
  "storage-state.json",
);

export interface ScrapedLecture {
  id: string;
  title: string;
  folderName: string;
  courseCode: string;
  panoptoUrl: string;
  downloadUrl: string;
}

/**
 * Launch a browser context for Panopto.
 *
 * Pipeline runs: loads saved storage state (cookies + localStorage) from
 * storage-state.json so session cookies survive browser restarts.
 * Auth runs: uses a persistent context so the user can log in interactively.
 */
export async function launchPanoptoBrowser(
  headless?: boolean,
): Promise<BrowserContext> {
  // Checked here rather than at each entry point: every Panopto code path opens
  // a browser through this function, so this is the one place that can't be
  // missed — and it fails before spending a browser launch on a URL we can't build.
  if (!isPanoptoConfigured()) throw new PanoptoNotConfiguredError();

  const isHeadless = headless ?? CONFIG.browser.headless;

  // For pipeline runs, load saved storage state into a fresh context.
  // Auth calls explicitly pass headless=false; pipeline calls pass nothing (undefined).
  // We use `headless !== false` so this branch fires for pipeline but NOT for auth.
  if (headless !== false && fs.existsSync(STORAGE_STATE_PATH)) {
    const browser = await chromium.launch({
      channel: CONFIG.browser.channel,
      headless: true,
    });
    const context = await browser.newContext({
      storageState: STORAGE_STATE_PATH,
      viewport: { width: 1280, height: 900 },
    });
    return context;
  }

  // For auth / visible runs, use persistent context
  const context = await chromium.launchPersistentContext(
    CONFIG.paths.browserData.panopto,
    {
      channel: CONFIG.browser.channel,
      headless: isHeadless,
      viewport: { width: 1280, height: 900 },
    },
  );
  return context;
}

/**
 * Auth mode: opens a visible browser for manual SSO login,
 * then exports the full storage state (including session cookies) to JSON
 * so it can be reloaded on subsequent headless runs.
 */
export async function authPanopto(): Promise<void> {
  log.info("Opening Panopto for manual SSO login...");
  const context = await launchPanoptoBrowser(false);
  const page = context.pages()[0] || (await context.newPage());

  await page.goto(subscriptionsUrl(), { timeout: CONFIG.panopto.navigationTimeout });

  log.info("Complete SSO login in the browser. Auth saves automatically once logged in — then close the window.");

  // Poll every 2 s while the browser is open.
  // Save storage state as soon as we detect a successful login (URL is on a Panopto
  // app page, not on the SSO/Auth redirect chain). This avoids calling storageState()
  // after the browser process has already exited.
  let stateSaved = false;
  while (context.pages().length > 0) {
    if (!stateSaved) {
      try {
        const activePage = context.pages()[0];
        const url = activePage?.url() ?? "";
        const isLoggedIn = await activePage.evaluate(() =>
          !!document.querySelector('button[aria-label="User settings"]'),
        ).catch(() => false);
        if (isPanoptoAppUrl(url) && !url.includes("Auth") && isLoggedIn) {
          const state = await context.storageState();
          fs.mkdirSync(path.dirname(STORAGE_STATE_PATH), { recursive: true });
          fs.writeFileSync(STORAGE_STATE_PATH, JSON.stringify(state, null, 2));
          log.info(`Panopto auth session saved to ${STORAGE_STATE_PATH}`);
          log.info("Auth saved! You can now close the browser.");
          stateSaved = true;
        }
      } catch { /* ignore transient mid-navigation errors */ }
    }
    await new Promise<void>((r) => setTimeout(r, 2_000));
  }

  if (!stateSaved) {
    log.warn("Browser closed before auth was captured — please re-run setup-auth:panopto");
  }

  await context.close().catch(() => {});
}

/**
 * Scrape the Panopto subscriptions page for new lectures.
 * Returns only lectures not already in the database.
 */
export async function scrapePanopto(): Promise<ScrapedLecture[]> {
  log.info("Scraping Panopto subscriptions page...");
  const context = await launchPanoptoBrowser();

  try {
    const page = context.pages()[0] || (await context.newPage());
    // Use "load" not "networkidle" — Panopto has constant background analytics
    // traffic that prevents networkidle from ever firing
    await page.goto(subscriptionsUrl(), {
      timeout: CONFIG.panopto.navigationTimeout,
      waitUntil: "load",
    });

    // The page uses hash-based routing (#isSubscriptionsPage=true) — the JS
    // renders the list asynchronously after page load. Wait specifically for
    // a list row to appear, or for the "X search result" status text which
    // indicates the list finished loading (even if empty).
    await page.waitForFunction(
      () => {
        // Rows are present
        if (document.querySelector("tr.list-view-row") !== null) return true;
        // Status text like "1 search result available below" or "0 search results available below"
        const statusEl = document.querySelector(".listResultsHeader, [class*='results-count'], [class*='result-count']");
        if (statusEl) return true;
        // Fallback: look for the specific result count text in the page
        const bodyText = document.body.innerText || "";
        return bodyText.includes("search result available below");
      },
      { timeout: 50_000 },
    ).catch(() => {
      log.warn("Timed out waiting for subscription list — page may be empty or auth expired");
    });

    log.info(`Scraper page URL: ${page.url()}`);

    // Debug: capture what the page looks like at this point
    await page.screenshot({ path: "temp/scraper-debug.png", fullPage: false });
    const debugInfo = await page.evaluate(() => ({
      rowCount: document.querySelectorAll("tr.list-view-row").length,
      bodySnippet: (document.body.innerText || "").slice(0, 300),
      hasSignIn: !!document.querySelector('button[data-test-id*="sign"], a[href*="login"], a[href*="signin"]'),
    }));
    log.info(`Debug DOM: ${JSON.stringify(debugInfo)}`);

    // Helper to extract all currently-visible rows from the DOM.
    // Called before AND after each scroll so we capture rows even if the
    // virtual list removes them from the DOM when scrolled out of view.
    const extractRows = () =>
      page.evaluate(() => {
        const rows = document.querySelectorAll("tr.list-view-row");
        const results: Array<{
          id: string;
          title: string;
          folderName: string;
          url: string;
        }> = [];

        for (const row of rows) {
          const id = row.id;
          if (!id || !/^[a-f0-9-]{36}$/i.test(id)) continue;

          const titleLink = row.querySelector(
            "td.detail-cell a.detail-title",
          ) as HTMLAnchorElement | null;
          if (!titleLink) continue;

          const title = titleLink.textContent?.trim() || "Untitled";
          const url = titleLink.href;

          const folderLink = row.querySelector(
            "td.detail-cell a.folder-link",
          ) as HTMLElement | null;
          const folderName = folderLink?.textContent?.trim() || "";

          results.push({ id, title, folderName, url });
        }
        return results;
      });

    // Collect items across all scroll positions, deduplicating by ID
    const seenIds = new Set<string>();
    const allItems: Array<{ id: string; title: string; folderName: string; url: string }> = [];

    const addItems = (batch: typeof allItems) => {
      for (const item of batch) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          allItems.push(item);
        }
      }
    };

    // Extract before scrolling (captures initial viewport rows)
    addItems(await extractRows());
    log.info(`Rows before scroll: ${allItems.length}`);

    // Scroll to load more, extracting after each scroll
    for (let i = 0; i < CONFIG.panopto.maxScrolls; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(CONFIG.panopto.scrollDelay);
      addItems(await extractRows());
    }

    const items = allItems;

    log.info(`Found ${items.length} lecture(s) on page`);

    // Filter and enrich
    const newLectures: ScrapedLecture[] = [];
    for (const item of items) {
      if (lectureExists(item.id)) continue;

      const courseCode = extractCourseCode(item.folderName, item.title);
      const downloadUrl = buildDownloadUrl(item.id);

      newLectures.push({
        id: item.id,
        title: item.title,
        folderName: item.folderName,
        courseCode,
        panoptoUrl: item.url,
        downloadUrl,
      });
    }

    log.info(`${newLectures.length} new lecture(s) to process`);
    return newLectures;
  } finally {
    // Closing the context is not enough. On the storage-state path,
    // launchPanoptoBrowser() calls chromium.launch() and then newContext(), so a
    // whole Browser process sits behind the context and survives its close —
    // keeping the Node process alive with it. src/main.ts hid this by calling
    // process.exit() explicitly; any script that just runs to completion would
    // hang forever instead. `context.browser()` is null for a persistent
    // context, which owns no separate browser to close.
    const browser = context.browser();
    await context.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

/**
 * Extract a course code from folder name or title using configured patterns.
 * Falls back to "UNSORTED" if no match.
 */
export function extractCourseCode(folderName: string, title: string): string {
  for (const pattern of CONFIG.courseCodePatterns) {
    const folderMatch = folderName.match(pattern);
    if (folderMatch) return folderMatch[1].replace(/\s+/g, " ").toUpperCase();

    const titleMatch = title.match(pattern);
    if (titleMatch) return titleMatch[1].replace(/\s+/g, " ").toUpperCase();
  }
  return "UNSORTED";
}

/** Convert scraped data to the shape expected by the tracker. */
export function toNewLecture(scraped: ScrapedLecture): NewLecture {
  return {
    id: scraped.id,
    title: scraped.title,
    courseCode: scraped.courseCode,
    panoptoUrl: scraped.panoptoUrl,
    downloadUrl: scraped.downloadUrl,
  };
}
