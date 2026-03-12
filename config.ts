import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CONFIG = {
  /** Root directory of the project */
  rootDir: __dirname,

  /** Panopto settings */
  panopto: {
    baseUrl: "https://auckland.au.panopto.com",
    subscriptionsPath: "/Panopto/Pages/Sessions/List.aspx#isSubscriptionsPage=true",
    /** Direct download URL template — replace {ID} with the Panopto GUID */
    downloadUrlTemplate:
      "https://auckland.au.panopto.com/Panopto/Podcast/Social/{ID}.mp4?mediaTargetType=videoPodcast",
    /** Max scroll attempts to load infinite-scroll items */
    maxScrolls: 3,
    /** Delay between scrolls (ms) */
    scrollDelay: 2000,
    /** Timeout for page navigation (ms) */
    navigationTimeout: 50_000,
  },

  /** Video splitting — max segment duration in seconds (e.g. 900 = 15 min) */
  segmentSeconds: 900,

  /** Gemini settings */
  gemini: {
    url: "https://gemini.google.com/app",
    /** How often to poll for response completion (ms) */
    pollInterval: 5_000,
    /** Number of consecutive unchanged polls before considering response complete */
    stabilityChecks: 3,
    /** Overall timeout for Gemini response (ms) */
    responseTimeout: 5 * 60_000,
    /** Timeout for video upload + Gemini processing confirmation (ms) */
    uploadTimeout: 30 * 60_000,
  },

  /** Course code extraction — tried in order, first match wins */
  courseCodePatterns: [
    /\b([A-Z]{2,8}\s?\d{3})\b/,         // e.g. COMPSCI 361, CS361
    /\b([A-Z]{2,8}-\d{3})\b/,            // e.g. COMPSCI-361
    /\b(\d{3}\s?[A-Z]{2,8})\b/,          // e.g. 361 COMPSCI
  ],

  /** Directories (relative to rootDir) */
  paths: {
    temp: path.join(__dirname, "temp"),
    lectures: path.join(__dirname, "Lectures"),
    logs: path.join(__dirname, "logs"),
    browserData: {
      panopto: path.join(__dirname, "browser-data", "panopto"),
      gemini: path.join(__dirname, "browser-data", "gemini"),
    },
    exports: path.join(__dirname, "Exports"),
    prompts: path.join(__dirname, "prompts"),
    incoming: path.join(__dirname, "Incoming"),
    db: path.join(__dirname, "uninotes.db"),
    todo: path.join(__dirname, "TODO.md"),
    lockFile: path.join(__dirname, "temp", ".lock"),
  },

  /** Browser launch options */
  browser: {
    channel: "msedge" as const,
    headless: false,
  },

  /** Retry defaults */
  retry: {
    maxRetries: 3,
    delayMs: 2_000,
  },
} as const;
