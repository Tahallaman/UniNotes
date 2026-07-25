/**
 * The whitelist of settings the GUI may change, described once.
 *
 * This list is the single source of truth for three things that would otherwise
 * drift apart: which keys `settings.json` is allowed to override, how the form
 * renders them, and how a submitted value is validated. Adding a setting is one
 * entry here — it gets a control, a validator and persistence for free.
 *
 * Deliberately *not* everything in config.ts. Paths, URL templates and course-code
 * regexes are code-shaped; putting them behind a text box invites a typo that
 * breaks the pipeline in a way no error message explains.
 *
 * Kept free of imports (config.ts loads it) so there is no cycle.
 */

export type SettingType = "enum" | "int" | "bool" | "text";

export interface SettingField {
  /** Dotted path into CONFIG, e.g. "concurrency.parts". */
  path: string;
  label: string;
  group: string;
  type: SettingType;
  /** For "enum". A blank-string option means "leave unset / model default". */
  options?: readonly string[];
  min?: number;
  max?: number;
  help?: string;
  /** Renders as a slider rather than a number box. */
  slider?: boolean;
  /** Shown in a warning colour — changing it has consequences beyond the next run. */
  caution?: string;
}

export const SETTING_FIELDS: readonly SettingField[] = [
  // ── Providers ───────────────────────────────────────────────────────────
  {
    path: "providers.notes",
    label: "Notes backend",
    group: "Providers",
    type: "enum",
    options: ["browser", "api"],
    help: "video → lecture.raw.md. browser is free but slower; api is billed and parallelises.",
  },
  {
    path: "providers.pretty",
    label: "Pretty backend",
    group: "Providers",
    type: "enum",
    options: ["browser", "api"],
    help: "lecture.raw.md → lecture.pretty.md.",
  },

  // ── Models ──────────────────────────────────────────────────────────────
  {
    path: "vertex.model",
    label: "Vertex model (notes)",
    group: "Models",
    type: "text",
    help: "Used when the notes backend is api. Verify with the Vertex probe after changing.",
  },
  {
    path: "vertex.generation.pretty.model",
    label: "Vertex model (pretty)",
    group: "Models",
    type: "text",
    help: "Separate so the cheap mechanical reformat can use a different model.",
  },
  {
    path: "gemini.model",
    label: "Web picker label",
    group: "Models",
    type: "text",
    help: 'Matched against the model picker on gemini.google.com — e.g. "3.6 Flash". Not a model ID.',
  },
  {
    path: "vertex.location",
    label: "Vertex location",
    group: "Models",
    type: "text",
    help: "3.x Flash is only served on global; other regions 404.",
  },
  {
    path: "vertex.generation.notes.thinkingLevel",
    label: "Thinking (notes)",
    group: "Models",
    type: "enum",
    options: ["", "minimal", "low", "medium", "high"],
    help: "Blank = model default. Lower trims latency at some comprehension cost.",
  },
  {
    path: "vertex.cleanupUploads",
    label: "Delete GCS chunks after use",
    group: "Models",
    type: "bool",
    help: "Turn off only to debug what was actually uploaded — chunks are large.",
  },

  // ── Concurrency ─────────────────────────────────────────────────────────
  {
    path: "concurrency.lectures",
    label: "Lectures at once",
    group: "Concurrency",
    type: "int",
    min: 1,
    max: 10,
    slider: true,
  },
  {
    path: "concurrency.parts",
    label: "Parts per lecture",
    group: "Concurrency",
    type: "int",
    min: 1,
    max: 10,
    slider: true,
    help: "Multiplies with lectures — the global caps below are what actually protect quota.",
  },
  {
    path: "concurrency.vertexInFlight",
    label: "Vertex calls in flight",
    group: "Concurrency",
    type: "int",
    min: 1,
    max: 32,
    slider: true,
    help: "Vertex uses dynamic shared quota, so drop this if the log fills with 429s.",
  },
  {
    path: "concurrency.gcsUploads",
    label: "GCS uploads in flight",
    group: "Concurrency",
    type: "int",
    min: 1,
    max: 16,
    slider: true,
    help: "Bounded by your upstream bandwidth — more is rarely faster.",
  },
  {
    path: "concurrency.browserTabs",
    label: "Gemini browser tabs",
    group: "Concurrency",
    type: "int",
    min: 1,
    max: 8,
    slider: true,
  },

  // ── Video & retries ─────────────────────────────────────────────────────
  {
    path: "segmentSeconds",
    label: "Segment length (seconds)",
    group: "Video & retries",
    type: "int",
    min: 60,
    max: 3600,
    caution: "Part checkpoints are fingerprinted against this — changing it discards in-progress resume data.",
  },
  {
    path: "retry.maxRetries",
    label: "Max retries",
    group: "Video & retries",
    type: "int",
    min: 1,
    max: 10,
  },
  {
    path: "gemini.responseTimeout",
    label: "Response timeout (ms)",
    group: "Video & retries",
    type: "int",
    min: 30_000,
    max: 3_600_000,
  },
  {
    path: "gemini.uploadTimeout",
    label: "Upload timeout (ms)",
    group: "Video & retries",
    type: "int",
    min: 60_000,
    max: 7_200_000,
    help: "Raise for very large videos on a slow connection.",
  },

  // ── Browser ─────────────────────────────────────────────────────────────
  {
    path: "browser.headless",
    label: "Headless",
    group: "Browser",
    type: "bool",
    help: "Google blocks headless sign-in, but an already-authenticated profile may work. Run the browser probe first.",
  },
  {
    path: "browser.windowMode",
    label: "Window mode",
    group: "Browser",
    type: "enum",
    options: ["normal", "offscreen", "hidden"],
    help: "How the headed window is presented. Ignored when headless.",
  },
  {
    path: "browser.debugScreenshots",
    label: "Debug screenshots",
    group: "Browser",
    type: "bool",
    help: "Save a per-tab screenshot to temp/ when a browser step fails.",
  },
  {
    path: "browser.tabStaggerMs",
    label: "Tab start stagger (ms)",
    group: "Browser",
    type: "int",
    min: 0,
    max: 30_000,
    help: "Gap between starting one Gemini tab and the next. Raise it if Google serves the \"unusual traffic\" check; 0 disables staggering.",
  },

  // ── Workspace ───────────────────────────────────────────────────────────
  {
    path: "workspace.root",
    label: "Workspace root",
    group: "Workspace",
    type: "text",
    help: "Pretty notes are mirrored here after each lecture. Sync failures are non-fatal.",
  },
];

const BY_PATH = new Map(SETTING_FIELDS.map((f) => [f.path, f]));

export function getField(path: string): SettingField | undefined {
  return BY_PATH.get(path);
}

export interface CoercionResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/**
 * Validate and coerce one submitted value against its field.
 *
 * Runs on the server as well as in the form: `settings.json` is a plain file the
 * user can also hand-edit, and a string where a number belongs would otherwise
 * surface as a baffling failure deep inside the pipeline.
 */
export function coerce(field: SettingField, raw: unknown): CoercionResult {
  switch (field.type) {
    case "bool": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      if (raw === "true" || raw === "false") return { ok: true, value: raw === "true" };
      return { ok: false, error: `${field.path}: expected a boolean` };
    }

    case "int": {
      const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
      if (!Number.isFinite(n)) return { ok: false, error: `${field.path}: not a number` };
      if (field.min !== undefined && n < field.min) {
        return { ok: false, error: `${field.path}: must be at least ${field.min}` };
      }
      if (field.max !== undefined && n > field.max) {
        return { ok: false, error: `${field.path}: must be at most ${field.max}` };
      }
      return { ok: true, value: Math.round(n) };
    }

    case "enum": {
      const s = raw === undefined || raw === null ? "" : String(raw);
      if (!field.options?.includes(s)) {
        return { ok: false, error: `${field.path}: must be one of ${field.options?.join(", ")}` };
      }
      // A blank enum means "unset" — store undefined so config.ts keeps its default
      // rather than passing an empty string down to the SDK.
      return { ok: true, value: s === "" ? undefined : s };
    }

    case "text": {
      const s = String(raw ?? "").trim();
      if (s.length === 0) return { ok: false, error: `${field.path}: cannot be empty` };
      return { ok: true, value: s };
    }
  }
}
