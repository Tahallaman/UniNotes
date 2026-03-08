import type { Page } from "playwright";
import { CONFIG } from "../../config.js";
import { log } from "../utils/logger.js";

/**
 * Submit a prompt to Gemini on an already-open page (with video uploaded)
 * and wait for the full response.
 * Returns the response text and the final chat URL.
 *
 * Real Gemini DOM (as of March 2026):
 *   Input:    div.ql-editor[contenteditable][aria-label="Enter a prompt for Gemini"]
 *             inside <rich-textarea> inside <input-area-v2>
 *   Send:     button[aria-label="Send message"].send-button
 *   Loading:  button[aria-label="Stop response"] visible while generating
 *   Response: <structured-content-container class="model-response-text"> → .innerText
 *   Complete: .response-footer.complete appears; "Stop response" button disappears
 *   Chat URL: changes to /app/{conversationId} after first message
 */
export async function submitPromptAndWaitForResponse(
  page: Page,
  prompt: string,
): Promise<{ response: string; chatUrl: string }> {
  log.info("Submitting prompt to Gemini...");

  // Count existing response elements BEFORE submitting so waitForResponse knows
  // to wait for a NEW response rather than returning an already-stable old one.
  const prevResponseCount = await page.locator("structured-content-container").count()
    .catch(() => 0);

  // Focus the Quill contenteditable input, then insert text via execCommand.
  // document.execCommand('insertText') fires the proper beforeinput/input events
  // that Quill and Angular listen to, making the Send button become active.
  // DataTransfer paste and direct property assignment don't trigger these events.
  const inputLocator = page.locator(
    'div.ql-editor[aria-label="Enter a prompt for Gemini"]',
  );
  await inputLocator.waitFor({ state: "visible", timeout: 30_000 });
  await inputLocator.click();

  const inserted = await page.evaluate((text) => {
    return document.execCommand("insertText", false, text);
  }, prompt);

  if (!inserted) {
    // execCommand unavailable — fall back to DataTransfer paste
    log.warn("execCommand insertText failed, falling back to paste event");
    await page.evaluate((text) => {
      const editor = document.querySelector("div.ql-editor[contenteditable]");
      if (!editor) return;
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      editor.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }),
      );
    }, prompt);
  }

  // Verify text landed in the editor before trying to send
  const hasText = await page.evaluate(() => {
    const editor = document.querySelector("div.ql-editor[contenteditable]") as HTMLElement | null;
    return (editor?.textContent?.trim().length ?? 0) > 0;
  });
  if (!hasText) {
    log.warn("Editor appears empty after text insertion — prompt may not send correctly");
  }

  // Give Angular/Quill a moment to process and enable the Send button
  await page.waitForTimeout(1_000);

  // Click the send button — wait for it to be both visible and enabled
  const sendBtn = page.locator('button[aria-label="Send message"]');
  try {
    await sendBtn.waitFor({ state: "visible", timeout: 30_000 });
    // Also wait for it to be enabled (not disabled)
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('button[aria-label="Send message"]') as HTMLButtonElement | null;
        return btn !== null && !btn.disabled;
      },
      { timeout: 15_000 },
    );
    await sendBtn.click();
  } catch {
    // Fallback: re-focus editor and press Enter
    log.warn("Send button not clickable, re-focusing editor and pressing Enter");
    await inputLocator.click();
    await page.keyboard.press("Enter");
  }

  log.info("Prompt submitted, waiting for response...");

  // Wait for response to complete — pass prevResponseCount so the poller waits
  // for a NEW response container rather than reading an old stable one.
  const response = await waitForResponse(page, prevResponseCount);

  // Capture final chat URL (Gemini updates URL to /app/{conversationId})
  const chatUrl = page.url();

  log.info(`Response received (${response.length} chars). Chat URL: ${chatUrl}`);
  return { response, chatUrl };
}

/**
 * Wait for the Gemini response to complete using two strategies:
 *   1. Primary: wait for "Stop response" button to disappear + .response-footer.complete
 *   2. Fallback: text stability polling (3 consecutive unchanged reads)
 *
 * prevResponseCount: number of response containers present before this prompt
 * was sent. The poller will only start reading once a new container appears,
 * preventing it from returning an already-stable response from an earlier turn.
 */
async function waitForResponse(page: Page, prevResponseCount: number = 0): Promise<string> {
  const { pollInterval, stabilityChecks, responseTimeout } = CONFIG.gemini;
  const startTime = Date.now();

  // Wait for a new response container to appear (count must exceed previous)
  try {
    await page.waitForFunction(
      (prev) => document.querySelectorAll("structured-content-container").length > prev,
      prevResponseCount,
      { timeout: 30_000 },
    );
  } catch {
    log.warn("New response container did not appear within 30s — may be a fast/cached response");
  }

  // Wait for the "Stop response" button to appear first (response started)
  try {
    await page.locator('button[aria-label="Stop response"]').waitFor({
      state: "visible",
      timeout: 15_000,
    });
  } catch {
    log.warn("Stop response button never appeared — response may have been instant");
  }

  // Now wait for it to disappear (response complete)
  try {
    await page.locator('button[aria-label="Stop response"]').waitFor({
      state: "hidden",
      timeout: responseTimeout,
    });
  } catch {
    log.warn("Timed out waiting for Stop button to disappear, falling back to stability polling");
  }

  // Double-check with .response-footer.complete
  try {
    await page.locator(".response-footer.complete").last().waitFor({
      state: "attached",
      timeout: 10_000,
    });
  } catch {
    log.warn("response-footer.complete not found, using stability polling");
  }

  // Now extract text — but verify stability in case streaming is still ongoing.
  // Only read responses beyond prevResponseCount so we don't return a stale old response.
  let lastText = "";
  let stableCount = 0;

  while (Date.now() - startTime < responseTimeout) {
    const currentText = await extractResponseText(page, prevResponseCount);

    if (currentText.length > 0 && currentText === lastText) {
      stableCount++;
      if (stableCount >= stabilityChecks) {
        return currentText;
      }
    } else {
      stableCount = 0;
    }

    lastText = currentText;
    await page.waitForTimeout(pollInterval);
  }

  if (lastText.length > 0) {
    log.warn("Response timeout reached, returning partial response");
    return lastText;
  }

  throw new Error("Gemini response timeout — no response text found");
}

/**
 * Extract the most recent response text from the Gemini page.
 *
 * minResponseIndex: only read response containers beyond this index,
 * so we don't accidentally return an old response from a prior turn.
 */
async function extractResponseText(page: Page, minResponseIndex: number = 0): Promise<string> {
  // Primary: structured-content-container (the Gemini response web component)
  try {
    const responseEls = page.locator("structured-content-container");
    const count = await responseEls.count();
    if (count > minResponseIndex) {
      const text = await responseEls.last().innerText({ timeout: 3_000 });
      if (text.trim().length > 0) return text.trim();
    }
  } catch { /* fall through */ }

  // Fallback 1: message-content
  try {
    const msgEls = page.locator("message-content");
    const count = await msgEls.count();
    if (count > minResponseIndex) {
      const text = await msgEls.last().innerText({ timeout: 3_000 });
      if (text.trim().length > 0) return text.trim();
    }
  } catch { /* fall through */ }

  // Fallback 2: the markdown panel
  try {
    const markdownEls = page.locator(".markdown.markdown-main-panel");
    const count = await markdownEls.count();
    if (count > minResponseIndex) {
      const text = await markdownEls.last().innerText({ timeout: 3_000 });
      if (text.trim().length > 0) return text.trim();
    }
  } catch { /* fall through */ }

  return "";
}
