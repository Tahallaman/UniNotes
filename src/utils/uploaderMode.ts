/**
 * Resolve which backend each stage uses: Playwright automation against
 * gemini.google.com, or Gemini on Vertex AI.
 *
 * Resolution order (first hit wins):
 *   1. CLI flag  --uploader=api|browser   /  --pretty=api|browser
 *   2. Env var   UNINOTES_UPLOADER        /  UNINOTES_PRETTY
 *   3. config.ts CONFIG.providers.notes   /  CONFIG.providers.pretty
 */

import { CONFIG } from "../../config.js";

export type UploaderMode = "api" | "browser";
/** Alias used by the pipeline, where "uploader" reads oddly for a text stage. */
export type NotesProvider = UploaderMode;

function parseMode(raw: string | undefined | null): UploaderMode | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "api" || normalized === "browser") return normalized;
  return null;
}

/** Read `--flag=value` or `--flag value` out of an argv slice. */
function flagValue(args: string[], flag: string): UploaderMode | null {
  const prefix = `--${flag}=`;
  for (const arg of args) {
    if (arg.startsWith(prefix)) {
      const value = parseMode(arg.slice(prefix.length));
      if (value) return value;
    }
  }

  const index = args.indexOf(`--${flag}`);
  if (index !== -1) {
    const value = parseMode(args[index + 1]);
    if (value) return value;
  }

  return null;
}

/** Which backend turns video into raw notes. */
export function resolveUploaderMode(args: string[]): UploaderMode {
  return (
    flagValue(args, "uploader") ??
    parseMode(process.env.UNINOTES_UPLOADER) ??
    CONFIG.providers.notes
  );
}

/** Which backend turns raw notes into pretty notes. */
export function resolvePrettyMode(args: string[]): UploaderMode {
  return (
    flagValue(args, "pretty") ??
    parseMode(process.env.UNINOTES_PRETTY) ??
    CONFIG.providers.pretty
  );
}
