import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyUserSettings } from "./src/settings/overlay.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The defaults, in reviewable source with the reasoning attached.
 *
 * Exported separately from CONFIG because the control panel needs to answer
 * "is this value a default or an override?" and "what will the next run use?".
 * Both are unanswerable from the merged object alone: once an override is folded
 * in, the original is gone, so a setting returned to its default would look like
 * a change forever.
 */
export const DEFAULTS = {
  /** Root directory of the project */
  rootDir: __dirname,

  /**
   * Which backend handles each stage.
   *   "browser" — drive gemini.google.com with Playwright (uses your logged-in session, free)
   *   "api"     — call Gemini on Vertex AI via gcloud ADC (billed, parallelises far better)
   *
   * CLI flags override these: --uploader=api|browser (notes), --pretty=api|browser.
   */
  providers: {
    /** video → lecture.raw.md */
    notes: "browser" as "browser" | "api",
    /** lecture.raw.md → lecture.pretty.md */
    pretty: "api" as "browser" | "api",
  },

  /**
   * Concurrency limits. Set every value to 1 to reproduce the original
   * fully-sequential behaviour — the first thing to try when debugging.
   *
   * `lectures` and `parts` multiply, so the global caps below are what actually
   * protect Vertex quota and your upstream bandwidth.
   */
  concurrency: {
    /** Lectures processed simultaneously. */
    lectures: 3,
    /** Parts of a single lecture processed simultaneously. */
    parts: 4,
    /** Global cap on in-flight generateContent calls (across all lectures). */
    vertexInFlight: 8,
    /** Global cap on simultaneous GCS uploads — bounded by your upstream bandwidth. */
    gcsUploads: 3,
    /** Global cap on simultaneous Gemini browser tabs. */
    browserTabs: 3,
  },

  /** Panopto settings */
  panopto: {
    /**
     * Your institution's Panopto tenant, scheme and host only — no trailing slash.
     * This is the one value the tool cannot guess, so it ships empty and every
     * Panopto command fails with a message naming it until you set it.
     *
     * It's the first part of the address you see when watching a recording:
     *   https://auckland.au.panopto.com/Panopto/Pages/Viewer.aspx?id=...
     *   ^--------- this much ---------^
     *
     * Regional suffixes vary (`.hosted.`, `.eu.`, `.au.`, `.ca.`); the paths
     * underneath are the same on every tenant, which is why only the host is
     * configurable. Override with env UNINOTES_PANOPTO_URL.
     */
    baseUrl: "" as string,
    subscriptionsPath: "/Panopto/Pages/Sessions/List.aspx#isSubscriptionsPage=true",
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
    /** Model to select when opening a new Gemini chat (as it appears in the model picker) */
    model: "3.6 Flash",
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
    /**
     * Google blocks *sign-in* from headless browsers, but browser-data/gemini is
     * already authenticated, so headless may work for normal runs. Verify with
     * `npx tsx scripts/probe-browser.ts` before switching this on.
     */
    headless: false as boolean,
    /**
     * How the (headed) window is presented. Ignored when headless.
     *   "normal"    — visible window, as before
     *   "offscreen" — real headed window parked outside the visible desktop
     *   "hidden"    — real headed window hidden via Win32 ShowWindow(SW_HIDE)
     *
     * "offscreen"/"hidden" keep the browser genuinely headed (so Google's
     * fingerprinting is unaffected) while keeping it out of your way.
     */
    windowMode: "offscreen" as "normal" | "offscreen" | "hidden",
    /** Save per-tab screenshots to temp/ when a browser step fails. */
    debugScreenshots: false as boolean,
    /**
     * Minimum gap (ms) between starting one Gemini tab and the next, plus up to
     * 40% jitter.
     *
     * Google served its "unusual traffic" bot check during testing after bursts
     * of simultaneous conversations, which locks the profile out of the browser
     * path entirely until it clears. Staggering starts makes the traffic pattern
     * much less bursty at almost no throughput cost, since the long
     * upload/generation waits still overlap. Set to 0 to disable.
     */
    tabStaggerMs: 2_000,
  },

  /** Retry defaults */
  retry: {
    maxRetries: 3,
    delayMs: 2_000,
  },

  /**
   * A second copy of each pretty note, filed into another folder as it's written
   * — typically the OneDrive/Dropbox/Obsidian folder you actually study from.
   *
   * Off by default: there is no sensible guess for where your notes live, and a
   * tool that starts writing into a synced folder you didn't nominate is worse
   * than one that does nothing.
   */
  workspace: {
    /** Turn the second copy off entirely. Nothing else here applies when false. */
    enabled: false as boolean,
    root: path.join(os.homedir(), "Documents", "UniNotes"),
    unsortedFolder: "Unsorted Lectures",
  },

  /** Vertex AI (Google Cloud) settings — used by the "api" uploader mode */
  vertex: {
    /**
     * Google Cloud project ID. Only needed when a stage's provider is "api" —
     * the browser path never touches Google Cloud. Override with env
     * GOOGLE_CLOUD_PROJECT.
     */
    project: "" as string,
    /** Vertex endpoint region. Override with env GOOGLE_CLOUD_LOCATION.
     * NOTE: the 3.x Flash models are only served on "global" (404 in us-central1).
     * Verified for gemini-3.6-flash via scripts/probe-vertex.ts. */
    location: "global",
    /** Model used for video → notes on the API path. */
    model: "gemini-3.6-flash",

    /**
     * Gemini 3.x Flash thinks by default, and thinking tokens are charged against
     * maxOutputTokens. If thinking exhausts the budget the API returns
     * finishReason=MAX_TOKENS with an EMPTY string — not a partial answer — so
     * these headrooms matter more than they look.
     */
    generation: {
      /** Video → notes. Thinking left on; comprehension benefits from it. */
      notes: {
        maxOutputTokens: 65_536,
        /** undefined = model default. Lower levels trim latency at some quality cost. */
        thinkingLevel: undefined as "minimal" | "low" | "medium" | "high" | undefined,
      },
      /** Raw → pretty. Mechanical reformatting, so thinking is disabled:
       *  faster, cheaper, and the whole token budget goes to actual markdown. */
      pretty: {
        model: "gemini-3.6-flash",
        maxOutputTokens: 65_536,
        thinkingBudget: 0,
      },
    },
    /**
     * GCS bucket video chunks are staged in before calling generateContent.
     * Blank derives `uninotes-<project>` and creates it on first use, which is
     * one less globally-unique name for you to invent. Set it if you'd rather
     * reuse a bucket you already own. Override with env UNINOTES_GCS_BUCKET.
     */
    gcsBucket: "" as string,
    /** GCS bucket region — must be a real Cloud Storage location. Kept separate
     * from `location` because Vertex uses "global" but GCS rejects it.
     * Override with env UNINOTES_GCS_BUCKET_LOCATION. */
    bucketLocation: "us-central1",
    /** Delete uploaded GCS objects after each part is processed (best-effort).
     * Widened from the literal because the GUI can override it — left as `true`,
     * TypeScript would treat the "keep the chunks" branch as dead code. */
    cleanupUploads: true as boolean,
  },
} as const;

/**
 * What this process actually runs with: the defaults above with settings.json
 * merged over the top. Read once at import, so a running process keeps a stable
 * view — each pipeline job is its own process and picks up changes on start.
 */
export const CONFIG = applyUserSettings(DEFAULTS);
