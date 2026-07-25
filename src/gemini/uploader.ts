import path from "node:path";
import type { Page } from "playwright";
import { CONFIG } from "../../config.js";
import { log, type LogContext } from "../utils/logger.js";
import { assertNotRateLimited, debugScreenshotPath } from "./browserPool.js";

// Browser launch and the tab pool live in browserPool.ts. This module only knows
// how to drive an already-open Gemini tab.
export { authGemini } from "./browserPool.js";

/**
 * Wait for Gemini to finish uploading AND processing a video file.
 *
 * Observed Gemini DOM behaviour (confirmed via Playwright inspection, May 2026):
 *   - After the May 2026 UI redesign, the file chip (if any) no longer reliably
 *     has aria-label="Remove file" inside input-area-v2 — Phase 1 is best-effort.
 *   - A [role="progressbar"] may appear while uploading, but is not guaranteed.
 *   - aria-disabled="true" is on the outer <gem-icon-button> wrapper for the send
 *     button, NOT on the inner <button> element. The inner button's aria-disabled
 *     is always null — unusable for polling.
 *   - When upload + server-side processing is complete: the gem-icon-button wrapper
 *     aria-disabled flips to "false" (or disappears).
 *
 * Phase 1 — best-effort chip/attachment detection (soft; non-blocking on timeout).
 * Phase 2 — progressbar disappears: file fully transferred to Google's servers.
 * Phase 3 — gem-icon-button wrapper aria-disabled="false": video processed.
 */
async function waitForVideoReady(page: Page, timeout: number, ctx?: LogContext): Promise<void> {
  const deadline = Date.now() + timeout;

  // Phase 1: best-effort — detect file chip or attachment anywhere on the page.
  // The exact selector varies across UI versions; soft-fail so Phase 3 can still complete.
  try {
    await page.waitForFunction(
      () =>
        !!document.querySelector('[aria-label*="Remove file"]') ||
        !!document.querySelector('[aria-label*="Cancel upload"]') ||
        !!document.querySelector('file-attachment-chip') ||
        !!document.querySelector('attachment-chip') ||
        !!document.querySelector('[class*="file-chip"]'),
      undefined,
      { timeout: 10_000 },
    );
    log.info("Upload chip visible.", ctx);
  } catch {
    log.warn("Upload chip not detected — proceeding to wait for upload completion via send button.", ctx);
  }

  // Phase 2: wait for any upload progressbar to appear and then disappear.
  // First check if one appears within 5 s; if not, skip this phase entirely.
  try {
    await page.waitForSelector('[role="progressbar"]', { timeout: 5_000 });
    log.info("Upload progress detected. Waiting for file transfer to complete...", ctx);
    await page.waitForFunction(
      () => !document.querySelector('[role="progressbar"]'),
      undefined,
      { timeout: deadline - Date.now() },
    );
    log.info("File transfer to Google complete. Waiting for Gemini to process video...", ctx);
  } catch {
    log.info("No upload progressbar detected — skipping Phase 2.", ctx);
  }

  // Phase 3: send button enabled = video fully processed.
  await waitForSendEnabled(page, deadline - Date.now());
  log.info("Video ready — send button enabled.", ctx);
}

/**
 * Wait until the send button is clickable.
 *
 * May 2026 UI: aria-disabled lives on the outer <gem-icon-button> wrapper, not
 * the inner <button> — the inner element's aria-disabled is always null and so
 * is useless for polling.
 */
export async function waitForSendEnabled(page: Page, timeout: number): Promise<void> {
  await page.waitForFunction(
    () => {
      const sendBtn = document.querySelector('button[aria-label="Send message"]');
      if (!sendBtn) return false;
      const gemWrapper = sendBtn.closest("gem-icon-button");
      if (gemWrapper) return gemWrapper.getAttribute("aria-disabled") !== "true";
      return sendBtn.getAttribute("aria-disabled") !== "true";
    },
    undefined,
    { timeout: Math.max(1_000, timeout) },
  );
}

/**
 * Select a model in the Gemini model picker.
 * Soft-fails with a warning if the picker can't be found or the model isn't listed.
 *
 * DOM (confirmed May 2026):
 *   Picker button: button[aria-label^="Open mode picker"]  (shows current model as text)
 *   Menu items:    gem-menu-item[role="menuitem"]  (text e.g. "3.5 Flash", "3.1 Pro")
 */
async function selectGeminiModel(page: Page, modelName: string): Promise<void> {
  try {
    const pickerBtn = page.locator('button[aria-label^="Open mode picker"]');
    await pickerBtn.waitFor({ state: "visible", timeout: 5_000 });

    // Skip if already selected (button text contains the model name)
    const currentLabel = await pickerBtn.getAttribute("aria-label") ?? "";
    if (currentLabel.toLowerCase().includes(modelName.toLowerCase())) {
      log.info(`Model already set to "${modelName}", skipping picker.`);
      return;
    }

    log.info(`Selecting Gemini model: ${modelName}`);
    await pickerBtn.click();

    const modelItem = page
      .locator('gem-menu-item[role="menuitem"]')
      .filter({ hasText: new RegExp(modelName.replace(".", "\\."), "i") })
      .first();
    await modelItem.waitFor({ state: "visible", timeout: 5_000 });
    await modelItem.click();
    log.info(`Model "${modelName}" selected.`);
  } catch (err) {
    log.warn(`Could not select model "${modelName}" — proceeding with current default. (${err})`);
  }
}

/**
 * Register a persistent handler that auto-dismisses Gemini's video upload consent
 * dialog by clicking "Agree" whenever it appears. The handler fires for the lifetime
 * of the page, so it covers both the initial upload and any subsequent uploads on
 * the same page.
 *
 * Dialog DOM (confirmed May 2026):
 *   Root:  [data-test-id="video-upload-consent-dialog-root"]
 *   Agree: [data-test-id="video-upload-consent-dialog-agree-button"] button
 */
async function registerConsentDialogHandler(page: Page): Promise<void> {
  const dialogLocator = page.locator('[data-test-id="video-upload-consent-dialog-root"]');
  await page.addLocatorHandler(dialogLocator, async () => {
    log.info("Video upload consent dialog detected — clicking Agree...");
    try {
      await page
        .locator('[data-test-id="video-upload-consent-dialog-agree-button"] button')
        .click({ timeout: 5_000 });
      log.info("Consent dialog dismissed.");
    } catch {
      // Fallback: find any Agree button in the dialog
      try {
        await page.locator('button[aria-label="Agree"]').click({ timeout: 5_000 });
        log.info("Consent dialog dismissed (fallback).");
      } catch (err) {
        log.warn(`Could not dismiss consent dialog: ${err}`);
      }
    }
  });
}

/**
 * Open a fresh Gemini chat on `page` and attach `filePath` to it.
 *
 * Operates on a caller-supplied page (from browserPool.withTab) rather than
 * launching its own browser, which is what allows several of these to run
 * concurrently in separate tabs of one context.
 *
 * Handles any file type, not just video: the pretty-notes path attaches a .md.
 * `waitForProcessing` should be false for small text files — the send button
 * enables almost immediately and the video-oriented progress phases just add
 * pointless waiting.
 *
 * Real Gemini DOM flow (as of May 2026):
 *   1. Click button[aria-label="Upload & tools"]     → opens mat-menu
 *   2. Click [role="menuitem"] "Upload files"        → opens native file chooser
 *   3. Handle filechooser event with Playwright      → file uploads
 *   4. Wait for upload chip / file name to appear in input area
 */
export async function uploadFileToGemini(
  page: Page,
  filePath: string,
  opts: { waitForProcessing?: boolean; ctx?: LogContext } = {},
): Promise<{ chatUrl: string }> {
  const { waitForProcessing = true, ctx } = opts;
  const fileName = path.basename(filePath);
  log.info(`Attaching to Gemini: ${fileName}`, ctx);

  // "load" not "networkidle" — Gemini has persistent background activity, so
  // networkidle never fires.
  await page.goto(CONFIG.gemini.url, { timeout: 60_000, waitUntil: "load" });

  // Checked before waiting on any Gemini selector: the bot-check page contains
  // none of them, so without this a rate-limit reads as a 30s selector timeout.
  assertNotRateLimited(page);
  await page.waitForSelector("input-area-v2", { timeout: 30_000 });

  // Register consent dialog auto-dismissal before triggering any upload
  await registerConsentDialogHandler(page);

  // Steps 1-3 drive Angular Material overlays (the model picker and the upload
  // menu). These used to run under a global foreground mutex on the theory that
  // CDK overlays only lay out in the visible tab; measurement showed every
  // pooled tab reports itself focused and visible (Playwright focus emulation),
  // and 3 concurrent tabs drove this menu successfully with no mutex. Running
  // unserialised is what makes the tab pool actually parallel.

  // Select the desired model before uploading
  await selectGeminiModel(page, CONFIG.gemini.model);

  // Step 1: Open the upload file menu
  const uploadMenuBtn = page.locator('button[aria-label="Upload & tools"]');
  await uploadMenuBtn.waitFor({ state: "visible", timeout: 30_000 });
  if (CONFIG.browser.debugScreenshots) {
    await page.screenshot({ path: debugScreenshotPath(`pre-upload-${fileName}`) }).catch(() => {});
  }
  await page.waitForTimeout(500);
  await uploadMenuBtn.click();

  // Step 2: Wait for the "Upload files" menu item.
  // aria-label="Upload files. Documents, data, code files" — filter by text for resilience.
  const uploadFilesItem = page
    .locator('[role="menuitem"]')
    .filter({ hasText: /^Upload files/i })
    .first();
  await uploadFilesItem.waitFor({ state: "visible", timeout: 30_000 });

  // Set up file chooser listener AFTER confirming the menu is open, then click
  const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 30_000 });
  await uploadFilesItem.click();

  // Step 3: Handle the file chooser
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(filePath);

  log.info("File selected, waiting for upload to complete...", ctx);

  // Step 4: Wait for Gemini to finish uploading AND processing.
  if (waitForProcessing) {
    await waitForVideoReady(page, CONFIG.gemini.uploadTimeout, ctx);
  } else {
    await waitForSendEnabled(page, 120_000);
  }

  const chatUrl = page.url();
  log.info(`Attachment ready. Chat URL: ${chatUrl}`, ctx);
  return { chatUrl };
}
