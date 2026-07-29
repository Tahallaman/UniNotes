import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { CONFIG } from "../../config.js";
import { log } from "../utils/logger.js";
import { lectureExists, backfillRecordedAt, type NewLecture } from "../db/tracker.js";
import { parseListingDate } from "../notes/organise.js";
import {
  downloadUrl as buildDownloadUrl,
  isPanoptoAppUrl,
  isPanoptoConfigured,
  PanoptoNotConfiguredError,
  subscriptionsUrl,
  tableViewUrl,
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
  /** YYYY-MM-DD from the listing's Date column, or null if it wasn't readable. */
  recordedAt: string | null;
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
    // Table view, because it is the only view with a Date column — and the date
    // Panopto records is far better than one guessed from a title, which many
    // lectures don't carry at all. The view is selected by URL fragment; see
    // tableViewUrl() for why it is appended rather than substituted.
    //
    // Use "load" not "networkidle" — Panopto has constant background analytics
    // traffic that prevents networkidle from ever firing
    await page.goto(tableViewUrl(), {
      timeout: CONFIG.panopto.navigationTimeout,
      waitUntil: "load",
    });

    // The page uses hash-based routing — the JS renders the list asynchronously
    // after page load. Waiting for "a row" is not enough: Panopto ships an
    // unrendered template row whose cells still read "{binding StartTime, ...}",
    // and it is present long before any data is. Wait for a row carrying a real
    // GUID, which only a rendered one has.
    const ready = await page
      .waitForFunction(
        () => {
          const rows = document.querySelectorAll("tr.table-view-row, tr.list-view-row");
          for (const row of rows) {
            if (/^[a-f0-9-]{36}$/i.test(row.id)) return true;
          }
          const bodyText = document.body.innerText || "";
          return bodyText.includes("search result available below");
        },
        { timeout: 50_000 },
      )
      .then(() => true)
      .catch(() => false);

    // A fragment change on an already-loaded page doesn't re-render, so if the
    // view didn't take, give it one reload before giving up on the dates.
    if (!ready || (await page.locator("tr.table-view-row").count()) === 0) {
      log.warn("Table view didn't render on first load — reloading once.");
      await page.reload({ timeout: CONFIG.panopto.navigationTimeout, waitUntil: "load" });
      await page
        .waitForFunction(
          () => {
            const rows = document.querySelectorAll("tr.table-view-row, tr.list-view-row");
            for (const row of rows) {
              if (/^[a-f0-9-]{36}$/i.test(row.id)) return true;
            }
            return false;
          },
          { timeout: 50_000 },
        )
        .catch(() => {
          log.warn("Timed out waiting for subscription list — page may be empty or auth expired");
        });
    }

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
        // Both views, because the table one is what we ask for but the list one
        // is what we get if the fragment ever stops working — and a scan that
        // returns nothing is a worse failure than one without dates.
        const rows = document.querySelectorAll("tr.table-view-row, tr.list-view-row");
        const results: Array<{
          id: string;
          title: string;
          folderName: string;
          url: string;
          date: string;
        }> = [];

        for (const row of rows) {
          const id = row.id;
          // Also excludes Panopto's unrendered template row, whose id is still
          // the literal "{{$dataItem.DeliveryID}}".
          if (!id || !/^[a-f0-9-]{36}$/i.test(id)) continue;

          // a.list-title in table view, a.detail-title in list view.
          const titleLink = row.querySelector(
            "a.list-title, td.detail-cell a.detail-title",
          ) as HTMLAnchorElement | null;
          if (!titleLink) continue;

          const title = titleLink.textContent?.trim() || "Untitled";
          const url = titleLink.href;

          const folderLink = row.querySelector(
            "a.folder-link, span.folder-span",
          ) as HTMLElement | null;
          const folderName = folderLink?.textContent?.trim() || "";

          // td.list-date holds the recording date and, in a nested .time div,
          // the time of day. Only the date is wanted, and taking the cell's
          // whole textContent would run the two together.
          let date = "";
          const dateCell = row.querySelector("td.list-date:not(.shared-with-me-date)");
          if (dateCell) {
            for (const part of dateCell.querySelectorAll("div")) {
              if (part.classList.contains("time")) continue;
              const text = (part.textContent || "").trim();
              // Skip an unrendered binding expression.
              if (text.length > 0 && !text.includes("{")) {
                date = text;
                break;
              }
            }
          }

          results.push({ id, title, folderName, url, date });
        }
        return results;
      });

    // Collect items across all scroll positions, deduplicating by ID
    const seenIds = new Set<string>();
    const allItems: Array<{
      id: string;
      title: string;
      folderName: string;
      url: string;
      date: string;
    }> = [];

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
    let backfilled = 0;
    for (const item of items) {
      const recordedAt = parseListingDate(item.date);

      if (lectureExists(item.id)) {
        // Already tracked, but possibly from a scan that predates reading the
        // Date column. The listing is right in front of us, so take the date.
        if (recordedAt && backfillRecordedAt(item.id, recordedAt)) backfilled++;
        continue;
      }

      const courseCode = extractCourseCode(item.folderName, item.title);
      const downloadUrl = buildDownloadUrl(item.id);

      newLectures.push({
        id: item.id,
        title: item.title,
        folderName: item.folderName,
        courseCode,
        panoptoUrl: item.url,
        downloadUrl,
        recordedAt,
      });
    }

    if (backfilled > 0) {
      log.info(`Filled in a recording date for ${backfilled} lecture(s) already tracked`);
    }
    const withDates = newLectures.filter((l) => l.recordedAt !== null).length;
    log.info(`${newLectures.length} new lecture(s) to process, ${withDates} with a recording date`);
    if (newLectures.length > 0 && withDates === 0) {
      log.warn(
        "No recording dates were readable — weeks will be worked out from lecture titles instead. " +
          "Run the Panopto table view probe to see what the listing page returned.",
      );
    }
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
    recordedAt: scraped.recordedAt,
  };
}
