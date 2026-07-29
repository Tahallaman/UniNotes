/**
 * Thin wrapper around Vertex generateContent, shared by the notes and pretty paths.
 *
 * Exists mainly to handle one non-obvious failure mode. Gemini 3.x Flash thinks by
 * default, and thinking tokens are charged against maxOutputTokens. When thinking
 * exhausts the budget the API returns finishReason=MAX_TOKENS with an EMPTY string —
 * not a truncated answer. Measured on gemini-3.6-flash: a 7-token prompt spent 113
 * tokens thinking, and with maxOutputTokens=50 the reply came back "".
 *
 * Without an explicit check that surfaces as "the model returned nothing", which
 * looks identical to a transient failure and burns the entire retry budget.
 */

import { ThinkingLevel, type Content, type Part, type ThinkingConfig } from "@google/genai";
import { getClient } from "./vertexClient.js";
import { log, type LogContext } from "../utils/logger.js";

/** Request timeout for a single generateContent call (ms). */
const GENERATE_TIMEOUT_MS = 30 * 60_000;

export class TruncatedResponseError extends Error {
  /** Permanent for the given budget — retrying unchanged just wastes quota. */
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = "TruncatedResponseError";
  }
}

/** Config uses lowercase names; the SDK wants its ThinkingLevel enum. */
export type ThinkingLevelName = "minimal" | "low" | "medium" | "high";

const THINKING_LEVELS: Record<ThinkingLevelName, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

export interface GenerateOptions {
  model: string;
  parts: Part[];
  maxOutputTokens: number;
  /** Model default when omitted. Mutually exclusive with thinkingBudget. */
  thinkingLevel?: ThinkingLevelName;
  /** 0 disables thinking entirely — right for mechanical reformatting. */
  thinkingBudget?: number;
  ctx?: LogContext;
}

export async function generateText(opts: GenerateOptions): Promise<string> {
  return generateChat({
    ...opts,
    contents: [{ role: "user", parts: opts.parts }],
  });
}

export interface ChatOptions extends Omit<GenerateOptions, "parts"> {
  /** The conversation so far, ending with the turn to answer. */
  contents: Content[];
  /**
   * Standing instructions, outside the conversation.
   *
   * Where the lecture material goes for "Explain this": rebuilt on every turn
   * from wherever the video has got to, so a follow-up asked after scrubbing
   * elsewhere is answered about where you are now — while the conversation
   * itself stays a plain sequence of questions and answers.
   */
  systemInstruction?: string;
  /** Overrides the pipeline's half-hour ceiling, which is a lifetime for a chat. */
  timeoutMs?: number;
}

/**
 * A multi-turn call. `generateText` is this with one turn and no history.
 *
 * The timeout is the SDK's own rather than an AbortController wrapped around it:
 * an abort on our side would leave the request running at the far end and still
 * be billed, whereas httpOptions.timeout is the client giving up on a connection
 * it owns. Nothing here can be cancelled by the user, so this is the only thing
 * standing between a hung call and a socket held until the panel restarts.
 */
export async function generateChat(opts: ChatOptions): Promise<string> {
  const { model, contents, maxOutputTokens, thinkingLevel, thinkingBudget, systemInstruction, timeoutMs, ctx } = opts;

  const thinkingConfig: ThinkingConfig | undefined =
    thinkingBudget !== undefined
      ? { thinkingBudget }
      : thinkingLevel !== undefined
        ? { thinkingLevel: THINKING_LEVELS[thinkingLevel] }
        : undefined;

  const response = await getClient().models.generateContent({
    model,
    contents,
    config: {
      maxOutputTokens,
      ...(thinkingConfig ? { thinkingConfig } : {}),
      ...(systemInstruction ? { systemInstruction } : {}),
      httpOptions: { timeout: timeoutMs ?? GENERATE_TIMEOUT_MS },
    },
  });

  const finishReason = response.candidates?.[0]?.finishReason;
  const usage = response.usageMetadata;
  const thoughts = (usage as { thoughtsTokenCount?: number } | undefined)?.thoughtsTokenCount;

  // Logged with or without a lecture context. The prompt count is the only
  // honest answer to "what did that question actually cost?" — for a chat it
  // grows with the conversation, and arithmetic over character counts is a guess.
  if (usage) {
    const line =
      `tokens: prompt=${usage.promptTokenCount} thinking=${thoughts ?? 0} output=${usage.candidatesTokenCount}`;
    if (ctx) log.debug(line, ctx);
    else log.debug(line);
  }

  const text = (response.text ?? "").trim();

  if (finishReason === "MAX_TOKENS") {
    throw new TruncatedResponseError(
      `Response hit maxOutputTokens (${maxOutputTokens}); ` +
        `thinking used ${thoughts ?? "?"} tokens, output got ${usage?.candidatesTokenCount ?? 0}. ` +
        `Raise the caller's maxOutputTokens or lower the thinking budget.`,
    );
  }

  if (finishReason && finishReason !== "STOP") {
    // SAFETY, RECITATION, BLOCKLIST etc. — surface the actual reason rather than
    // letting it read as an empty/short response.
    throw new Error(`Generation stopped early: finishReason=${finishReason}`);
  }

  return text;
}
