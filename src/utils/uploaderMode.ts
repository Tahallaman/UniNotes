/**
 * Resolve which upload path to use: the Playwright browser automation
 * against gemini.google.com, or the Vertex AI API path.
 *
 * Resolution order:
 *   1. CLI flag  --uploader=api|browser
 *   2. Env var   UNINOTES_UPLOADER=api|browser
 *   3. Default   "browser"
 */

export type UploaderMode = "api" | "browser";

function parseMode(raw: string | undefined | null): UploaderMode | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "api" || normalized === "browser") return normalized;
  return null;
}

/**
 * Resolve the uploader mode from CLI args (e.g. process.argv.slice(2)) and env vars.
 */
export function resolveUploaderMode(args: string[]): UploaderMode {
  for (const arg of args) {
    if (arg.startsWith("--uploader=")) {
      const value = parseMode(arg.slice("--uploader=".length));
      if (value) return value;
    }
  }

  const flagIndex = args.indexOf("--uploader");
  if (flagIndex !== -1) {
    const value = parseMode(args[flagIndex + 1]);
    if (value) return value;
  }

  const envValue = parseMode(process.env.UNINOTES_UPLOADER);
  if (envValue) return envValue;

  return "browser";
}
