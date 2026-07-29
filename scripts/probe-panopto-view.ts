/**
 * Check that Panopto's subscriptions list can be read in table view, where the
 * Date column lives.
 *
 * Lecture titles carry a date only sometimes, and never in a consistent shape.
 * The listing page's own Date column is the reliable source — but it only exists
 * in table view, and switching views is a hash change on a page that renders
 * itself in JavaScript. That's two assumptions worth testing before the scraper
 * depends on them, which is what this does.
 *
 * Writes nothing and changes nothing. Run it, read the report, then trust (or
 * don't) what the scraper is about to do.
 *
 * Usage: npx tsx scripts/probe-panopto-view.ts
 */

import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";
import { log } from "../src/utils/logger.js";
import { launchPanoptoBrowser } from "../src/panopto/scraper.js";
import { subscriptionsUrl, tableViewUrl } from "../src/panopto/endpoints.js";

const OUT_DIR = CONFIG.paths.temp;

interface ViewReport {
  url: string;
  rows: number;
  headers: string[];
  cells: Array<{ className: string; text: string }>;
  sampleRow: string;
  dateCells: string[];
}

async function inspect(
  page: import("playwright").Page,
  url: string,
  reloadAfter = false,
): Promise<ViewReport> {
  await page.goto(url, { timeout: CONFIG.panopto.navigationTimeout, waitUntil: "load" });

  // Navigating to a URL that differs only in its fragment doesn't reload — the
  // browser just moves the hash. A page that reads the view once at startup
  // would never notice, so force the reload the fragment didn't cause.
  if (reloadAfter) {
    await page.reload({ timeout: CONFIG.panopto.navigationTimeout, waitUntil: "load" });
  }

  // The list renders after load, so waiting for the network is useless. Waiting
  // for "a row" isn't enough either: Panopto ships an unrendered template row
  // whose cells read "{binding StartTime, ...}", and inspecting that tells you
  // nothing about real data. Wait for a row with a real GUID id.
  await page
    .waitForFunction(
      () => {
        for (const row of document.querySelectorAll("tr")) {
          if (/^[a-f0-9-]{36}$/i.test(row.id)) return true;
        }
        return false;
      },
      { timeout: 30_000 },
    )
    .catch(() => undefined);

  return page.evaluate(() => {
    const rows = [...document.querySelectorAll("tr")].filter(
      (r) => r.querySelectorAll("td").length > 0,
    );
    // Only headers that are actually rendered: Panopto ships a full set of <th>
    // for every column it *could* show, including in views that show none of
    // them, so an unfiltered list says "Date" whether or not one is on screen.
    const headers = [...document.querySelectorAll("th")]
      .filter((h) => (h as HTMLElement).offsetParent !== null)
      .map((h) => (h.textContent || "").trim())
      .filter((t) => t.length > 0);

    const cells = rows[0]
      ? [...rows[0].querySelectorAll("td")].map((cell) => ({
          className: cell.className || "(none)",
          text: (cell.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
        }))
      : [];

    // A date cell holds a date and nothing else. Requiring the whole cell to
    // parse is what stops the title cell — which often contains "[28 July]" —
    // from being mistaken for one, which is exactly what happened first time.
    //
    // Written inline rather than as a named helper: this function is serialised
    // into the page, and tsx compiles a named function expression into one that
    // calls a __name helper the browser doesn't have.
    return {
      url: location.href,
      rows: rows.length,
      headers,
      cells,
      sampleRow: rows[0] ? rows[0].outerHTML : "(no rows)",
      dateCells: cells
        .filter((c) => c.text.length > 0 && c.text.length < 40 && !Number.isNaN(Date.parse(c.text)))
        .map((c) => `${c.className} → "${c.text}"`),
    };
  });
}

function report(name: string, r: ViewReport): void {
  log.info(`--- ${name} ---`);
  log.info(`URL after load: ${r.url}`);
  log.info(`Rows with cells: ${r.rows}`);
  log.info(`Visible column headers: ${r.headers.length > 0 ? r.headers.join(" | ") : "(none found)"}`);
  log.info(`Cells in the first row (${r.cells.length}):`);
  for (const cell of r.cells) log.info(`    ${cell.className} → "${cell.text}"`);
  log.info(`Cells that parse as a date: ${r.dateCells.length > 0 ? r.dateCells.join(", ") : "(none)"}`);
}

const context = await launchPanoptoBrowser();

try {
  const page = context.pages()[0] || (await context.newPage());

  const listView = await inspect(page, subscriptionsUrl());
  report("Default view", listView);

  const dated = await inspect(page, tableViewUrl(), true);
  report("Table view via URL fragment, then reloaded", dated);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dump = path.join(OUT_DIR, "panopto-table-view.html");
  fs.writeFileSync(dump, dated.sampleRow, "utf-8");
  const shot = path.join(OUT_DIR, "panopto-table-view.png");
  await page.screenshot({ path: shot, fullPage: false });

  log.info("");
  if (dated.rows === 0) {
    log.error(
      "No rows at all. Either the session has expired — run Sign in to Panopto — or the " +
        "subscriptions list is empty.",
    );
  } else if (dated.dateCells.length === 0) {
    log.error(
      "Rows loaded but no cell looked like a date. Open the screenshot below and check " +
        "whether the page is actually in table view; the scraper will fall back to reading " +
        "dates out of titles.",
    );
  } else {
    log.info(`Table view works: ${dated.rows} rows, date column found.`);
    log.info(`Subscriptions filter still applied: ${dated.url.includes("isSubscriptionsPage") ? "yes" : "NO — check this"}`);
  }
  log.info(`One row's HTML: ${dump}`);
  log.info(`Screenshot: ${shot}`);
} finally {
  await context.close().catch(() => {});
}
