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

/**
 * "prompt" is "text" that spans many lines: same validation, a textarea instead
 * of a one-line box. Separate rather than a flag on "text" because the two
 * differ in what a value even is — a host or a bucket name is a token with no
 * interior whitespace, a prompt is prose whose line breaks are load-bearing.
 */
export type SettingType = "enum" | "int" | "bool" | "text" | "prompt";

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
  /**
   * Path of a boolean setting that switches this one on. When that setting is
   * off, this one is greyed out — a folder box you can still type into while the
   * feature is disabled invites you to configure something that won't happen.
   * Still validated normally, so the value survives being toggled off and on.
   */
  dependsOn?: string;
  /**
   * A blank value is meaningful for this "text" field — it means "unset", and
   * the code derives or refuses accordingly. Without this, blank is an error,
   * which is right for a field like a folder path but wrong for one whose whole
   * default is "work it out from something else".
   */
  optional?: boolean;
  /** Shown under the field as a worked example of the expected format. */
  placeholder?: string;
}

export const SETTING_FIELDS: readonly SettingField[] = [
  // ── Institution ─────────────────────────────────────────────────────────
  // First, deliberately: nothing on the Panopto path works until this is set,
  // and it is the one value no default can guess.
  {
    path: "panopto.baseUrl",
    label: "Panopto site",
    group: "Institution",
    type: "text",
    optional: true,
    placeholder: "https://yourschool.hosted.panopto.com",
    help: "Scheme and host only, no trailing slash — the start of the address you see when watching a recording.",
  },

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

  // ── Google Cloud ────────────────────────────────────────────────────────
  // Only consulted when a stage's backend is "api"; the browser path never
  // touches any of it.
  {
    path: "vertex.project",
    label: "Project ID",
    group: "Google Cloud",
    type: "text",
    optional: true,
    placeholder: "my-project-123456",
    help: "Needed only by the api backend. Leave blank if you only use the browser backend.",
  },
  {
    path: "vertex.gcsBucket",
    label: "Storage bucket",
    group: "Google Cloud",
    type: "text",
    optional: true,
    placeholder: "derived: uninotes-<project>",
    help: "Where video chunks are staged for Vertex to read. Blank derives a name from the project and creates it on first use.",
  },
  {
    path: "vertex.bucketLocation",
    label: "Bucket region",
    group: "Google Cloud",
    type: "text",
    placeholder: "us-central1",
    help: "A real Cloud Storage region — unlike Vertex, GCS rejects \"global\".",
  },
  {
    path: "vertex.cleanupUploads",
    label: "Delete chunks after use",
    group: "Google Cloud",
    type: "bool",
    help: "Turn off only to debug what was actually uploaded — chunks are large.",
  },
  {
    path: "vertex.generation.notes.thinkingLevel",
    label: "Thinking (notes)",
    group: "Models",
    type: "enum",
    options: ["", "minimal", "low", "medium", "high"],
    help: "Blank = model default. Lower trims latency at some comprehension cost.",
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
    help: "Max wait for one Gemini answer. Long lectures generate tens of thousands of characters — a 29k-char response took just over 4 minutes.",
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

  // ── Prompts ─────────────────────────────────────────────────────────────
  // Only the parts no code parses. The timestamp contract and the
  // ---JSON-ACTIONS--- block stay in src/gemini/prompts.ts: an edit to either
  // wouldn't fail, it would quietly yield wrong timestamps or no action items.
  {
    path: "prompts.grounding",
    label: "Grounding rules",
    group: "Prompts",
    type: "prompt",
    caution:
      "This is what keeps notes tied to the recording. Asked about a named course with nothing to go on, the model writes a plausible syllabus instead of reporting that it saw nothing.",
    help: "Opens every notes prompt, before the lecture title and part number. Default: prompts/notes-grounding.txt.",
  },
  {
    path: "prompts.coverage",
    label: "What to cover",
    group: "Prompts",
    type: "prompt",
    help:
      "What the notes should contain and in what style, shared by the single-video, middle-part and final-part prompts. " +
      "The timestamp rules and the structured-data block are appended after this automatically. Default: prompts/notes-coverage.txt.",
  },
  {
    path: "prompts.prettyRules",
    label: "Prettifier rules",
    group: "Prompts",
    type: "prompt",
    help:
      "Applied to finished raw notes to produce lecture.pretty.md. Safe to rewrite wholesale — nothing downstream parses the result. " +
      "The YAML frontmatter is re-attached by code, so a rule about preserving it is redundant. Default: prompts/pretty-notes.txt.",
  },

  // ── Second copy ─────────────────────────────────────────────────────────
  {
    path: "workspace.enabled",
    label: "Keep a second copy",
    group: "Second copy",
    type: "bool",
    help: "Copies each pretty note into another folder as it's written.",
  },
  {
    path: "workspace.root",
    label: "Folder",
    group: "Second copy",
    type: "text",
    dependsOn: "workspace.enabled",
    help: "Copies land in <Course>/Unsorted Lectures/. A failure here never fails the lecture.",
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

    case "prompt": {
      // Normalise the line endings a textarea submits, so a prompt edited on
      // Windows doesn't differ from its file default by \r on every line and
      // read as "changed from default" when nothing was changed.
      const s = String(raw ?? "").replace(/\r\n/g, "\n").trim();
      if (s.length === 0) return { ok: false, error: `${field.path}: cannot be empty` };
      // Generous, but not unbounded: settings.json is read at the start of every
      // command, and a runaway paste shouldn't be carried into every prompt.
      if (s.length > 20_000) {
        return { ok: false, error: `${field.path}: too long (${s.length} characters, limit 20000)` };
      }
      return { ok: true, value: s };
    }

    case "text": {
      const s = String(raw ?? "").trim();
      if (s.length === 0) {
        // Blank is a legitimate "unset" for an optional field — the code that
        // reads it derives a value or reports a clear error. Kept as "" rather
        // than undefined so it matches the empty default exactly, which is what
        // lets the panel drop the override instead of recording a no-op.
        if (field.optional) return { ok: true, value: "" };
        return { ok: false, error: `${field.path}: cannot be empty` };
      }
      return { ok: true, value: s };
    }
  }
}
