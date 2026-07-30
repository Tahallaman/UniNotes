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
 * Imports only src/notes/organise.ts, which itself imports nothing but node:path
 * — so config.ts loading this still can't produce a cycle.
 */

import type { Term } from "../notes/organise.js";
import { validateTerms } from "../notes/organise.js";

/**
 * "prompt" is "text" that spans many lines: same validation, a textarea instead
 * of a one-line box. Separate rather than a flag on "text" because the two
 * differ in what a value even is — a host or a bucket name is a token with no
 * interior whitespace, a prompt is prose whose line breaks are load-bearing.
 *
 * "terms" is the one field whose value isn't a scalar. It gets a bespoke editor
 * and a bespoke validator rather than a second config file, so that everything
 * else settings.json gives us — one place to reset, one record of what you've
 * changed from default — keeps working for it too.
 */
export type SettingType = "enum" | "int" | "bool" | "text" | "prompt" | "terms";

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
    help: "Where video chunks are staged. Blank derives one from the project and creates it on first use.",
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
    help: "Max wait for one Gemini answer. A 29k-character reply took just over four minutes.",
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

  // ── Player ──────────────────────────────────────────────────────────────
  {
    path: "player.keep",
    label: "Keep the video after processing",
    group: "Player",
    type: "bool",
    caution:
      "A full run then holds every recording — a gigabyte or two each — until you close the panel.",
    help: "Off, a video is deleted once its notes are written and you fetch it back to watch. The cache empties when UniNotes starts and stops either way.",
  },
  {
    path: "player.sync",
    label: "Sync the notes to the video",
    group: "Player",
    type: "bool",
    help: "The notes highlight as the lecture plays, and clicking one jumps there. The Synced button toggles it too.",
  },
  {
    path: "player.subtitles",
    label: "Show subtitles on the video",
    group: "Player",
    type: "bool",
    help: "Panopto's transcript over the video. Also on the Subtitles button. Needs a fetched transcript.",
  },
  {
    path: "player.subtitleSize",
    label: "Subtitle size (%)",
    group: "Player",
    type: "int",
    min: 12,
    max: 100,
    help: "Share of the size a browser draws captions at. Also on the A− / A+ buttons.",
  },
  {
    path: "player.notesSide",
    label: "Notes side",
    group: "Player",
    type: "enum",
    options: ["right", "left"],
    help: "Which side of the video the notes sit on while you watch.",
  },
  {
    path: "player.notesWidth",
    label: "Notes column width (px)",
    group: "Player",
    type: "int",
    min: 0,
    max: 6000,
    help: "0 sizes it automatically. Dragging the divider writes this; double-clicking it puts back 0.",
  },
  {
    path: "player.seekLeadIn",
    label: "Jump lead-in (seconds)",
    group: "Player",
    type: "int",
    min: 0,
    max: 30,
    help: "Clicking a note lands this far before its timestamp, so you hear the run-up.",
  },
  {
    path: "player.skipSeconds",
    label: "Arrow key skip (seconds)",
    group: "Player",
    type: "int",
    min: 1,
    max: 120,
    help: "How far ← and → move the video while you're watching.",
  },
  {
    path: "player.watchedAt",
    label: "Counts as watched at (%)",
    group: "Player",
    type: "int",
    min: 50,
    max: 100,
    help: "Getting this far through ticks the Watched box for you. 100 waits for the very end.",
  },

  // ── Explain ─────────────────────────────────────────────────────────────
  {
    path: "explain.enabled",
    label: "Ask about the lecture while you watch",
    group: "Explain",
    type: "bool",
    caution:
      "Sends your notes, and the transcript if you have one, to Google. Each answer says what went with it.",
    help: "Adds an Explain button to the player and to any passage you highlight. Needs a Google Cloud project — it calls Vertex directly.",
  },
  {
    path: "explain.contextChars",
    label: "Surrounding notes to send",
    group: "Explain",
    type: "int",
    min: 400,
    max: 20_000,
    slider: true,
    dependsOn: "explain.enabled",
    help: "Roughly how much of the notes around your question to send. The section before it always comes too.",
  },
  {
    path: "explain.include.pretty",
    label: "Send the pretty notes",
    group: "Explain",
    type: "bool",
    dependsOn: "explain.enabled",
    help: "The tidied notes. On unless you have a reason.",
  },
  {
    path: "explain.include.raw",
    label: "Send the raw notes",
    group: "Explain",
    type: "bool",
    dependsOn: "explain.enabled",
    help: "Occasionally has detail the prettifier dropped; usually just doubles the size.",
  },
  {
    path: "explain.include.subtitles",
    label: "Send the transcript",
    group: "Explain",
    type: "bool",
    dependsOn: "explain.enabled",
    help: "The lecturer's own words, not a model's summary of them. Needs a fetched transcript.",
  },
  {
    path: "explain.subtitleLines",
    label: "Transcript lines to send",
    group: "Explain",
    type: "int",
    min: 1,
    max: 60,
    dependsOn: "explain.enabled",
    help: "How far back the transcript window reaches, counted in subtitle cues.",
  },
  {
    path: "explain.model",
    label: "Model",
    group: "Explain",
    type: "text",
    dependsOn: "explain.enabled",
    help: "Flash by default: the answer is short and you're sat there waiting for it.",
  },
  {
    path: "explain.thinkingLevel",
    label: "Thinking",
    group: "Explain",
    type: "enum",
    options: ["", "minimal", "low", "medium", "high"],
    dependsOn: "explain.enabled",
    help: "Blank = model default. Minimal keeps the answer quick.",
  },
  {
    path: "explain.maxOutputTokens",
    label: "Answer length (tokens)",
    group: "Explain",
    type: "int",
    min: 256,
    max: 65_536,
    dependsOn: "explain.enabled",
    help: "Raise it if answers keep getting cut off. Thinking tokens come out of this budget too.",
  },
  {
    path: "explain.maxContextChars",
    label: "Context ceiling (characters)",
    group: "Explain",
    type: "int",
    min: 1_000,
    max: 200_000,
    dependsOn: "explain.enabled",
    help: "A hard cap on what one question can send, trimmed from the oldest end. A backstop, not a dial.",
  },
  {
    path: "explain.dockHeight",
    label: "Explain panel height (px)",
    group: "Explain",
    type: "int",
    min: 0,
    max: 4000,
    dependsOn: "explain.enabled",
    help: "0 gives it about a third of the video pane. Dragging the top edge of the panel writes this for you.",
  },
  {
    path: "explain.timeoutSeconds",
    label: "Give up after (seconds)",
    group: "Explain",
    type: "int",
    min: 10,
    max: 600,
    dependsOn: "explain.enabled",
    help: "There's no Cancel button behind this, so a hung call needs its own deadline.",
  },

  // ── Browser ─────────────────────────────────────────────────────────────
  {
    path: "browser.headless",
    label: "Headless",
    group: "Browser",
    type: "bool",
    help: "Google blocks headless sign-in; an authenticated profile may work. Run the browser probe first.",
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
    help: "Gap between starting one Gemini tab and the next. Raise it if Google serves an \"unusual traffic\" check.",
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
      "This is what keeps notes tied to the recording. Without it the model writes a plausible syllabus from the course name.",
    help: "Opens every notes prompt, before the lecture title and part number. Default: prompts/notes-grounding.txt.",
  },
  {
    path: "prompts.coverage",
    label: "What to cover",
    group: "Prompts",
    type: "prompt",
    help: "What the notes should contain and in what style. Timestamp rules and the data block are appended automatically. Default: prompts/notes-coverage.txt.",
  },
  {
    path: "prompts.explain",
    label: "Explain rules",
    group: "Prompts",
    type: "prompt",
    help: "The tone and length of an answer. The lecture material is appended automatically. Default: prompts/explain.txt.",
  },
  {
    path: "prompts.prettyRules",
    label: "Prettifier rules",
    group: "Prompts",
    type: "prompt",
    help: "Applied to raw notes to produce lecture.pretty.md. Safe to rewrite wholesale. Default: prompts/pretty-notes.txt.",
  },

  // ── Terms & weeks ───────────────────────────────────────────────────────
  {
    path: "terms.enabled",
    label: "Sort into weeks",
    group: "Terms & weeks",
    type: "bool",
    help: "Works out each lecture's teaching week from its date. Off drops the week from folders and names.",
  },
  {
    path: "terms.list",
    label: "Terms",
    group: "Terms & weeks",
    type: "terms",
    dependsOn: "terms.enabled",
    help: "Whatever your year is divided into. Week 1 starts on the start date; leave Folder blank for the term you're in.",
  },

  // ── Naming ──────────────────────────────────────────────────────────────
  {
    path: "naming.fileTemplate",
    label: "File name",
    group: "Naming",
    type: "text",
    help:
      "Tokens: {course} {title} {rawTitle} {date} {week} {week2} {number} {number2} {term} {termLabel} {year}. " +
      "Anything unresolved drops out with the punctuation around it.",
  },
  {
    path: "exports.folderTemplate",
    label: "Exports folders",
    group: "Naming",
    type: "text",
    help: "Below Exports/Raw/ and Exports/Pretty/. Add /Week {week} to sort those into weeks too.",
  },
  {
    path: "exports.fileTemplate",
    label: "Exports file name",
    group: "Naming",
    type: "text",
    optional: true,
    placeholder: "same as File name above",
    help: "Blank uses the file name template above.",
  },

  // ── Second copy ─────────────────────────────────────────────────────────
  {
    path: "workspace.enabled",
    label: "Keep a second copy",
    group: "Second copy",
    type: "bool",
    help: "Copies each pretty note into another folder — the one you actually study from.",
  },
  {
    path: "workspace.root",
    label: "Folder",
    group: "Second copy",
    type: "text",
    dependsOn: "workspace.enabled",
    help: "A failure here never fails the lecture.",
  },
  {
    path: "workspace.folderTemplate",
    label: "Folders",
    group: "Second copy",
    type: "text",
    dependsOn: "workspace.enabled",
    help: "A folder whose tokens can't be filled is left out, so an undated lecture lands beside the week folders.",
  },
  {
    path: "workspace.fileTemplate",
    label: "File name",
    group: "Second copy",
    type: "text",
    dependsOn: "workspace.enabled",
    optional: true,
    placeholder: "same as Naming → File name",
    help: "Blank uses the file name template from Naming.",
  },
  {
    path: "workspace.syncOnWrite",
    label: "Copy as notes are written",
    group: "Second copy",
    type: "bool",
    dependsOn: "workspace.enabled",
    help: "Off waits for you to run Copy to University folder from the Run tab.",
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

    case "terms": {
      if (raw === undefined || raw === null) return { ok: true, value: [] };
      if (!Array.isArray(raw)) return { ok: false, error: `${field.path}: expected a list of terms` };

      const terms: Term[] = [];
      for (const [index, entry] of raw.entries()) {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          return { ok: false, error: `${field.path}: entry ${index + 1} is not a term` };
        }
        const t = entry as Record<string, unknown>;
        const breakRaw = t.break as Record<string, unknown> | null | undefined;

        terms.push({
          // Generated rather than trusted: the id only has to be unique within
          // the list, and an id from a hand-edited file could collide.
          id: typeof t.id === "string" && t.id.trim().length > 0 ? t.id.trim() : `term-${index + 1}`,
          label: String(t.label ?? "").trim(),
          folder: String(t.folder ?? "").trim(),
          start: String(t.start ?? "").trim(),
          weeks: Math.round(Number(t.weeks ?? 12)),
          break:
            breakRaw && typeof breakRaw === "object"
              ? {
                  afterWeek: Math.round(Number(breakRaw.afterWeek ?? 0)),
                  weeks: Math.round(Number(breakRaw.weeks ?? 0)),
                }
              : null,
        });
      }

      const duplicates = terms.map((t) => t.id).filter((id, i, all) => all.indexOf(id) !== i);
      if (duplicates.length > 0) {
        return { ok: false, error: `${field.path}: duplicate term id "${duplicates[0]}"` };
      }

      // The same validator the editor shows inline, run again here because
      // settings.json is hand-editable and an overlapping pair would otherwise
      // file lectures into whichever term happened to be listed first.
      const problems = validateTerms(terms);
      if (problems.length > 0) {
        const named = problems.map((p) => {
          const term = terms.find((t) => t.id === p.termId);
          return `${term?.label || p.termId}: ${p.message}`;
        });
        return { ok: false, error: `${field.path}: ${named.join("; ")}` };
      }

      return { ok: true, value: terms };
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
