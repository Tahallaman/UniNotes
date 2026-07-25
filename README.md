# UniNotes

Automated university lecture note pipeline. Polls Panopto for new lecture recordings, downloads them, and generates comprehensive study notes via Google Gemini — both the notes and the polish step.

## How it works

```
Panopto  →  Download  →  Gemini (notes)   →  lecture.raw.md
                      →  Gemini (prettify) →  lecture.pretty.md
                                           →  TODO.md (action items)
```

Each stage independently runs through **either** backend:

| Backend | What it is | Trade-off |
|---|---|---|
| `browser` | Playwright driving gemini.google.com with your logged-in session | Free; slower; needs Edge running |
| `api` | Gemini on Vertex AI via gcloud ADC | Billed; ~10x faster; parallelises cleanly |

Set per stage in `config.ts` under `providers`, or override with `--uploader=` (notes) and `--pretty=` (pretty).

For lectures not on Panopto, drop the video in `Incoming/<CourseCode>/` and run `npm run local` instead.

Everything below is also available as buttons:

```bash
npm run gui     # → http://localhost:4571
```

See [Control panel](#control-panel).

Notes are saved to `Lectures/<CourseCode>/<LectureTitle>/`:
```
Lectures/
  COMPSCI 732/
    [109-B28] COMPSCI 732 L01 - Fri 06 Mar/
      lecture.raw.md      # Gemini-generated notes (source of truth)
      lecture.pretty.md   # reformatted version
      lecture.mp4         # original video (local lectures only)
```

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [ffmpeg](https://ffmpeg.org/) (for splitting long videos) — must be on PATH
- Microsoft Edge (used by Playwright for Panopto and Gemini)
- A University of Auckland Panopto account
- A Google account with Gemini access
- For the `api` backend: a billing-enabled GCP project and `gcloud auth application-default login`

## Verify your setup

Both backends have a probe that fails fast with a clear message instead of surfacing mid-run:

```bash
npm run probe:vertex    # is gemini-3.6-flash reachable? (countTokens + a tiny generate)
npm run probe:browser   # is the profile still signed in? do tabs run in parallel?
```

## Setup

```bash
npm install
```

### Authenticate browsers

Panopto and Gemini each use a persistent Edge profile so you only need to log in once:

```bash
npm run setup-auth:panopto   # opens Edge → log in to Panopto → close window
npm run setup-auth:gemini    # opens Edge → log in to Google → close window
```

Sessions are saved to `browser-data/` (gitignored).

## Control panel

```bash
npm run gui                 # opens http://localhost:4571
npm run gui -- --port=8080  # different port
npm run gui -- --no-open    # don't launch a browser
```

A local web UI over the same pipeline. It is a **launcher, not a second
implementation**: every button spawns the CLI command you would otherwise have
typed, and streams its output live. Nothing in `src/gui/` knows how to process a
lecture. It binds to `127.0.0.1` only.

Four tabs:

| Tab | What's there |
|---|---|
| **Run** | Every pipeline action as a button, each labelled with the live count that decides whether it'll do anything ("3 videos in Incoming/", "5 lectures pending"). Health checks for ffmpeg, both browser sessions, gcloud ADC and the lock. Setup, probes, maintenance. Live console with cancel. |
| **Library** | Every lecture, filterable by course, status and text, plus "missing pretty only". Select any number and process, prettify, reset, ignore or forget them. Click one for details, resume state, links and a rendered preview of its notes. |
| **Settings** | Providers, models, concurrency, timeouts, browser mode — with the ranges and the reasoning attached. |
| **Schedule** | Windows Task Scheduler entries, with presets for once/twice daily and hourly. |

The library is a **union of the database and the disk**, so lecture folders with
no tracking row still appear and can still be prettified and opened.

Settings are saved to `settings.json` and merged over the defaults in `config.ts`
at load. The GUI never rewrites `config.ts` — defaults stay readable and in git,
your overrides are a small gitignored file, and "reset to defaults" is a
deletion. Changes take effect on the next run, since each job is its own process.

Design notes and wireframes: [docs/gui-design.md](docs/gui-design.md).

### Two extra commands the GUI relies on

Both are useful on their own:

```bash
npm run scan     # find new Panopto lectures and record them — no downloads
```

`scripts/process-selected.ts` processes an explicit set of lectures, taking its
selection from a JSON file rather than the command line (lecture titles contain
spaces, commas and dashes, and a selection can be long):

```bash
npx tsx scripts/process-selected.ts --selection=sel.json
npx tsx scripts/process-selected.ts --selection=sel.json --pretty-only
# sel.json:  { "ids": ["<db id>", ...], "dirs": ["<lecture folder>", ...] }
```

## Usage

### Run the full pipeline

```bash
npm run dev
```

Scrapes Panopto for new lectures, downloads them, processes through Gemini, and generates pretty notes. Skips anything already processed.

```bash
npm run dev -- --retry      # also retry lectures that previously errored
```

### Process local videos (non-Panopto lectures)

1. Drop video files into `Incoming/<CourseCode>/`:
   ```
   Incoming/
     SOFTENG 700/
       Lecture 3 - Transformers.mp4
   ```
2. Run:
   ```bash
   npm run local
   npm run local -- --retry  # retry previously errored lectures
   ```

The video is moved to `Lectures/<CourseCode>/<Title>/lecture.mp4` after processing.

### Prettify existing raw notes

Finds every `lecture.raw.md` missing a sibling `lecture.pretty.md` and prettifies it:

```bash
npm run pretty
npm run pretty -- --pretty=browser   # use the web UI instead of Vertex
npm run pretty -- --force            # regenerate even where pretty notes exist
```

The main pipeline runs this same sweep automatically at the end of every run, so a
pretty step that failed last night is retried tonight with no flags needed.

### Export notes

Copies notes into a flat `Exports/` tree for easy sharing or syncing:

```bash
npm run export           # both Raw and Pretty
npm run export -- --raw     # raw only
npm run export -- --pretty  # pretty only
```

Output structure:
```
Exports/
  Raw/<CourseCode>/<LectureTitle>.md
  Pretty/<CourseCode>/<LectureTitle>.md
```

## Vertex AI upload path

By default, videos are uploaded through a Playwright-automated browser session at gemini.google.com. As an alternative, you can process videos through the **Vertex AI API** (Google Cloud) instead, using model `gemini-3.6-flash`. This avoids the browser entirely and is generally faster/more reliable, at the cost of Vertex AI usage charges.

Select the mode with the `--uploader` flag (or the `UNINOTES_UPLOADER` env var):

```bash
npm run dev -- --uploader=api        # Panopto pipeline via Vertex AI
npm run local -- --uploader=api      # local videos via Vertex AI

npm run dev -- --uploader=browser    # explicit browser mode (also the default)
```

Resolution order: `--uploader=api|browser` CLI flag → `UNINOTES_UPLOADER` env var → default `browser`.

### Prerequisites

- A Google Cloud project with the Vertex AI API and Cloud Storage enabled, and billing/credits configured.
- [Application Default Credentials](https://cloud.google.com/docs/authentication/provide-credentials-adc) set up on this machine (`gcloud auth application-default login`) — the API path does not implement its own key handling.
- Permission to create/use a GCS bucket in the target project (video chunks are staged there temporarily so Vertex can read them).

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `UNINOTES_UPLOADER` | `config.ts: providers.notes` | `api` or `browser` for the notes stage |
| `UNINOTES_PRETTY` | `config.ts: providers.pretty` | `api` or `browser` for the pretty stage |
| `GOOGLE_CLOUD_PROJECT` | `config.ts: vertex.project` | GCP project ID used for Vertex AI + GCS |
| `GOOGLE_CLOUD_LOCATION` | `global` | GCP region for Vertex AI + the GCS bucket |
| `UNINOTES_GCS_BUCKET` | `config.ts: vertex.gcsBucket` | Bucket video chunks are uploaded to before calling Gemini |

The bucket is created automatically (uniform access, region-matched) if it doesn't already exist. Uploaded video chunks are deleted from the bucket after each part is processed (controlled by `vertex.cleanupUploads` in `config.ts`, best-effort — failures are logged, not fatal).

## Configuration

All settings are in `config.ts`:

| Setting | Default | Description |
|---|---|---|
| `providers.notes` | `browser` | Backend for video → raw notes |
| `providers.pretty` | `api` | Backend for raw → pretty notes |
| `concurrency.lectures` | 3 | Lectures processed simultaneously |
| `concurrency.parts` | 4 | Parts of one lecture processed simultaneously |
| `concurrency.vertexInFlight` | 8 | Global cap on concurrent Vertex calls |
| `concurrency.gcsUploads` | 3 | Global cap on concurrent GCS uploads |
| `concurrency.browserTabs` | 3 | Global cap on concurrent Gemini tabs |
| `gemini.responseTimeout` | 5 min | Max wait for Gemini to respond |
| `gemini.uploadTimeout` | 30 min | Max wait for video upload (increase for large files) |
| `segmentSeconds` | 900 (15 min) | Videos longer than this are split into segments |
| `retry.maxRetries` | 3 | Retry attempts for download and Gemini failures |
| `browser.headless` | false | Run headless (verify with `npm run probe:browser` first) |
| `browser.windowMode` | `offscreen` | `normal`, `offscreen`, or `hidden` — see below |
| `browser.tabStaggerMs` | 2000 | Gap between starting one Gemini tab and the next (see Reliability) |
| `vertex.model` | `gemini-3.6-flash` | Model for video → notes |
| `vertex.generation.pretty.model` | `gemini-3.6-flash` | Model for prettifying (thinking disabled) |
| `vertex.location` | `global` | 3.x Flash models are only served on `global` |
| `vertex.cleanupUploads` | true | Delete GCS video chunks after each part is processed |
| `workspace.enabled` | true | Keep a second copy of each pretty note in another folder |
| `workspace.root` | OneDrive path | Where that copy goes — `<Course>/Unsorted Lectures/` inside it |

**Setting every `concurrency` value to 1 reproduces the original fully-sequential
behaviour** — the first thing to try when debugging.

### Keeping the browser out of your way

`browser.windowMode` controls how the (still genuinely headed) window is presented:

- `normal` — a visible window
- `offscreen` — parked outside the visible desktop via `--window-position`
- `hidden` — hidden with a Win32 `ShowWindow(SW_HIDE)` call (Windows only)

Google blocks *sign-in* from headless browsers, but `browser-data/gemini` is already
authenticated, so `headless: true` may work for normal runs. Confirm with
`npm run probe:browser --headless` before switching it on.

## Reliability

**Per-part resume.** Each part's notes are checkpointed to `temp/checkpoints/` the
moment it succeeds. If a run dies on part 6 of 8, the next run reuses parts 1-5 and
only regenerates what's missing. Split video parts are deliberately *kept* on failure
for this reason, and cleaned up on eventual success. Checkpoints are fingerprinted
against the source video and `segmentSeconds`, so changing either discards them
rather than mixing parts from different splits.

**Pretty backfill.** Prettifying is non-fatal — raw notes are the valuable artefact
and a formatting failure must never lose them. Every run therefore ends by sweeping
for raw notes without pretty siblings and retrying them.

**Google's rate limit is the browser path's real ceiling.** Enough new conversations
in a short window gets the profile served `google.com/sorry/index` — the "unusual
traffic" check — which locks the browser backend out entirely until it clears
(usually tens of minutes; opening Gemini manually in that profile and passing the
check clears it immediately). It surfaced during testing as a misleading
`waitForSelector("input-area-v2") timed out`, so it is now detected and reported
by name, and the notes runner no longer burns its retries against it.
`browser.tabStaggerMs` spaces tab starts to keep the traffic pattern less bursty,
which costs almost nothing because the long upload and generation waits still
overlap. This is why `concurrency.browserTabs` is 3 rather than a larger number,
and why `providers.pretty` defaults to `api`.

**Timestamp rebasing.** Each part is uploaded as a standalone video, so Gemini numbers
every segment from 00:00 — part 2 saying `[02:00]` really means 17:00. The prompts pin
the format to `[MM:SS]` / `[H:MM:SS]` and `src/utils/timestamps.ts` adds
`(partNum - 1) × segmentSeconds` afterwards. The arithmetic is done in code rather than
by the model because the offset is a known constant and a model that miscounts produces
a plausible-looking wrong timestamp nothing downstream can catch. Clock times
("9:00 AM") and ratios ("3:1") are left alone.

## Project structure

```
src/
  main.ts              # Panopto pipeline entry point
  panopto/             # scraper + downloader
  gemini/              # uploader, prompter, prompts, browser pool, Vertex client
  notes/               # parser, writer, prettifier
  db/                  # SQLite schema + tracker
  todo/                # TODO.md manager
  pipeline/            # shared per-lecture flow, part runner, checkpoints, pretty backfill
  settings/            # GUI-editable settings: schema + settings.json overlay
  gui/                 # control panel server, job runner, library, scheduler
  utils/               # logger, retry, limiter, timestamps, video splitter, lock, paths
web/                   # control panel front end (plain HTML/CSS/JS, no build step)
scripts/
  gui.ts               # launch the control panel
  scan-panopto.ts      # find new lectures without downloading
  process-selected.ts  # process/prettify a chosen set of lectures
  process-local.ts     # local video pipeline
  run-pretty.ts        # batch prettifier
  probe-vertex.ts      # verify the Vertex model is reachable
  probe-browser.ts     # verify Gemini sign-in + concurrent tabs
  export-notes.ts      # export to Exports/
  migrate-to-subfolders.ts  # one-time migration (already run)
prompts/
  pretty-notes.txt     # prettifier formatting rules (11 rules)
docs/
  gui-design.md        # control panel scoping + wireframes
```

## Database

Processing state is tracked in `uninotes.db` (SQLite, gitignored). Lectures progress through statuses:

```
new → downloading → downloaded → processing → processed → complete
                                                         ↘ error
```

Use `--retry` flags to reset errored lectures back into the pipeline.
