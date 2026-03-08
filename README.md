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

## Configuration

All settings are in `config.ts`:

| Setting | Default | Description |
|---|---|---|
| `gemini.responseTimeout` | 5 min | Max wait for Gemini to respond |
| `gemini.uploadTimeout` | 30 min | Max wait for video upload (increase for large files) |
| `segmentSeconds` | 900 (15 min) | Videos longer than 45 min are split into segments |
| `retry.maxRetries` | 3 | Retry attempts for download and Gemini failures |
| `browser.headless` | false | Run browser visibly (set true to run headless) |

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
