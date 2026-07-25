/**
 * Gemini web UI implementation of the PartRunner contract.
 *
 * Each part gets its own tab and therefore its own fresh conversation. That isn't
 * just a concurrency convenience — Gemini has long-standing bugs with multi-video
 * conversations (it ignores subsequent uploads), so parts must not share a chat.
 *
 * Ordering, checkpointing and timestamp rebasing live in partRunner.ts.
 */

import { log } from "../utils/logger.js";
import { withTab, GeminiRateLimitedError } from "../gemini/browserPool.js";
import { uploadFileToGemini } from "../gemini/uploader.js";
import { submitPromptAndWaitForResponse } from "../gemini/prompter.js";
import type { PartRunner } from "./partRunner.js";

const MAX_ATTEMPTS = 3;

export function createBrowserRunner(): PartRunner {
  return {
    name: "browser",
    async runPart({ videoPath, prompt, ctx }) {
      let lastErr: unknown;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          return await withTab(async (page) => {
            await uploadFileToGemini(page, videoPath, { waitForProcessing: true, ctx });
            const { response, chatUrl } = await submitPromptAndWaitForResponse(page, prompt, ctx);

            log.info(`Response: ${response.length} chars`, ctx);

            if (response.length < 200 && !response.includes("#")) {
              throw new Error(`Short response (${response.length} chars)`);
            }
            return { raw: response, chatUrl };
          });
        } catch (err) {
          lastErr = err;
          log.warn(
            `Attempt ${attempt + 1}/${MAX_ATTEMPTS} failed: ${err instanceof Error ? err.message : String(err)}`,
            ctx,
          );

          // Retrying a rate-limit means three more page loads against a Google
          // endpoint that is already refusing us, which prolongs the block
          // rather than clearing it. Fail fast and let the checkpoint resume
          // this part on a later run.
          if (err instanceof GeminiRateLimitedError) {
            log.warn("Rate-limited by Google — abandoning retries for this part.", ctx);
            break;
          }
          // withTab's finally already closed the tab, so the retry starts from a
          // genuinely clean conversation.
        }
      }

      throw lastErr instanceof Error ? lastErr : new Error("Gemini browser processing failed");
    },
  };
}
