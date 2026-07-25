import type { Page } from "playwright";
import { CONFIG } from "../../config.js";
import { log, type LogContext } from "../utils/logger.js";
import { withClipboard } from "./browserPool.js";

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
  ctx?: LogContext,
): Promise<{ response: string; chatUrl: string }> {
  log.info("Submitting prompt to Gemini...", ctx);

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

  // execCommand("insertText") operates on the document's active selection. That
  // reads like it needs the real foreground tab, but Playwright's per-page focus
  // emulation makes each pooled tab believe it is focused, so this works in all
  // of them concurrently — verified with 3 tabs inserting distinct prompts and
  // each editor receiving its own text. No mutex needed.
  await inputLocator.click();

  const inserted = await page.evaluate((text) => {
    return document.execCommand("insertText", false, text);
  }, prompt);

  if (!inserted) {
    // execCommand unavailable — fall back to DataTransfer paste
    log.warn("execCommand insertText failed, falling back to paste event", ctx);
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
    log.warn("Editor appears empty after text insertion — prompt may not send correctly", ctx);
  }

  // Give Angular/Quill a moment to process the inserted text
  await page.waitForTimeout(1_000);

  // Wait for the send button to be visible and enabled. For large files,
  // the video may still be uploading/processing server-side even after the
  // upload chip appeared, so the send button stays disabled until the file
  // is fully ready. Use a generous timeout (5 min) to accommodate this.
  const sendBtn = page.locator('button[aria-label="Send message"]');
  await sendBtn.waitFor({ state: "visible", timeout: 30_000 });
  log.info("Waiting for send button to be enabled (video may still be processing)...", ctx);
  await page.waitForFunction(
    () => {
      const sendBtn = document.querySelector('button[aria-label="Send message"]');
      if (!sendBtn) return false;
      const gemWrapper = sendBtn.closest("gem-icon-button");
      if (gemWrapper) return gemWrapper.getAttribute("aria-disabled") !== "true";
      return sendBtn.getAttribute("aria-disabled") !== "true";
    },
    undefined,
    { timeout: CONFIG.gemini.responseTimeout },
  );

  // Send button is enabled — click it, fall back to Enter if click fails.
  // The Enter fallback types into this page's focused element, which under focus
  // emulation is this tab's editor regardless of which tab the window shows.
  try {
    await sendBtn.click({ timeout: 15_000 });
  } catch {
    log.warn("Send button click failed, re-focusing editor and pressing Enter", ctx);
    await inputLocator.click();
    await page.keyboard.press("Enter");
  }

  log.info("Prompt submitted, waiting for response...", ctx);

  // Wait for response to complete — pass prevResponseCount so the poller waits
  // for a NEW response container rather than reading an old stable one.
  // `prompt` is passed only so markdown extraction can prove it didn't copy it back.
  const response = await waitForResponse(page, prevResponseCount, ctx, prompt);

  // Capture final chat URL (Gemini updates URL to /app/{conversationId})
  const chatUrl = page.url();

  log.info(`Response received (${response.length} chars). Chat URL: ${chatUrl}`, ctx);
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
async function waitForResponse(
  page: Page,
  prevResponseCount: number = 0,
  ctx?: LogContext,
  sentPrompt?: string,
): Promise<string> {
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
    log.warn("New response container did not appear within 30s — may be a fast/cached response", ctx);
  }

  // Wait for the "Stop response" button to appear first (response started)
  try {
    await page.locator('button[aria-label="Stop response"]').waitFor({
      state: "visible",
      timeout: 15_000,
    });
  } catch {
    log.warn("Stop response button never appeared — response may have been instant", ctx);
  }

  // Now wait for it to disappear (response complete)
  try {
    await page.locator('button[aria-label="Stop response"]').waitFor({
      state: "hidden",
      timeout: responseTimeout,
    });
  } catch {
    log.warn("Timed out waiting for Stop button to disappear, falling back to stability polling", ctx);
  }

  // Double-check with .response-footer.complete
  try {
    await page.locator(".response-footer.complete").last().waitFor({
      state: "attached",
      timeout: 10_000,
    });
  } catch {
    log.warn("response-footer.complete not found, using stability polling", ctx);
  }

  // Poll innerText for STABILITY only — it's cheap and detects streaming reliably.
  // Once settled, re-read via the copy button to recover the actual markdown.
  // Only read responses beyond prevResponseCount so we don't return a stale old response.
  let lastText = "";
  let stableCount = 0;

  while (Date.now() - startTime < responseTimeout) {
    const currentText = await extractResponseText(page, prevResponseCount);

    if (currentText.length > 0 && currentText === lastText) {
      stableCount++;
      if (stableCount >= stabilityChecks) {
        return (await extractResponseMarkdown(page, ctx, sentPrompt, currentText)) ?? currentText;
      }
    } else {
      stableCount = 0;
    }

    lastText = currentText;
    await page.waitForTimeout(pollInterval);
  }

  if (lastText.length > 0) {
    log.warn("Response timeout reached, returning partial response", ctx);
    return (await extractResponseMarkdown(page, ctx, sentPrompt, lastText)) ?? lastText;
  }

  throw new Error("Gemini response timeout — no response text found");
}

/**
 * Read the response as real markdown via Gemini's "Copy" button.
 *
 * The page displays RENDERED HTML, so innerText scraping silently strips every
 * markdown marker: headings lose their "#", bold loses its "**", list bullets and
 * table pipes disappear entirely. (All 63 lecture.raw.md files produced before
 * this existed contain zero "#" headings — the structure was never captured.)
 *
 * The copy button puts the original markdown source on the clipboard, which is
 * the only way to get it back out of the web UI.
 *
 * Returns null if the button or clipboard is unavailable, so the caller can fall
 * back to innerText rather than failing outright.
 */
/**
 * Do these two texts describe the same response?
 *
 * Compares alphanumerics only, so markdown syntax the rendered view drops
 * ("#", "**", table pipes) doesn't cause a false mismatch.
 */
function corroborates(renderedText: string, markdown: string): boolean {
  const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const rendered = normalise(renderedText);
  const copied = normalise(markdown);
  if (rendered.length < 80) return true; // too short to judge

  // Several small probes rather than one long one. The rendered view injects
  // chrome the markdown has no equivalent for (file-type chips like "MD",
  // citation markers), and any single long sample is likely to straddle one and
  // produce a false mismatch. A different response fails nearly all probes,
  // while chrome only costs us one or two.
  const SAMPLES = 5;
  const WINDOW = 40;
  let hits = 0;
  let taken = 0;

  for (let i = 1; i <= SAMPLES; i++) {
    const start = Math.floor((rendered.length * i) / (SAMPLES + 1));
    const sample = rendered.slice(start, start + WINDOW);
    if (sample.length < WINDOW) continue;
    taken++;
    if (copied.includes(sample)) hits++;
  }

  if (taken === 0) return true;
  return hits / taken >= 0.5;
}

async function extractResponseMarkdown(
  page: Page,
  ctx?: LogContext,
  sentPrompt?: string,
  renderedText?: string,
): Promise<string | null> {
  try {
    // Scope to the LAST model-response and match aria-label EXACTLY.
    //
    // The page also carries a "Copy prompt" button, which a loose *="Copy"
    // selector matches — combined with .last() that can silently copy the prompt
    // and return it as the model's answer. Exact matching rules that out.
    const response = page.locator("model-response").last();
    const candidates = [
      response.locator('button[aria-label="Copy"]'),
      response.locator('button[data-test-id="copy-button"]'),
      // Last resort: page-wide exact "Copy", still excluding "Copy prompt".
      page.locator('button[aria-label="Copy"]').last(),
    ];

    // CRITICAL: the click AND the clipboard read must happen in ONE critical
    // section. The clipboard is a single browser-wide resource, so splitting them
    // lets another tab copy in between — tab A would then read tab B's response
    // and write it into A's lecture file. That is silent cross-lecture corruption,
    // not a formatting glitch, so the mutex has to span both operations.
    //
    // This is now the ONLY serialisation point left in the browser path; every
    // other interaction runs concurrently. Short critical section: the response
    // has already been generated by the time we get here.
    const text = await withClipboard(page, async () => {
      // Stamp a sentinel FIRST so we can tell "the copy worked" apart from
      // "the click did nothing and we re-read the previous value".
      //
      // This matters more than it looks: message-actions mounts before Angular
      // binds its click handler, so a click that lands during hydration is a
      // silent no-op — and readText() then returns the PREVIOUS lecture's notes,
      // still sitting in the clipboard from an earlier tab. Requiring the value
      // to actually change is what makes that impossible.
      const sentinel = `__uninotes_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
      await page.evaluate((s) => navigator.clipboard.writeText(s), sentinel).catch(() => {});

      const deadline = Date.now() + 20_000;
      let attempt = 0;

      while (Date.now() < deadline) {
        let clicked = false;

        for (const button of candidates) {
          try {
            const target = button.last();
            await target.waitFor({ state: "visible", timeout: 5_000 });
            await target.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});

            // Dispatch the click directly rather than via locator.click(). The
            // button is visible but sits under the sticky composer, so
            // Playwright's "does it receive pointer events?" check times out on
            // a control that is perfectly clickable programmatically. We only
            // want the side effect, so hit-testing buys us nothing.
            await target.evaluate((el) => (el as HTMLElement).click());
            clicked = true;
            break;
          } catch {
            // Absent, detached, or still not clickable — try the next candidate.
          }
        }

        if (clicked) {
          // Poll briefly: the clipboard write is async relative to the click.
          for (let i = 0; i < 6; i++) {
            await page.waitForTimeout(250);
            const current = await page
              .evaluate(() => navigator.clipboard.readText())
              .catch(() => "");
            if (current && current !== sentinel) return current;
          }
        }

        attempt++;
        // Handler probably wasn't bound yet — let it hydrate and click again.
        await page.waitForTimeout(500);
      }

      const diag = await page
        .evaluate(() => ({
          responses: document.querySelectorAll("model-response").length,
          copyBtns: Array.from(document.querySelectorAll("button"))
            .filter((b) => /copy/i.test(b.getAttribute("aria-label") || ""))
            .map((b) => `${b.getAttribute("aria-label")}:vis=${!!(b as HTMLElement).offsetParent}`),
          hidden: document.hidden,
        }))
        .catch(() => null);
      log.warn(
        `Copy produced no clipboard change after ${attempt} attempt(s) (${JSON.stringify(diag)}) — ` +
          `falling back to innerText, which loses markdown formatting.`,
        ctx,
      );
      return null;
    });

    const trimmed = (text ?? "").trim();
    if (trimmed.length === 0) return null;

    // Paranoia: if a UI change ever makes us hit "Copy prompt" instead, we'd be
    // handing the caller its own prompt back as though it were the answer.
    // Silently writing that into a lecture file would be far worse than losing
    // the markdown formatting, so fall back instead.
    if (sentPrompt && trimmed === sentPrompt.trim()) {
      log.warn("Copy button returned the prompt, not the response — falling back to innerText.", ctx);
      return null;
    }

    // Defence in depth against a stale/foreign clipboard: the copied markdown
    // must actually match the text rendered in THIS tab. Wrong-but-plausible
    // notes silently filed under the wrong lecture are the worst outcome here,
    // so anything that doesn't corroborate falls back to the (correct, if
    // unformatted) innerText.
    if (renderedText && !corroborates(renderedText, trimmed)) {
      log.warn(
        "Clipboard content does not match this tab's response (possible cross-tab copy) — falling back to innerText.",
        ctx,
      );
      return null;
    }

    log.debug(`Extracted ${trimmed.length} chars of markdown via copy button`, ctx);
    return trimmed;
  } catch (err) {
    log.warn(
      `Copy-button extraction failed (${err instanceof Error ? err.message : String(err)}) — falling back to innerText, which loses markdown formatting.`,
      ctx,
    );
    return null;
  }
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

