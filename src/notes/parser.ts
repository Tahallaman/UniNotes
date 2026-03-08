import { log } from "../utils/logger.js";

export interface ParsedActions {
  summary: string;
  actionItems: string[];
  keyTopics: string[];
  lectureDate: string | null;
}

export interface ParsedResponse {
  markdown: string;
  actions: ParsedActions | null;
}

/**
 * Parse the Gemini response into clean Markdown notes and structured JSON actions.
 */
export function parseGeminiResponse(raw: string): ParsedResponse {
  // Extract the ---JSON-ACTIONS-START--- ... ---JSON-ACTIONS-END--- block.
  // Plain-text delimiters survive Gemini's HTML rendering (unlike ``` code fences
  // which get stripped when extracting innerText from the page).
  const jsonBlockRegex = /---JSON-ACTIONS-START---\s*\n([\s\S]*?)\n---JSON-ACTIONS-END---/;
  const match = raw.match(jsonBlockRegex);

  let actions: ParsedActions | null = null;
  let markdown = raw;

  if (match) {
    // Remove the JSON block from the markdown
    markdown = raw.replace(jsonBlockRegex, "").trim();

    // Parse the JSON
    try {
      const parsed = JSON.parse(match[1].trim());
      actions = {
        summary: parsed.summary || "",
        actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
        keyTopics: Array.isArray(parsed.keyTopics) ? parsed.keyTopics : [],
        lectureDate: parsed.lectureDate || null,
      };
    } catch (err) {
      log.warn(`Failed to parse json-actions block: ${err}`);
    }
  } else {
    log.warn("No json-actions block found in Gemini response");
  }

  // Clean up the markdown
  markdown = cleanMarkdown(markdown);

  return { markdown, actions };
}

/**
 * Clean up Gemini's markdown output.
 */
function cleanMarkdown(text: string): string {
  let cleaned = text;

  // Strip common Gemini preambles
  const preambles = [
    /^(?:okay|sure|here are|here's|i've|below are)[^\n]*\n+/i,
    /^(?:based on the (?:video|lecture))[^\n]*\n+/i,
  ];
  for (const p of preambles) {
    cleaned = cleaned.replace(p, "");
  }

  // Strip everything before the first # heading (Gemini sometimes includes
  // self-narration or timestamp preambles before the actual notes).
  if (!cleaned.startsWith("#")) {
    const firstHeading = cleaned.indexOf("\n#");
    if (firstHeading !== -1) {
      cleaned = cleaned.slice(firstHeading + 1);
    }
  }

  // Remove trailing whitespace from each line
  cleaned = cleaned
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");

  // Remove excessive blank lines (more than 2 consecutive)
  cleaned = cleaned.replace(/\n{4,}/g, "\n\n\n");

  return cleaned.trim();
}
