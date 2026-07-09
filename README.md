# UniNotes

Automated university lecture note pipeline. Polls Panopto for new lecture recordings, downloads them, generates comprehensive study notes via Google Gemini, then polishes the output with Claude.

## How it works

```
Panopto  →  Download  →  Gemini (notes)  →  lecture.raw.md
                                         →  Claude (prettify)  →  lecture.pretty.md
                                         →  TODO.md (action items)
```

For lectures not on Panopto (e.g. SOFTENG 700), drop the video in `Incoming/<CourseCode>/` and run `npm run local` instead.

Notes are saved to `Lectures/<CourseCode>/<LectureTitle>/`:
```
Lectures/
  COMPSCI 732/
    [109-B28] COMPSCI 732 L01 - Fri 06 Mar/
      lecture.raw.md      # Gemini-generated notes (source of truth)
      lecture.pretty.md   # Claude-reformatted version
      lecture.mp4         # original video (local lectures only)
```

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [ffmpeg](https://ffmpeg.org/) (for splitting long videos) — must be on PATH
- [Claude Code CLI](https://claude.ai/code) (`claude`) — for the pretty-notes step
- Microsoft Edge (used by Playwright for Panopto and Gemini)
- A University of Auckland Panopto account
- A Google account with Gemini access

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

Finds every `lecture.raw.md` missing a sibling `lecture.pretty.md` and runs Claude on it:

```bash
npm run pretty
```

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

By default, videos are uploaded through a Playwright-automated browser session at gemini.google.com. As an alternative, you can process videos through the **Vertex AI API** (Google Cloud) instead, using model `gemini-3.5-flash`. This avoids the browser entirely and is generally faster/more reliable, at the cost of Vertex AI usage charges.

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
| `UNINOTES_UPLOADER` | `browser` | `api` or `browser` — see above |
| `GOOGLE_CLOUD_PROJECT` | `config.ts: vertex.project` | GCP project ID used for Vertex AI + GCS |
| `GOOGLE_CLOUD_LOCATION` | `us-central1` | GCP region for Vertex AI + the GCS bucket |
| `UNINOTES_GCS_BUCKET` | `config.ts: vertex.gcsBucket` | Bucket video chunks are uploaded to before calling Gemini |

The bucket is created automatically (uniform access, region-matched) if it doesn't already exist. Uploaded video chunks are deleted from the bucket after each part is processed (controlled by `vertex.cleanupUploads` in `config.ts`, best-effort — failures are logged, not fatal).

## Configuration

All settings are in `config.ts`:

| Setting | Default | Description |
|---|---|---|
| `gemini.responseTimeout` | 5 min | Max wait for Gemini to respond |
| `gemini.uploadTimeout` | 30 min | Max wait for video upload (increase for large files) |
| `segmentSeconds` | 900 (15 min) | Videos longer than 45 min are split into segments |
| `retry.maxRetries` | 3 | Retry attempts for download and Gemini failures |
| `browser.headless` | false | Run browser visibly (set true to run headless) |
| `vertex.model` | `gemini-3.5-flash` | Model used on the `--uploader=api` path |
| `vertex.location` | `us-central1` | GCP region for Vertex AI + GCS bucket |
| `vertex.cleanupUploads` | true | Delete GCS video chunks after each part is processed |

## Project structure

```
src/
  main.ts              # Panopto pipeline entry point
  panopto/             # scraper + downloader
  gemini/              # uploader, prompter, prompts
  notes/               # parser, writer, prettifier
  db/                  # SQLite schema + tracker
  todo/                # TODO.md manager
  utils/               # logger, retry, video splitter, paths
scripts/
  process-local.ts     # local video pipeline
  run-pretty.ts        # batch prettifier
  export-notes.ts      # export to Exports/
  migrate-to-subfolders.ts  # one-time migration (already run)
prompts/
  pretty-notes.txt     # Claude editor rules (11 rules)
```

## Database

Processing state is tracked in `uninotes.db` (SQLite, gitignored). Lectures progress through statuses:

```
new → downloading → downloaded → processing → processed → complete
                                                         ↘ error
```

Use `--retry` flags to reset errored lectures back into the pipeline.
