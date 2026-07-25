# UniNotes Control Panel — scoping & wireframes

A local GUI that sits *beside* the CLI, not on top of it. Every button shells out to
the same `tsx` entry point you would have typed, so there is exactly one pipeline and
the GUI can never drift from it.

## Why a local web app

| Option | Verdict |
|---|---|
| **Local HTTP server + static page** | **Chosen.** Zero new dependencies, no build step, works with the existing `tsx` workflow, and the log stream is trivially live over SSE. |
| Electron / Tauri | Hundreds of MB and a packaging step bolted onto a 4-dependency project, to render the same form. |
| TUI (blessed/ink) | Can't show a lecture library or render notes comfortably, and the user asked for buttons. |

Serves on `127.0.0.1:4571` — loopback only, never `0.0.0.0`.

## Two ways the GUI talks to the pipeline

This split is the core design decision.

**Reads happen in-process.** Lecture library, status, settings and schedule are plain
function calls inside the server. Fast, no spawn cost. The DB is opened **read-only**
so the GUI can never contend with a running job for the write lock.

**Writes happen as child processes.** Every action spawns the real CLI:

```
Run pipeline   →  tsx src/main.ts
Retry errors   →  tsx src/main.ts --retry
Local videos   →  tsx scripts/process-local.ts
Prettify       →  tsx scripts/run-pretty.ts
Selected       →  tsx scripts/process-selected.ts --selection=…
Scan Panopto   →  tsx scripts/scan-panopto.ts
Export         →  tsx scripts/export-notes.ts
Auth           →  tsx src/main.ts --auth panopto|gemini
Probes         →  tsx scripts/probe-vertex.ts | probe-browser.ts
```

Running the pipeline *inside* the server would mean re-entering `processLecture` in a
long-lived process that also holds the PID lock, owns the browser pool, and calls
`process.exit()` from several scripts. Spawning keeps all of that unchanged, means a
crashed run can't take the GUI down with it, and makes Cancel a real kill rather than a
cooperative flag nobody implemented.

**One job at a time.** The pipeline's PID lock already enforces this across processes;
the GUI enforces it up front so you get a clear "already running" instead of a lock-file
error 200ms later.

## Visual direction

**Colour is reserved for state.** The primary action is a solid ink block, not a
coloured pill, which frees green / amber / brick to mean exactly one thing each:
ready, working, broken. Neutrals carry a faint green bias so they read as chosen
rather than inherited. Every count, path, timecode and course code is set in
monospace with `tabular-nums` — this tool's subject is transcripts and timestamps,
and the data should look like data.

Both themes are built from the same token set, and the viewer's explicit
`data-theme` beats the OS preference in both directions.

## Layout

Single page, four tabs, a quiet masthead. No status pills in the header — the Run
tab's first line already says what's happening, and duplicating it is noise.

### Tab 1 — Run

The screen is the pipeline itself, written out as steps: **state → do it all →
each step on its own → output.**

```
┌──────────────────────────────────────────────────────────────────────────┐
│  UniNotes    Run   Library   Settings   Schedule                         │
├──────────────────────────────────────────────────────────────────────────┤
│  ● Ready   notes browser · pretty api                                    │
│                                                                          │
│  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  │
│  ┃ Run the whole pipeline                                             ┃  │
│  ┃ Every step below, in order, skipping whatever is already done      ┃  │
│  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  │
│                                                                          │
│  STEP BY STEP                                                            │
│  ──────────────────────────────────────────────────────────────────────  │
│      Check Panopto for new recordings                       [ Scan ]     │
│      Records what's there. Downloads nothing.                            │
│   0  found on Panopto, not downloaded yet                                │
│   1  downloaded, no notes yet                            [ Process ]     │
│   4  lectures without pretty notes                       [ Prettify ]    │
│   3  lectures that failed last time                      [ Retry ]       │
│                                                                          │
│  OTHER ACTIONS                                                           │
│  ──────────────────────────────────────────────────────────────────────  │
│   0  videos waiting in Incoming/                                         │
│      Copy notes to Exports/ and the workspace folder      [ Export ]     │
│      Rewrite every pretty note                        [ Rewrite all ]    │
│      Re-run local videos that errored                     [ Retry ]      │
│                                                                          │
│  SETUP & CHECKS                                                          │
│  ──────────────────────────────────────────────────────────────────────  │
│      Panopto sign-in · Session saved.                    [ Sign in ]     │
│      Google sign-in · Session saved.                     [ Sign in ]     │
│      Vertex AI connection · Credentials found.              [ Test ]     │
│      Gemini browser session                                 [ Test ]     │
│                                                                          │
│  OUTPUT                                     ☑ follow   Stop   Clear      │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ 15:04:41  COMPSCI 361 · L4 · part 2/8  Waiting for response…       │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

**One row pattern for everything.** A count where the row measures something, a
statement of fact, and the action on the right. It replaced a six-card grid plus a
six-button diagnostics row plus three maintenance buttons — eighteen controls of
identical weight, which is a control surface, not a utility.

**The pipeline is written out as steps, because that's how it gets used**: scan to
see what's appeared, then download, then process. An earlier version hid the
individual steps behind a disclosure and led with one do-everything button, which
got the emphasis backwards — the all-in-one is the shortcut, not the only route.
It's still there, first, for when you don't want to think about it.

**A step's button does only that step.** "Process" on a row reading "1 downloaded,
no notes yet" runs `process-selected` against exactly that lecture's id, not the
whole pipeline. The ids are fetched at click time, since a scan may have just added
rows the status poll doesn't carry yet.

**A count of zero means no button** — nothing to press, nothing to decide. Those
rows stay visible rather than disappearing, because "0 videos waiting in Incoming/"
is an answer, and a row that vanishes leaves you wondering whether it was checked.

**Health checks are drawn only when they fail.** Five green ticks confirming that
nothing is wrong are five things to read before finding the one that matters.
Silence means healthy; a failure appears as an alert with its fix inline. The
Setup rows carry the short version ("Session saved.") so the state is legible
without an alert shouting about it.

**Maintenance moved to Settings.** Clearing locks, deleting split parts and wiping
checkpoints are destructive and rare; they belong with configuration, not on the
screen you use to start a run.

The console is the same text the CLI prints, dimmed by level, with a follow toggle.
A ring buffer keeps the last 2000 lines so reloading doesn't lose the run in
progress.

### Tab 2 — Library

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [search…            ]  Course ▾  Status ▾  ☐ Missing pretty only         │
│  63 lectures · 58 complete · 3 error · 2 new                             │
├──────────────────────────────────────────────────────────────────────────┤
│ ☐ │ Lecture                        │ Course      │ Status   │ Notes      │
│ ☐ │ L04 – Te Tiriti o Waitangi     │ CAPSTONE750 │ complete │ raw pretty │
│ ☑ │ L01 – Computer Architecture    │ COMPSYS 730 │ complete │ raw ·      │
│ ☐ │ Meeting week 8                 │ SOFTENG 700 │ error    │ · ·        │
│   │   ↳ MAX_TOKENS on part 3/6                                           │
├──────────────────────────────────────────────────────────────────────────┤
│ 2 selected:  [ Process ] [ Prettify ] [ Reset to retry ] [ Ignore ]       │
└──────────────────────────────────────────────────────────────────────────┘
```

Clicking a row opens a detail drawer: full status history, error text, file paths,
Panopto/Gemini links, `Open folder`, and a rendered preview of the raw or pretty notes.

The list is a **union of the database and the disk**, not just the DB. 63 lectures on
disk predate parts of the tracking, and a library that silently omitted them would be
worse than useless. Disk-only entries are marked and still support Prettify and Open.

### Tab 3 — Settings

Rendered from a schema (`src/settings/schema.ts`) rather than hand-written HTML, so
adding a setting is one array entry and it gets a form control, validation and
persistence for free.

```
┌─ Providers ──────────────────────────────────────────────────────────────┐
│  Notes  (video → raw)      (•) browser   ( ) api                         │
│  Pretty (raw → pretty)     ( ) browser   (•) api                         │
├─ Models ─────────────────────────────────────────────────────────────────┤
│  Vertex model (notes)      [ gemini-3.6-flash          ]                  │
│  Vertex model (pretty)     [ gemini-3.6-flash          ]                  │
│  Web picker label          [ 3.6 Flash                 ]                  │
│  Vertex location           [ global                    ]                  │
│  Thinking (notes)          [ model default          ▾ ]                  │
├─ Concurrency ────────────────────────────────────────────────────────────┤
│  Lectures at once          [──●──────] 3                                 │
│  Parts per lecture         [────●────] 4      ⓘ all 1 = sequential       │
│  Vertex in flight          [──────●──] 8                                 │
│  GCS uploads               [──●──────] 3                                 │
│  Browser tabs              [──●──────] 3                                 │
├─ Video & retries ────────────────────────────────────────────────────────┤
│  Segment length            [ 900 ] s (15 min)  ⚠ changes discard resume  │
│  Max retries               [ 3 ]                                          │
├─ Browser ────────────────────────────────────────────────────────────────┤
│  Headless                  [ off ▾ ]   Window mode [ offscreen ▾ ]        │
├──────────────────────────────────────────────────────────────────────────┤
│  Changed: providers.pretty, concurrency.parts    [ Revert ] [ Save ]      │
└──────────────────────────────────────────────────────────────────────────┘
```

Saving writes `settings.json` at the project root, which `config.ts` deep-merges over
its defaults at load. The GUI never rewrites `config.ts` — generating TypeScript source
from a form is how you lose comments and end up with a config nobody trusts. Defaults
stay readable and reviewable in git; your overrides are a small, gitignored JSON file,
and "Revert" is a delete rather than an edit.

Settings apply to the **next** job, since jobs are separate processes that read config
at startup. The UI says so where a run is in flight.

### Tab 4 — Schedule

Wraps Windows Task Scheduler (`schtasks`) — the same mechanism `scripts/setup-scheduler.bat`
uses today, but visible and editable.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Scheduled runs                                          [ + Add time ]  │
├──────────────────────────────────────────────────────────────────────────┤
│  ● 07:30 daily   full pipeline    next: tomorrow 07:30    [edit] [del]    │
│  ● 19:00 daily   full pipeline    next: today 19:00       [edit] [del]    │
│  ○ 02:00 daily   prettify only    disabled                [edit] [del]    │
├──────────────────────────────────────────────────────────────────────────┤
│  Presets:  [ Once daily 07:30 ]  [ Twice daily 07:30 + 19:00 ]  [ Hourly ]│
└──────────────────────────────────────────────────────────────────────────┘
```

One `schtasks` task per time slot (`UniNotes-<slot>`), because a single task can't hold
two daily start times without a repetition interval that also fires overnight. Presets
cover the common cases in one click; Add time covers the rest.

## Design rules

1. **The GUI is a launcher, not a reimplementation.** No pipeline logic lives in
   `src/gui/`. If a button needs behaviour the CLI can't do, the CLI gets it first.
2. **Never guess state.** Counts, pending work and health come from the same DB and
   filesystem the pipeline uses, refreshed on a 5s poll and on every job event.
3. **A control appears only when it would do something.** Everything else is either
   plain text or behind a disclosure. The number of things on screen should track
   the number of decisions actually available.
4. **Destructive actions confirm and say what they'll delete**, with counts and sizes.
5. **Loopback only, plus a header guard.** A page on another origin cannot POST to this
   server: mutations require an `X-UniNotes` header, which cross-origin requests cannot
   set without a preflight the server refuses.
6. **Note content is escaped before rendering.** Notes are model output; treating them
   as trusted HTML would be an injection hole in a page that also holds action buttons.

## Out of scope

- Multi-user / remote access — this is a personal loopback tool.
- Editing note content in the browser. Files on disk are the source of truth; the GUI
  opens them, it doesn't own them.
- Replacing the CLI. Every action remains available and documented as a command.
