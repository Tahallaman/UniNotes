import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyUserSettings } from "./src/settings/overlay.js";
import type { Term } from "./src/notes/organise.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * A prompt default that lives in prompts/ rather than inline.
 *
 * Long prose is far more reviewable as a text file than as an escaped template
 * literal, and editing it there still works exactly as it did before this became
 * a setting — the file is the default, and settings.json overrides it.
 *
 * Never throws: config.ts is imported by every command, so a missing prompt file
 * must not stop a scan or a download. The stage that needs the text reports the
 * blank itself, by name.
 */
function promptFile(name: string): string {
  try {
    return fs.readFileSync(path.join(__dirname, "prompts", name), "utf-8").trim();
  } catch {
    return "";
  }
}

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
    /**
     * Fragment value that selects table view, the only view showing a Date
     * column. Configurable because it's an undocumented internal — if a Panopto
     * update renumbers the views, this is a one-line fix rather than a release.
     */
    tableViewId: 0,
    /**
     * Caption language slots to try, in order, taking the first that has any.
     *
     * Panopto's viewer itself asks for 0 then 1; which one is populated is a
     * property of the recording, not the tenant, so both are tried rather than
     * one being hardcoded. Add more slots here if your institution publishes
     * additional languages.
     */
    captionLanguages: [0, 1] as number[],
    /** Max scroll attempts to load infinite-scroll items */
    maxScrolls: 3,
    /** Delay between scrolls (ms) */
    scrollDelay: 2000,
    /** Timeout for page navigation (ms) */
    navigationTimeout: 50_000,
  },

  /** Video splitting — max segment duration in seconds (e.g. 900 = 15 min) */
  segmentSeconds: 900,

  /**
   * The player in the control panel, and what it needs to exist.
   *
   * Panopto cannot supply the video here. Its pages send
   * `frame-ancestors 'self' https:`, so they refuse to embed in a page served
   * over http://127.0.0.1, and the embed API only offers a polled current time
   * even where it does load. So the player reads the file next to the notes,
   * which also means exact seeking and no dependency on being online.
   *
   * Nothing accumulates: a kept recording goes to `paths.videoCache` under
   * temp/, which is emptied when UniNotes starts and again when it stops. Notes
   * are permanent, videos are not.
   *
   * `keep` is still off by default. Fetching one back from the library takes
   * seconds, whereas a full pipeline run with it on holds every lecture's video
   * until you close the panel — which is tens of gigabytes for the sake of a
   * wait you probably weren't going to notice.
   */
  player: {
    /** Cache the downloaded video for the player instead of deleting it. */
    keep: false as boolean,
    /**
     * Tie the notes to the video at all.
     *
     * Off, the player is a video beside the notes and nothing more: no
     * highlighting, no self-scrolling, and a click in the notes is a click
     * rather than a seek. On by default — it's the point of the thing — but it
     * is an opinion about how you read, and sometimes you only want to read.
     */
    sync: true as boolean,
    /**
     * Show Panopto's transcript as subtitles over the video.
     *
     * Off by default: with the notes beside the video and the transcript on its
     * own tab, burning a third copy of the words over the slides is usually one
     * too many. On when you want it — a mumbled lecture, or a lecturer you're
     * still tuning your ear to.
     */
    subtitles: false as boolean,
    /**
     * Subtitle text size, as a percentage of the size a browser draws captions.
     *
     * Measured against the picture's height rather than fixed in pixels, so it
     * survives dragging the divider and going full screen. 100 is about what a
     * browser draws unaided, which is sized for a phone held at arm's length —
     * on a player sharing a window with the notes that swallows the bottom third
     * of the slide, where lecturers put the thing they're pointing at, so the
     * default here is well under half of it.
     */
    subtitleSize: 31,
    /** Which side of the video the notes sit on. */
    notesSide: "right" as "left" | "right",
    /**
     * Width of the notes column in pixels, or 0 to fit it to the notes.
     *
     * 0 is the default and the better answer: the column becomes exactly as wide
     * as the reading measure the notes are already laid out to, and the video
     * takes the rest. A number here is what dragging the divider records.
     */
    notesWidth: 0,
    /**
     * Seconds to rewind when jumping to a note.
     *
     * A timestamp marks where a point was *made*, so landing exactly on it puts
     * you a beat after the sentence that set it up. A couple of seconds back is
     * almost always where you actually wanted to be.
     */
    seekLeadIn: 2,
    /**
     * Seconds the ← and → keys move the video by.
     *
     * 15 because that is what a lecture asks for: the thing you missed is a
     * sentence or two back, and the browser's own 5 seconds means pressing the
     * key four times to get there. Configurable because it depends on how fast
     * the lecturer talks — 10 for a dense one, 30 for a slow one.
     */
    skipSeconds: 15,
    /**
     * How far through a recording counts as having watched it, as a percentage.
     *
     * A lecture is over before the video is: the last minutes are questions, a
     * reminder about the assignment, and the lecturer packing up. Waiting for
     * the final second before the box ticks itself means it never ticks, so the
     * Library ends up maintained by hand — which is the thing this is for.
     *
     * 100 effectively turns the automatic tick off: only playing to the very end
     * counts, and the "in progress" dash carries the information instead.
     */
    watchedAt: 90,
  },

  /**
   * Skip recordings that contain nothing, before they cost a pipeline run.
   *
   * A recording that was started and never used costs a download, a split, one
   * Gemini call per part and a prettify — and an empty video is precisely when
   * the model invents content to fill the silence rather than reporting that
   * there was none.
   *
   * "Blank" means visually dead AND silent, never either alone: a lecturer
   * talking over one unchanging slide is a good lecture with a frozen picture,
   * and an audio-only recording is worth just as much as a visual one.
   *
   * Applied per SEGMENT, not per lecture. A recording that starts late is blank
   * for its first two or three segments and fine afterwards, so a whole-lecture
   * verdict would either skip a real lecture or pay for its empty parts.
   */
  blankDetection: {
    /** Turn the check off entirely; every lecture then processes as before. */
    enabled: true as boolean,
    /**
     * Visual probes: short windows sampled across the file, rather than decoding
     * all of it. Sampling is fine for "does the picture move" — unlike audio,
     * where a sampled statistic would miss a lecture that starts late.
     */
    probeCount: 8,
    /** Length of each visual probe, in seconds. */
    probeSeconds: 4,
    /**
     * Fraction of a probe that must be black or frozen for the probe to count as
     * dead. Below 1.0 because the filters report slightly less than the full
     * window at the edges of a run.
     */
    coverage: 0.9,
    /** blackdetect pix_th — how dark counts as black. */
    blackPixelThreshold: 0.1,
    /** freezedetect noise floor (dB). Louder = more tolerant of compression noise. */
    freezeNoiseDb: -60,
    /**
     * Length of each audio chunk, in seconds.
     *
     * Long enough that one door closing barely moves a chunk's mean, short
     * enough that a lecture starting late still fills a chunk of its own. The
     * audio scan is contiguous, so no part of a segment goes unmeasured
     * whatever this is set to — it only trades robustness against resolution.
     */
    audioChunkSeconds: 30,
    /**
     * Level (dBFS) above which a chunk counts as someone speaking.
     *
     * Compared against the LOUDEST chunk in the segment, so this answers "was
     * anyone ever speaking here" — a lecture that starts thirteen minutes into a
     * segment still clears it, where any average over the segment would be
     * dragged under by the dead majority and throw the lecture away.
     *
     * silencedetect cannot do this job: a hall with the mic never switched on
     * measures about -47dB, above any sane silence floor, so it reports no
     * silence at all and a dead recording looks like it has audio. That is how
     * COMPSYS 730's 21 Jul recording got uploaded in full.
     *
     * Measured on two real recordings — a dead one whose loudest 30s chunk was
     * -40dB, and a live one whose loudest was -24dB. This sits between them,
     * nearer the dead end so the doubt falls on the side of processing. Raising
     * it toward -25 skips more; lowering it toward -45 skips less. Every check
     * logs the level it measured, so a recording that lands on the wrong side
     * tells you which way to move this and by how much.
     */
    speechFloorDb: -34,
  },

  /** Gemini settings */
  gemini: {
    url: "https://gemini.google.com/app",
    /** Model to select when opening a new Gemini chat (as it appears in the model picker) */
    model: "3.6 Flash",
    /** How often to poll for response completion (ms) */
    pollInterval: 5_000,
    /** Number of consecutive unchanged polls before considering response complete */
    stabilityChecks: 3,
    /**
     * Overall timeout for one Gemini response (ms).
     *
     * Was 5 minutes, which a real prettify run came within a minute of: a
     * 29,000-character answer took 4m06s, and that was a single-part lecture.
     * A full lecture's raw notes are several times longer, so 5 minutes was a
     * failure waiting to happen — and an expensive one, since exceeding it
     * aborts the response entirely rather than keeping what streamed in.
     *
     * Sized at roughly 2.5× the longest observed generation. Raising it costs
     * nothing on a healthy run; it only lengthens how long a genuinely stuck
     * tab takes to give up — and that multiplies by retry.maxRetries.
     */
    responseTimeout: 10 * 60_000,
    /** Timeout for video upload + Gemini processing confirmation (ms) */
    uploadTimeout: 30 * 60_000,
  },

  /**
   * The editable halves of the prompts, defaulting to the files in prompts/.
   *
   * Only the parts that are safe to rewrite are here. Two pieces of every notes
   * prompt are deliberately NOT settings and stay in src/gemini/prompts.ts:
   *
   *   - the timestamp contract, because src/utils/timestamps.ts rebases what it
   *     produces, and
   *   - the ---JSON-ACTIONS--- block, because src/notes/parser.ts reads it.
   *
   * Both are parsed by code. A prompt edit that broke either would not fail — it
   * would quietly produce notes with wrong timestamps or no action items, which
   * is the worst kind of thing to leave one text box away.
   */
  prompts: {
    /**
     * Prepended to every notes prompt. This is the anti-invention instruction:
     * it is what makes the model describe the recording rather than recite what
     * it already knows about the topic, which for a named course it can do
     * fluently and wrongly.
     */
    grounding: promptFile("notes-grounding.txt"),
    /**
     * What the notes should contain, and in what style. The framing around it
     * ("this is part 3 of 8 of ...") is built per-variant in code, so this text
     * is shared by the single-video, middle-part and final-part prompts.
     */
    coverage: promptFile("notes-coverage.txt"),
    /**
     * The prettifier's rules, applied to finished raw notes. Nothing downstream
     * parses the result beyond the YAML frontmatter, which the prettifier
     * re-attaches itself — so this one is safe to rewrite wholesale.
     */
    prettyRules: promptFile("pretty-notes.txt"),
    /**
     * How "Explain this" should answer. Nothing parses the reply — it is rendered
     * as markdown into the dock and then forgotten — so this one is entirely
     * yours. The lecture material it answers from is assembled separately and
     * appended by src/gui/explain.ts.
     */
    explain: promptFile("explain.txt"),
    /**
     * How the highlights are chosen. This one *is* parsed — src/gui/highlights.ts
     * reads back a JSON array of spans — so the output section at the end of it
     * is load-bearing in a way the rest of the file isn't. Everything above that
     * (what counts as worth watching, how to score it) is the part worth tuning,
     * and it is where the quality of the whole feature lives.
     */
    highlights: promptFile("highlights.txt"),
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
    /**
     * Recordings held only so the player has something to play.
     *
     * Its own folder under temp/ rather than temp/ itself, because the sweep
     * that empties it on start and shutdown must not be able to reach split
     * parts, checkpoints or the lock file sitting alongside.
     */
    videoCache: path.join(__dirname, "temp", "video-cache"),
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
    /**
     * Defaults to the layout a student keeps by hand: the course, the teaching
     * week, and a Lectures folder beside Slides. {term} is blank for the term
     * you're in — that segment then disappears, leaving current courses at the
     * root and archived ones under whatever folder their term names.
     */
    folderTemplate: "{term}/{course}/Week {week}/Lectures",
    /** Blank inherits naming.fileTemplate. */
    fileTemplate: "" as string,
    /**
     * Copy each pretty note the moment it's written, rather than only when you
     * run the sync job. Separate from `enabled` so the second copy can stay
     * configured while you batch it up.
     */
    syncOnWrite: true as boolean,
  },

  /**
   * Teaching terms, and the weeks derived from them.
   *
   * Deliberately not "semesters": the same arithmetic serves trimesters,
   * quarters and summer school, and a tool that names the concept after one
   * institution's calendar is a tool half its users have to fight. A term is a
   * start date, a number of teaching weeks, and optionally a break — nothing
   * about it assumes how many of them a year holds.
   */
  terms: {
    /**
     * Off means no week folders anywhere and no terms to configure. Naming still
     * applies — the two features are independent.
     */
    enabled: true as boolean,
    list: [] as Term[],
  },

  /**
   * How a note is named, wherever it's written.
   *
   * Templates rather than a fixed convention, because "tidy" is not one thing:
   * the {week} token exists for people who want it in the filename, and is
   * deliberately absent from the default for the many who don't.
   */
  naming: {
    fileTemplate: "{course} - {title} - {date}",
  },

  /**
   * Exports/ — the local copy, independent of the workspace folder above.
   *
   * Flat per course by default, matching what's already there. Week folders are
   * one template edit away for anyone who wants them here too.
   */
  exports: {
    folderTemplate: "{course}",
    /**
     * Leads with the lecture number, unlike the default elsewhere.
     *
     * A course folder here holds a whole semester, flat, and is read in an
     * alphabetical file list — so the order the list comes out in is the only
     * order you get. Panopto titles put the number wherever the department felt
     * like it, or leave it out, which sorts a semester by nothing in
     * particular. `{number2}` is padded so lecture 10 doesn't file between 1
     * and 2.
     *
     * The second copy deliberately doesn't do this: its notes sit a handful to
     * a Week folder, where sorting is not the problem being solved.
     *
     * Blank inherits naming.fileTemplate.
     */
    fileTemplate: "Lecture {number2} - {course} - {title}" as string,
  },

  /**
   * "Explain this" — the question you ask the lecture while you're watching it.
   *
   * Vertex only, and not because of a preference. The `browser` provider drives a
   * real Gemini web session through Playwright: one tab, one PID lock, minutes per
   * answer. That is a fine way to process a lecture overnight and a hopeless way
   * to answer a question while you are sat paused at 14:32. With no Cloud project
   * configured the button says so rather than appearing and failing.
   *
   * Everything sent is assembled server-side from the lecture you have open, so
   * the size of what leaves the machine is bounded by these settings and not by
   * what a page happened to ask for.
   */
  explain: {
    enabled: true as boolean,
    /** Flash by default: the answer is short and the latency is the point. */
    model: "gemini-3.6-flash",
    /**
     * Minimal by default for the same reason. A definition does not need to be
     * reasoned about for twenty seconds, and you are sat there waiting for it.
     */
    thinkingLevel: "minimal" as "minimal" | "low" | "medium" | "high" | undefined,
    /** Short answers. Raise it if you keep getting cut off mid-explanation. */
    maxOutputTokens: 4_096,
    /**
     * Roughly how much of the notes around a question to send, in characters.
     *
     * Not a choice between "this section" and "the whole file". Sections are not
     * a uniform size — one is a page on branch prediction, the next is two
     * bullets about a drop-in clinic — so "the section you're in" is sometimes
     * four lines, and a model given four lines correctly reports that it hasn't
     * been told enough. This is the amount that has to be reached before the
     * slice stops growing outwards; it rounds up to whole sections, never cutting
     * one mid-sentence.
     *
     * The whole document is deliberately not a setting. Sending 25 KB with every
     * question is slow, dear, and buries what you asked about among everything
     * you didn't — so it is a button in the panel, for the one question that
     * needs it, and it sends once.
     */
    contextChars: 1_400,
    /** Which copies of the lecture go in. */
    include: {
      pretty: true as boolean,
      raw: false as boolean,
      /** Panopto's transcript — the lecturer's actual words, when there is one. */
      subtitles: true as boolean,
    },
    /** How far back the transcript window reaches, in cues. */
    subtitleLines: 8,
    /**
     * Hard ceiling on the assembled context, in characters.
     *
     * A backstop rather than a dial: "document" scope on a long lecture, or a
     * pathological notes file, must not turn one click into a very large bill.
     */
    maxContextChars: 24_000,
    /** Seconds before a hung call is given up on. There is no Cancel behind it. */
    timeoutSeconds: 90,
    /**
     * Height of the dock under the video in pixels, or 0 for a sensible share.
     * What dragging its top edge records, the same way player.notesWidth is.
     */
    dockHeight: 0,
  },

  /**
   * Highlights — the lecture cut down to the parts worth watching.
   *
   * One model call reads the transcript and the raw notes and returns every span
   * worth watching, each scored 1–5. What you then watch is chosen from those
   * candidates locally, by preset, which is why switching between Skim and Deep
   * costs nothing: the expensive judgement (what is worth watching) is separated
   * from the cheap one (how long have I got), and only the first goes to a model.
   *
   * The result is written beside the lecture's notes. That is load-bearing, not
   * an optimisation: the transcript it was built from lives in the video cache,
   * which is emptied every time the panel starts and stops, so an unsaved reel
   * would die with the session that made it.
   */
  highlights: {
    enabled: true as boolean,
    /** Same model as everything else here; the thinking level is what differs. */
    model: "gemini-3.6-flash",
    /**
     * High, unlike Explain's minimal — and for the opposite reason.
     *
     * This is a judgement call over a whole lecture, made once, whose output you
     * will trust enough to skip forty minutes on. Explain is minimal because you
     * are sitting there waiting for a definition; nobody is sitting waiting for
     * this, because it runs in the background while you carry on watching.
     */
    thinkingLevel: "high" as "minimal" | "low" | "medium" | "high" | undefined,
    /** Twenty-odd spans of JSON. Generous — an exhausted budget returns nothing. */
    maxOutputTokens: 16_384,
    /** Minutes, not seconds: thinking hard about an hour of transcript is slow. */
    timeoutSeconds: 300,
    /**
     * The three presets, as an importance floor and a share of the lecture.
     *
     * Two rules rather than one, and the pairing is the point. The **share**
     * adapts where a fixed number of minutes cannot — ten minutes is most of a
     * 25-minute lab and nothing of a two-hour lecture. The **floor** is what
     * stops a preset padding itself out to fill its share: a lecture that was
     * mostly admin yields a two-minute Deep, because there were only two
     * minutes' worth in it.
     *
     * So the share is a ceiling, never a quota. Nothing is included to reach it.
     *
     * Shares are percentages rather than fractions so that each one is a plain
     * integer in Settings; a text box holding 0.25 is a text box someone will
     * eventually type 25 into.
     */
    presets: {
      skim: { minWeight: 5, share: 10 },
      highlights: { minWeight: 4, share: 25 },
      deep: { minWeight: 3, share: 45 },
    },
    /** Shorter than this isn't a span, it's a jump cut. Applied after snapping. */
    minSegmentSeconds: 30,
    /**
     * Seconds of run-up before a span starts.
     *
     * The same reasoning as the player's own seek lead-in: a boundary that lands
     * exactly on the first word puts you a beat after the sentence that set it
     * up. Snapped back to a real cue boundary afterwards, so it never cuts into
     * a word.
     */
    leadInSeconds: 3,
    /**
     * Transcript cues are merged into blocks of at least this many seconds
     * before being sent.
     *
     * An auto-transcript breaks on breath — a cue every two or three seconds —
     * so a lecture arrives as a thousand fragments, which is both expensive and
     * harder to read than the same words in paragraphs. Ten seconds keeps the
     * anchors dense enough to choose boundaries by, and the model's choice is
     * snapped back to a real cue afterwards, so the merge costs no precision.
     */
    blockSeconds: 10,
    /**
     * Hard ceiling on what is assembled and sent, in characters.
     *
     * A backstop rather than a dial. A three-hour recording with a verbose
     * transcript must not turn one press into a very large bill.
     */
    maxContextChars: 300_000,
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
