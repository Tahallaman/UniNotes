import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { CONFIG } from "../../config.js";
import { log } from "../utils/logger.js";

/**
 * Wait for Gemini to finish uploading AND processing a video file.
 *
 * Observed Gemini DOM behaviour (confirmed via Playwright inspection, March 2026):
 *   - "Remove file" chip appears IMMEDIATELY on file selection — not when upload is done.
 *   - A [role="progressbar"] is present inside input-area-v2 while uploading.
 *   - The send button uses aria-disabled="true" (not the native .disabled property)
 *     while the upload is in progress. btn.disabled is always false — unusable.
 *   - When upload + server-side processing is complete: progressbar disappears AND
 *     aria-disabled flips to "false".
 *
 * Phase 1 — file chip appears (fast — local UI acknowledges the file).
 * Phase 2 — progressbar disappears: file fully transferred to Google's servers.
 * Phase 3 — aria-disabled="false" on send button: Gemini has processed the video.
 */
async function waitForVideoReady(page: Page, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;

  // Phase 1: chip appears (fast — local UI acknowledges the file)
  await page.waitForSelector(
    'input-area-v2 [aria-label*="Remove file"], input-area-v2 [aria-label*="Cancel upload"]',
    { timeout },
  );
  log.info("Upload chip visible.");

  // Phase 2: progressbar disappears = file fully transferred to Google's servers.
  // "Remove file" appears immediately so cannot be used as the upload-complete signal.
  await page.waitForFunction(
    () => !document.querySelector('input-area-v2 [role="progressbar"]'),
    undefined,
    { timeout: deadline - Date.now() },
  );
  log.info("File transfer to Google complete. Waiting for Gemini to process video...");

  // Phase 3: aria-disabled="false" = Gemini has indexed/transcribed the video.
  // Note: btn.disabled is always false for Angular Material buttons — unusable.
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('button[aria-label="Send message"]');
      return btn !== null && btn.getAttribute('aria-disabled') !== 'true';
    },
    undefined,
    { timeout: deadline - Date.now() },
  );
  log.info("Video ready — send button enabled.");
}

/**
 * Launch a browser context for Gemini.
 *
 * Always uses a persistent context backed by browser-data/gemini/.
 * Google authentication requires the full browser profile state (service workers,
 * IndexedDB, device fingerprint continuity) — cookies alone in a fresh context
 * are not sufficient and result in a logged-out page.
 *
 * Automation flags are suppressed so Google OAuth doesn't block sign-in.
 */
export async function launchGeminiBrowser(
  headless?: boolean,
): Promise<BrowserContext> {
  const isHeadless = headless ?? CONFIG.browser.headless;
  const context = await chromium.launchPersistentContext(
    CONFIG.paths.browserData.gemini,
    {
      channel: CONFIG.browser.channel,
      headless: isHeadless,
      viewport: { width: 1280, height: 900 },
      args: ["--disable-blink-features=AutomationControlled"],
      ignoreDefaultArgs: ["--enable-automation"],
    },
  );
  return context;
}

/**
 * Auth mode: opens a visible browser for manual Google login.
 * The session is persisted automatically in the browser-data/gemini/ profile
 * directory — no separate export needed.
 */
export async function authGemini(): Promise<void> {
  log.info("Opening Gemini for manual Google login...");
  const context = await launchGeminiBrowser(false);
  const page = context.pages()[0] || (await context.newPage());

  await page.goto(CONFIG.gemini.url, { timeout: 30_000 });

  log.info("Complete Google login in the browser, then close the window.");
  log.info("The session is saved automatically in the browser profile.");

  // Wait for the browser to be closed
  while (context.pages().length > 0) {
    await new Promise<void>((r) => setTimeout(r, 2_000));
  }

  await context.close().catch(() => {});
  log.info("Gemini auth browser closed. Session saved in persistent profile.");
}

/**
 * Upload a video file to a new Gemini chat and return the page (ready for prompting).
 * Also returns the chat URL for future reference.
 *
 * Real Gemini DOM flow (as of March 2026):
 *   1. Click button[aria-label="Open upload file menu"]  → opens mat-menu
 *   2. Click menuitem "Upload files"                      → opens native file chooser
 *   3. Handle filechooser event with Playwright           → file uploads
 *   4. Wait for upload chip / file name to appear in input area
 */
export async function uploadVideoToGemini(
  videoPath: string,
): Promise<{ page: Page; context: BrowserContext; chatUrl: string }> {
  const fileName = path.basename(videoPath);
  log.info(`Uploading video to Gemini: ${fileName}`);

  const context = await launchGeminiBrowser();
  const page = context.pages()[0] || (await context.newPage());

  // Navigate to Gemini and start a new chat
  // Use "load" not "networkidle" — Gemini has persistent background activity
  await page.goto(CONFIG.gemini.url, {
    timeout: 30_000,
    waitUntil: "load",
  });

  // Wait for the input area and upload button to be fully ready
  await page.waitForSelector('input-area-v2', { timeout: 15_000 });
  const uploadMenuBtn = page.locator('button[aria-label="Open upload file menu"]');
  await uploadMenuBtn.waitFor({ state: "visible", timeout: 15_000 });
  // Debug: capture page state before clicking
  await page.screenshot({ path: "temp/gemini-debug.png" });
  log.info(`Gemini page URL before upload: ${page.url()}`);
  await page.waitForTimeout(500);

  // Step 1: Open the upload file menu
  await uploadMenuBtn.click();

  // Step 2: Wait for the menu to appear (mat-action-list with role="menu",
  // items are <button role="menuitem">).
  // Menu is <mat-action-list role="menu">, items are <button role="menuitem">.
  const uploadFilesItem = page.locator('[aria-label="Upload file options"] [role="menuitem"]').first();
  await uploadFilesItem.waitFor({ state: "visible", timeout: 10_000 });

  // Set up file chooser listener AFTER confirming the menu is open, then click
  const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 15_000 });
  await uploadFilesItem.click();

  // Step 3: Handle the file chooser
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(videoPath);

  log.info("Video file selected, waiting for upload and processing to complete...");

  // Step 4: Wait for Gemini to finish uploading AND processing the video.
  // Two-phase wait:
  //   Phase 1 — chip appears (either "Cancel upload" during transfer or "Remove file" when done)
  //   Phase 2 — Send button becomes enabled, which is the definitive signal that Gemini
  //              has finished transcribing/processing the video server-side.
  await waitForVideoReady(page, CONFIG.gemini.uploadTimeout);

  // Capture the chat URL
  const chatUrl = page.url();

  log.info(`Video uploaded and processed. Chat URL: ${chatUrl}`);
  return { page, context, chatUrl };
}

/**
 * Upload an additional video to an already-open Gemini chat page.
 * Used when a lecture video is split into multiple parts — call this after
 * the first part has already been uploaded via uploadVideoToGemini().
 */
export async function uploadAdditionalVideoToChat(
  page: Page,
  videoPath: string,
): Promise<void> {
  const fileName = path.basename(videoPath);
  log.info(`Uploading additional video to existing Gemini chat: ${fileName}`);

  await page.waitForSelector("input-area-v2", { timeout: 15_000 });
  const uploadMenuBtn = page.locator('button[aria-label="Open upload file menu"]');
  await uploadMenuBtn.waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(500);
  await uploadMenuBtn.click();

  const uploadFilesItem = page
    .locator('[aria-label="Upload file options"] [role="menuitem"]')
    .first();
  await uploadFilesItem.waitFor({ state: "visible", timeout: 10_000 });

  const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 15_000 });
  await uploadFilesItem.click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(videoPath);

  log.info("Part 2 file selected, waiting for upload and processing to complete...");
  await waitForVideoReady(page, CONFIG.gemini.uploadTimeout);
  log.info(`Additional video uploaded and processed: ${fileName}`);
}
