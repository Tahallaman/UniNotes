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
/**
 * Raised when the composer never showed the file we just handed it.
 *
 * Fatal on purpose. Sending the prompt without the video does not fail — Gemini
 * answers the prompt from its text alone, and since the prompt names the course
 * and the part number, it answers *plausibly*. Those invented notes then pass
 * every downstream check, get written to lecture.raw.md, prettified, and synced.
 * A loud failure costs a retry; a silent one costs you a lecture you believe you
 * have. Observed 2026-07-25: all eight parts of a 2-hour lecture were fabricated
 * this way and the run reported zero errors.
 */
export class AttachmentNotConfirmedError extends Error {
  constructor(fileName: string, diagnostics: string) {
    super(
      `Gemini never showed "${fileName}" as an attachment, so the prompt would ` +
        `have been sent without it — and Gemini answers anyway, inventing content ` +
        `from the prompt. Refusing to continue. Composer state: ${diagnostics}`,
    );
    this.name = "AttachmentNotConfirmedError";
  }
}

/**
 * Is a file currently attached to the composer?
 *
 * Returns the signal that matched, or null.
 *
 * Deliberately broad, and deliberately *not* reliant on one class name. Gemini's
 * chip markup has changed twice already, and the previous single-selector check
 * silently degraded to "no chip found, carry on" rather than failing — which is
 * how fabricated notes got written. The filename fallback is the durable one:
 * whatever the chip is called this month, it displays the file's name.
 */
export async function detectAttachment(page: Page, fileName: string): Promise<string | null> {
  return page
    .evaluate((name) => {
      const area = document.querySelector("input-area-v2") ?? document.body;
      const selectors = [
        '[aria-label*="Remove file"]',
        '[aria-label*="Remove attachment"]',
        '[aria-label*="Cancel upload"]',
        "file-attachment-chip",
        "attachment-chip",
        "uploader-file-preview",
        "uploader-file-preview-container",
        '[class*="file-chip"]',
        '[class*="attachment-chip"]',
        '[data-test-id*="file-preview"]',
      ];
      for (const selector of selectors) {
        if (area.querySelector(selector)) return selector;
      }

      // The name minus its extension. The chip elides the middle of a long name
      // ("19a08448-e94d-442c-bf5…part3.mp4"), so match a short leading probe
      // rather than the whole stem. 12 characters is well inside where the
      // ellipsis lands and still distinctive — and no prompt template contains a
      // filename, so composer text can only carry one if a file is displayed.
      const stem = name.replace(/\.[^.]+$/, "");
      const probe = stem.slice(0, 12);
      if (probe.length >= 8 && (area.textContent ?? "").includes(probe)) {
        return "filename-in-composer";
      }
      return null;
    }, fileName)
    .catch(() => null);
}

/** Small dump of what the composer actually contained, for the failure message. */
async function attachmentDiagnostics(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const area = document.querySelector("input-area-v2");
      return JSON.stringify({
        hasInputArea: !!area,
        text: (area?.textContent ?? "").trim().slice(0, 160),
        progressbars: document.querySelectorAll('[role="progressbar"]').length,
        dialogs: document.querySelectorAll('[role="dialog"]').length,
      });
    })
    .catch(() => "unavailable");
}

/**
 * Wait for Gemini to finish uploading AND processing a file.
 *
 * Phase 1 — the attachment is actually present. HARD: see AttachmentNotConfirmedError.
 * Phase 2 — progressbar disappears: file fully transferred to Google's servers.
 * Phase 3 — send button enabled: video processed server-side.
 *
 * Phase 3 alone proves nothing, which is the trap this function used to fall
 * into: Gemini enables the send button as soon as the composer holds *text*,
 * attachment or not. It can't distinguish "video ready" from "no video".
 */
async function confirmAttachment(
  page: Page,
  fileName: string,
  timeout: number,
  ctx?: LogContext,
): Promise<void> {
  // Polled rather than waited on with a single selector, so any one of the
  // signals can satisfy it and a markup change can't silently disable the check.
  const deadline = Date.now() + timeout;
  let signal: string | null = null;
  while (Date.now() < deadline) {
    signal = await detectAttachment(page, fileName);
    if (signal) break;
    await page.waitForTimeout(1_000);
  }

  if (!signal) {
    if (CONFIG.browser.debugScreenshots) {
      await page.screenshot({ path: debugScreenshotPath(`no-attachment-${fileName}`) }).catch(() => {});
    }
    throw new AttachmentNotConfirmedError(fileName, await attachmentDiagnostics(page));
  }
  log.info(`Attachment confirmed (${signal}).`, ctx);
}

async function waitForVideoReady(
  page: Page,
  timeout: number,
  fileName: string,
  ctx?: LogContext,
): Promise<void> {
  const deadline = Date.now() + timeout;

  // Phase 1: the file must appear in the composer.
  await confirmAttachment(page, fileName, 60_000, ctx);

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

  // Re-check: the chip can vanish if the upload is rejected server-side (too
  // large, unsupported codec) after it first appeared. The send button comes
  // back regardless, so without this the rejection reads as success.
  const stillAttached = await detectAttachment(page, fileName);
  if (!stillAttached) {
    throw new AttachmentNotConfirmedError(fileName, await attachmentDiagnostics(page));
  }
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
async function selectGeminiModel(page: Page, modelName: string, ctx?: LogContext): Promise<void> {
  // Retried, because the observed failure was the picker being transiently
  // *hidden* while the tab was still hydrating — "15 x locator resolved to
  // hidden" — not absent. One more look a second later usually finds it.
  const ATTEMPTS = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const pickerBtn = page.locator('button[aria-label^="Open mode picker"]');
      await pickerBtn.waitFor({ state: "visible", timeout: 5_000 });

      // Skip if already selected (button label contains the model name)
      const currentLabel = (await pickerBtn.getAttribute("aria-label")) ?? "";
      if (currentLabel.toLowerCase().includes(modelName.toLowerCase())) {
        log.info(`Model already set to "${modelName}", skipping picker.`, ctx);
        return;
      }

      log.info(`Selecting Gemini model: ${modelName}`, ctx);
      await pickerBtn.click();

      const modelItem = page
        .locator('gem-menu-item[role="menuitem"]')
        .filter({ hasText: new RegExp(modelName.replace(".", "\\."), "i") })
        .first();
      await modelItem.waitFor({ state: "visible", timeout: 5_000 });
      await modelItem.click();
      log.info(`Model "${modelName}" selected.`, ctx);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < ATTEMPTS) await page.waitForTimeout(1_500);
    }
  }

  // Previously a warning, and the run continued on whatever model happened to be
  // selected. That silently splits one lecture across two models — parts written
  // by different models, with no record of which — and the resulting notes look
  // exactly as authoritative as the rest. Better to fail and let the retry that
  // wraps this call try again.
  throw new Error(
    `Could not select Gemini model "${modelName}" after ${ATTEMPTS} attempts. ` +
      `Continuing would run this part on an unknown model. ` +
      `If the picker label has changed, update selectGeminiModel(). (${lastError})`,
  );
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
  await selectGeminiModel(page, CONFIG.gemini.model, ctx);

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
    await waitForVideoReady(page, CONFIG.gemini.uploadTimeout, fileName, ctx);
  } else {
    // Still confirm the file landed. This path skips the *processing* wait, not
    // the "is it actually there" question — a prompt sent without its attachment
    // is answered from the prompt text alone whichever path got us here.
    await confirmAttachment(page, fileName, 30_000, ctx);
    await waitForSendEnabled(page, 120_000);
  }

  const chatUrl = page.url();
  log.info(`Attachment ready. Chat URL: ${chatUrl}`, ctx);
  return { chatUrl };
}
