import path from "node:path";
import { CONFIG } from "../../config.js";
import { log } from "../utils/logger.js";
import { launchPanoptoBrowser } from "./scraper.js";
import { viewerUrl as buildViewerUrl } from "./endpoints.js";
import type { LectureRow } from "../db/tracker.js";

/**
 * Download a lecture video using the authenticated Panopto browser context.
 * Returns the path to the downloaded temp file.
 *
 * Real Panopto download flow (as of March 2026):
 *   The direct Podcast/Social URL returns 403. Instead:
 *   1. Navigate to the viewer page (Viewer.aspx?id=GUID)
 *   2. Wait for the player to load
 *   3. Click "More actions" button in the top bar
 *   4. Click "Download podcast" menuitem
 *   5. Catch the browser download event (goes via Panopto's regional CDN with a signed URL)
 */
export async function downloadLecture(lecture: LectureRow): Promise<string> {
  const destPath = path.join(CONFIG.paths.temp, `${lecture.id}.mp4`);
  log.info(`Downloading lecture: ${lecture.title} → ${destPath}`);

  const context = await launchPanoptoBrowser();

  try {
    const page = context.pages()[0] || (await context.newPage());

    // Step 1: Navigate to the viewer page
    // Use "load" not "networkidle" — Panopto has background analytics that
    // prevent networkidle from ever firing.
    const viewerUrl = lecture.panopto_url || buildViewerUrl(lecture.id);
    await page.goto(viewerUrl, {
      timeout: CONFIG.panopto.navigationTimeout,
      waitUntil: "load",
    });

    // Step 2: Wait for the "More actions" button — this appears once the player
    // controls have loaded and is a reliable signal the UI is ready.
    // The player can take up to 60 s to initialise.
    const moreActionsBtn = page.locator('button[aria-label="More actions"]');
    await moreActionsBtn.waitFor({ state: "visible", timeout: 60_000 });

    // Dismiss the Panopto notification banner if it's overlaying the controls.
    // It intercepts pointer events and blocks clicks on the "More actions" button.
    const banner = page.locator('#notificationBanner');
    if (await banner.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await page.evaluate(() => {
        document.getElementById("notificationBanner")?.remove();
      });
      await page.waitForTimeout(300);
    }

    await moreActionsBtn.click();

    // Step 3: Set up download listener BEFORE clicking (avoid race), then click "Download podcast"
    const downloadPromise = page.waitForEvent("download", { timeout: 120_000 });
    const downloadMenuItem = page.getByRole("menuitem", { name: "Download podcast" });
    await downloadMenuItem.waitFor({ state: "visible", timeout: 5_000 });
    await downloadMenuItem.click();

    // Step 4: Wait for download to complete and save to disk
    const download = await downloadPromise;
    await download.saveAs(destPath);

    log.info(`Download complete: ${lecture.title} (${destPath})`);
    return destPath;
  } finally {
    await context.close();
  }
}
