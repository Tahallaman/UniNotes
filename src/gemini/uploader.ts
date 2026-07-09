import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { CONFIG } from "../../config.js";
import { log } from "../utils/logger.js";

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
async function waitForVideoReady(page: Page, timeout: number): Promise<void> {
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
    log.info("Upload chip visible.");
  } catch {
    log.warn("Upload chip not detected — proceeding to wait for upload completion via send button.");
  }

  // Phase 2: wait for any upload progressbar to appear and then disappear.
  // First check if one appears within 5 s; if not, skip this phase entirely.
  try {
    await page.waitForSelector('[role="progressbar"]', { timeout: 5_000 });
    log.info("Upload progress detected. Waiting for file transfer to complete...");
    await page.waitForFunction(
      () => !document.querySelector('[role="progressbar"]'),
      undefined,
      { timeout: deadline - Date.now() },
    );
    log.info("File transfer to Google complete. Waiting for Gemini to process video...");
  } catch {
    log.info("No upload progressbar detected — skipping Phase 2.");
  }

  // Phase 3: wait for the send button to be enabled.
  // May 2026 UI: aria-disabled is on the outer <gem-icon-button> wrapper, not the
  // inner <button>. We check the wrapper first, then fall back to the inner button.
  await page.waitForFunction(
    () => {
      const sendBtn = document.querySelector('button[aria-label="Send message"]');
      if (!sendBtn) return false;
      const gemWrapper = sendBtn.closest("gem-icon-button");
      if (gemWrapper) return gemWrapper.getAttribute("aria-disabled") !== "true";
      return sendBtn.getAttribute("aria-disabled") !== "true";
    },
    undefined,
    { timeout: deadline - Date.now() },
  );
  log.info("Video ready — send button enabled.");
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
 * Upload a video file to a new Gemini chat and return the page (ready for prompting).
 * Also returns the chat URL for future reference.
 *
 * Real Gemini DOM flow (as of May 2026):
 *   1. Click button[aria-label="Upload & tools"]     → opens mat-menu
 *   2. Click [role="menuitem"] "Upload files"        → opens native file chooser
 *   3. Handle filechooser event with Playwright      → file uploads
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

  // Wait for the input area to be fully ready
  await page.waitForSelector('input-area-v2', { timeout: 15_000 });

  // Register consent dialog auto-dismissal before triggering any upload
  await registerConsentDialogHandler(page);

  // Select the desired model before uploading
  await selectGeminiModel(page, CONFIG.gemini.model);

  // Step 1: Open the upload file menu
  // Gemini May 2026: button[aria-label="Upload & tools"]
  const uploadMenuBtn = page.locator('button[aria-label="Upload & tools"]');
  await uploadMenuBtn.waitFor({ state: "visible", timeout: 15_000 });
  await page.screenshot({ path: "temp/gemini-debug.png" });
  log.info(`Gemini page URL before upload: ${page.url()}`);
  await page.waitForTimeout(500);
  await uploadMenuBtn.click();

  // Step 2: Wait for the "Upload files" menu item.
  // aria-label="Upload files. Documents, data, code files" — filter by text for resilience.
  const uploadFilesItem = page
    .locator('[role="menuitem"]')
    .filter({ hasText: /^Upload files/i })
    .first();
  await uploadFilesItem.waitFor({ state: "visible", timeout: 10_000 });

  // Set up file chooser listener AFTER confirming the menu is open, then click
  const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 15_000 });
  await uploadFilesItem.click();

  // Step 3: Handle the file chooser
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(videoPath);

  log.info("Video file selected, waiting for upload and processing to complete...");

  // Step 4: Wait for Gemini to finish uploading AND processing the video.
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

  // Ensure consent dialog is handled (handler is idempotent — safe to register again)
  await registerConsentDialogHandler(page);

  // Gemini May 2026: button[aria-label="Upload & tools"]
  const uploadMenuBtn = page.locator('button[aria-label="Upload & tools"]');
  await uploadMenuBtn.waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(500);
  await uploadMenuBtn.click();

  const uploadFilesItem = page
    .locator('[role="menuitem"]')
    .filter({ hasText: /^Upload files/i })
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
