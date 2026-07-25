# UniNotes

Turns lecture recordings into study notes. It watches your university's Panopto
for new recordings, downloads them, and has Gemini write structured notes with
timestamps — unattended, on a schedule if you want.

Built for the University of Auckland, but Panopto is the same product everywhere:
**set one URL and it works at any institution that uses Panopto.** Lectures that
aren't on Panopto at all work too — drop the video in a folder.

```
Panopto  →  Download  →  Gemini (notes)    →  lecture.raw.md
                      →  Gemini (prettify) →  lecture.pretty.md
                                           →  TODO.md (action items)
```

Notes land in `Lectures/<CourseCode>/<LectureTitle>/`:

```
Lectures/
  COMPSCI 732/
    [109-B28] COMPSCI 732 L01 - Fri 06 Mar/
      lecture.raw.md      # Gemini-generated notes (source of truth)
      lecture.pretty.md   # reformatted version
      lecture.mp4         # original video (local lectures only)
```

Everything is available both as a CLI and as a local control panel
(`npm run gui`). The panel is a launcher, not a second implementation — every
button runs the command you'd otherwise type.

---

## Quick start

### 1. Install

```bash
git clone https://github.com/Tahallaman/UniNotes.git
cd UniNotes
npm install
npm run setup        # downloads the Playwright browser driver for Edge
```

You also need [ffmpeg](https://ffmpeg.org/download.html) on your `PATH`. Lectures
longer than 15 minutes are split before upload, and that's what does the
splitting.

<details>
<summary>Installing ffmpeg</summary>

```bash
winget install Gyan.FFmpeg      # Windows
brew install ffmpeg             # macOS
sudo apt install ffmpeg         # Debian/Ubuntu
```

Open a new terminal afterwards, then check with `ffmpeg -version`.
</details>

### 2. Tell it which Panopto

This is the only value the tool cannot guess. It's the first part of the address
you see while watching a recording:

```
https://yourschool.hosted.panopto.com/Panopto/Pages/Viewer.aspx?id=...
^--------------- this much ---------------^
```

The regional suffix varies by institution — `.hosted.`, `.eu.`, `.au.`, `.ca.`
Everything after the host is identical on every tenant, so the host is all you
need. Set it in **any** of these ways:

```bash
npm run gui                                       # Settings → Institution → Panopto site
```
```ts
// config.ts
panopto: { baseUrl: "https://yourschool.hosted.panopto.com", ... }
```
```bash
export UNINOTES_PANOPTO_URL=https://yourschool.hosted.panopto.com
```

The control panel is the easiest of the three: it writes `settings.json`, which
is gitignored and merged over `config.ts` at load, so your setup never shows up
in `git diff`.

### 3. Sign in

Panopto and Gemini each get a persistent Edge profile, so you log in by hand once:

```bash
npm run setup-auth:panopto   # opens Edge → complete your university SSO → close the window
npm run setup-auth:gemini    # opens Edge → log in to Google → close the window
```

Sessions are saved to `browser-data/` (gitignored). If your institution uses
2FA, you'll do it here and not again until the session expires.

### 4. Check it works

```bash
npm run probe:browser   # is the profile signed in? do parallel tabs work?
```

Then run it:

```bash
npm run scan            # find new lectures, download nothing
npm run dev             # the full pipeline: scan → download → notes → prettify
```

Or open the panel and press buttons:

```bash
npm run gui             # → http://localhost:4571
```

---

## Two backends

Each stage independently runs through **either** backend:

| Backend | What it is | Trade-off |
|---|---|---|
| `browser` | Playwright driving gemini.google.com with your logged-in session | Free; slower; rate-limited by Google |
| `api` | Gemini on Vertex AI via gcloud ADC | Billed; roughly 10× faster; parallelises cleanly |

**`browser` is the default and needs no cloud account at all** — just a Google
account with Gemini access. Start there.

Set them per stage in `config.ts` under `providers`, in the control panel, or
per-run with `--uploader=` (notes) and `--pretty=` (pretty).

<details>
<summary>Setting up the <code>api</code> backend</summary>

You need a Google Cloud project with billing enabled, the Vertex AI and Cloud
Storage APIs turned on, and local credentials:

```bash
gcloud auth application-default login
```

Then set the project ID (control panel → Settings → Google Cloud, or
`vertex.project` in `config.ts`, or `GOOGLE_CLOUD_PROJECT`), and verify:

```bash
npm run probe:vertex    # countTokens + a tiny generate against the configured model
```

Video chunks are staged in a Cloud Storage bucket so Vertex can read them. Leave
`vertex.gcsBucket` blank and it derives `uninotes-<project>` and creates it on
first use — bucket names are globally unique, so deriving one from your project
ID avoids a name collision with a stranger. Chunks are deleted after each part is
processed.

**This costs money.** A two-hour lecture is eight video segments through a Flash
model. Check current Vertex pricing before running a semester's backlog.
</details>

---

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
| **Run** | Every pipeline action, each labelled with the live count that decides whether it'll do anything ("3 videos in Incoming/", "5 lectures pending"). Health checks for ffmpeg, your Panopto site, both browser sessions and gcloud credentials. Setup, probes, maintenance. Live console with cancel. |
| **Library** | Every lecture, filterable by course, status and text, plus "missing pretty only". Select any number and process, prettify, reset, ignore or forget them. Click one for details, resume state, links and a rendered preview of its notes. |
| **Settings** | Institution, providers, models, concurrency, timeouts, browser mode, Google Cloud — with the ranges and the reasoning attached. |
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

---

## Usage

### Run the full pipeline

```bash
npm run dev
npm run dev -- --retry      # also retry lectures that previously errored
```

Scrapes Panopto for new lectures, downloads them, processes through Gemini, and
generates pretty notes. Skips anything already processed.

### Process local videos (non-Panopto lectures)

Nothing here is Panopto-specific — this path works for any video file, so
recorded meetings, Zoom exports and downloaded lectures all go through it.

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

The video is moved to `Lectures/<CourseCode>/<Title>/lecture.mp4` afterwards.

### Prettify existing raw notes

Finds every `lecture.raw.md` missing a sibling `lecture.pretty.md` and prettifies it:

```bash
npm run pretty
npm run pretty -- --pretty=browser   # use the web UI instead of Vertex
npm run pretty -- --force            # regenerate even where pretty notes exist
```

The main pipeline runs this same sweep automatically at the end of every run, so a
pretty step that failed last night is retried tonight with no flags needed.

### Skip lectures you don't want

Copy `ignored-lectures.example.txt` to `ignored-lectures.txt` and paste titles
into it, one per line — or use Library → select → Ignore in the control panel,
which writes the same file. It's gitignored, since real lecture titles identify
your courses.

### Export notes

Copies notes into a flat `Exports/` tree for easy sharing or syncing:

```bash
npm run export           # both Raw and Pretty
npm run export -- --raw     # raw only
npm run export -- --pretty  # pretty only
```

```
Exports/
  Raw/<CourseCode>/<LectureTitle>.md
  Pretty/<CourseCode>/<LectureTitle>.md
```

### Scheduling

The control panel's **Schedule** tab drives Windows Task Scheduler directly, with
presets for once daily, twice daily and hourly. On macOS or Linux, use cron:

```cron
0 3 * * *  cd /path/to/UniNotes && npm run dev >> logs/cron.log 2>&1
```

---

## Configuration

Defaults live in `config.ts`, each with a comment explaining why it is what it
is. Overrides go in `settings.json` (written by the control panel, gitignored) or
in environment variables, which win over both.

| Setting | Default | Description |
|---|---|---|
| `panopto.baseUrl` | *(unset)* | **Required.** Your institution's Panopto host |
| `providers.notes` | `browser` | Backend for video → raw notes |
| `providers.pretty` | `api` | Backend for raw → pretty notes |
| `concurrency.lectures` | 3 | Lectures processed simultaneously |
| `concurrency.parts` | 4 | Parts of one lecture processed simultaneously |
| `concurrency.vertexInFlight` | 8 | Global cap on concurrent Vertex calls |
| `concurrency.gcsUploads` | 3 | Global cap on concurrent GCS uploads |
| `concurrency.browserTabs` | 3 | Global cap on concurrent Gemini tabs |
| `gemini.responseTimeout` | 10 min | Max wait for one Gemini answer (a 29k-char response takes ~4 min) |
| `gemini.uploadTimeout` | 30 min | Max wait for video upload (increase for large files) |
| `segmentSeconds` | 900 (15 min) | Videos longer than this are split into segments |
| `retry.maxRetries` | 3 | Retry attempts for download and Gemini failures |
| `browser.headless` | false | Run headless (verify with `npm run probe:browser` first) |
| `browser.windowMode` | `offscreen` | `normal`, `offscreen`, or `hidden` — see below |
| `browser.tabStaggerMs` | 2000 | Gap between starting one Gemini tab and the next (see Reliability) |
| `courseCodePatterns` | 3 regexes | How a course code is recognised in a folder or title |
| `vertex.project` | *(unset)* | GCP project — only needed by the `api` backend |
| `vertex.gcsBucket` | *(derived)* | Blank derives `uninotes-<project>` and creates it |
| `vertex.model` | `gemini-3.6-flash` | Model for video → notes |
| `vertex.generation.pretty.model` | `gemini-3.6-flash` | Model for prettifying (thinking disabled) |
| `vertex.location` | `global` | 3.x Flash models are only served on `global` |
| `vertex.cleanupUploads` | true | Delete GCS video chunks after each part is processed |
| `workspace.enabled` | false | Keep a second copy of each pretty note in another folder |
| `workspace.root` | `~/Documents/UniNotes` | Where that copy goes — `<Course>/Unsorted Lectures/` inside it |

**Setting every `concurrency` value to 1 reproduces fully-sequential
behaviour** — the first thing to try when debugging.

### Environment variables

Every one of these overrides both `config.ts` and `settings.json`. See
[`.env.example`](.env.example).

| Variable | Description |
|---|---|
| `UNINOTES_PANOPTO_URL` | Your Panopto host |
| `UNINOTES_UPLOADER` | `api` or `browser` for the notes stage |
| `UNINOTES_PRETTY` | `api` or `browser` for the pretty stage |
| `GOOGLE_CLOUD_PROJECT` | GCP project ID used for Vertex AI + GCS |
| `GOOGLE_CLOUD_LOCATION` | Vertex region (default `global`) |
| `UNINOTES_GCS_BUCKET` | Bucket video chunks are staged in |
| `UNINOTES_GCS_BUCKET_LOCATION` | Bucket region — GCS rejects `global` |

### Course codes

Lectures are filed by course code, extracted from the Panopto folder name and
title by the regexes in `courseCodePatterns`. The defaults match the common
shapes (`COMPSCI 361`, `CS361`, `COMPSCI-361`, `361 COMPSCI`). If your
institution numbers courses differently, add a pattern — first match wins, and
anything unmatched is filed under `UNSORTED`.

### Keeping the browser out of your way

`browser.windowMode` controls how the (still genuinely headed) window is presented:

- `normal` — a visible window
- `offscreen` — parked outside the visible desktop via `--window-position`
- `hidden` — hidden with a Win32 `ShowWindow(SW_HIDE)` call (Windows only)

Google blocks *sign-in* from headless browsers, but `browser-data/gemini` is already
authenticated, so `headless: true` may work for normal runs. Confirm with
`npm run probe:browser --headless` before switching it on.

---

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

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `No Panopto site configured` | Step 2 of the quick start — set `panopto.baseUrl`. |
| `No Google Cloud project configured` | A stage is set to `api` without a project. Switch it to `browser` or set `vertex.project`. |
| Scraping finds nothing | Panopto only lists lectures you're *subscribed* to. Check the Subscriptions page in your browser first. |
| `waitForSelector("input-area-v2") timed out` | Usually Google's "unusual traffic" check — open Gemini in `browser-data/gemini` manually and clear it. See Reliability. |
| Notes stop mid-lecture | `gemini.responseTimeout`. Long segments on a busy day can exceed 5 minutes. |
| Everything is filed under `UNSORTED` | No `courseCodePatterns` regex matched. See Course codes. |
| Pipeline says it's already running | A stale lock from a killed process. Control panel → Run → Clear lock. |

Logs are in `logs/`, one file per day.

---

## Project structure

```
src/
  main.ts              # Panopto pipeline entry point
  panopto/             # scraper, downloader, URL builders
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
prompts/
  pretty-notes.txt     # prettifier formatting rules
docs/
  gui-design.md        # control panel scoping + wireframes
```

Processing state is tracked in `uninotes.db` (SQLite, gitignored):

```
new → downloading → downloaded → processing → processed → complete
                                                         ↘ error
```

Use `--retry` flags to reset errored lectures back into the pipeline.

---

## Your data stays yours

Nothing in this repository is your coursework. `Lectures/`, `Incoming/`,
`Exports/`, `ignored-lectures.txt`, `settings.json`, `browser-data/`,
`uninotes.db` and `logs/` are all gitignored, so notes, real lecture titles,
session cookies and your own configuration never end up in a commit.

Videos and notes are sent to Google — via your signed-in Gemini session on the
`browser` backend, or Vertex AI on the `api` backend. Lecture recordings are
usually your institution's copyright and may contain other students' voices and
names. Check what your institution's policy allows before running this on
anything, and think twice before publishing the output.

## Platform support

Developed and tested on Windows 11. The pipeline itself is portable, but two
things are Windows-only: the **Schedule** tab (Windows Task Scheduler) and
`browser.windowMode: "hidden"` (a Win32 call). Use cron and `offscreen` or
`normal` elsewhere. Patches welcome.

## Contributing

Issues and pull requests are welcome. Two things to know before you open one:

- `npm run typecheck` must pass. There is no test suite; the probes
  (`npm run probe:browser`, `npm run probe:vertex`) are how the external
  dependencies get verified.
- Comments here explain *why*, not *what*. If a value or an approach is
  non-obvious, the reason it was chosen is the useful half.

Never include real lecture content, titles, or Panopto URLs in an issue,
a test fixture, or a commit.

## License

[MIT](LICENSE).
