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
Copy to yours  →  tsx scripts/sync-workspace.ts [--dry-run]
Auth           →  tsx src/main.ts --auth panopto|gemini
Probes         →  tsx scripts/probe-vertex.ts | probe-browser.ts | probe-panopto-view.ts
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
`data-theme` beats the OS preference in both directions. The toggle sits at the
right of the masthead and writes to `localStorage`, never to `settings.json`:
which theme suits the room you're in is not a fact about your notes pipeline, and
it shouldn't turn up in the list of things you've changed from the defaults. With
nothing stored the stylesheet's `prefers-color-scheme` block applies on its own,
and a two-line inline script in `<head>` applies a stored choice before first
paint — a module at the end of `<body>` is far too late to avoid a flash of the
other theme.

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
│ ☐ │ Lecture                     │ Course      │ Status   │ Notes  │Video│ Date  │Wk│ ✓ │
│ ☐ │ L04 – Te Tiriti o Waitangi  │ CAPSTONE750 │ complete │ raw prt │play │Tue 4 Aug│ 3│ ☑ │
│ ☑ │ L01 – Computer Architecture │ COMPSYS 730 │ complete │ raw ·   │fetch│Mon 20 Jul│ 1│ ⊟ │
│ ☐ │ Meeting week 8              │ SOFTENG 700 │ error    │ · ·     │  —  │no date│ —│ ☐ │
│   │   ↳ MAX_TOKENS on part 3/6                                           │
├──────────────────────────────────────────────────────────────────────────┤
│ 2 selected:  [ Process ] [ Prettify ] [ Reset to retry ] [ Ignore ]       │
└──────────────────────────────────────────────────────────────────────────┘
```

**Video** is where the player lives in the list, and it is a column rather than a
button in the drawer for one reason: playing a lecture against its notes is the
most useful thing the panel does and it was the least findable. Nothing in the
list said a recording existed, or could, so it was only discovered by opening a
lecture and reading the buttons. The cell reads `fetch`, `play` or `—`, in the
same quiet mono as the Notes cell beside it, so it lands as another fact about
the lecture rather than a control bolted onto every row.

Both actions require notes. The player *is* notes synced to a recording — without
them there is no highlight, nothing to click to seek by, and a gigabyte of
download buys you a video in a panel, which the Panopto link already gives you.
The rule is enforced in `scripts/fetch-video.ts` as well as in the cell, since
that script takes ids from a file.

**Date, and the list is ordered by it** — most recent lecture first, which is the
order a semester is actually lived in: the one you are behind on is at the top.
It used to sort by `updated_at`, which meant processing a month-old recording
threw it above this morning's, so the list reordered itself around whatever the
pipeline had last done rather than around the course. Dateless lectures go last
rather than being guessed into the middle, matching how export numbering treats
one, and ISO dates compare correctly as strings so the sort needs no parsing.
Updated is still a column; it is just no longer the spine of the list.

The cell shows the weekday, because lectures recur on the same day and "Tue" is
how you tell which of a course's two slots this one is. The year appears only
when it isn't the current one — a column of "2026" repeated forty times says
nothing. Its tooltip names the source, since a date read off a title is a guess
and knowing which are guesses is what tells you where to look when a lecture is
filed wrongly. The date is built from its parts rather than `new Date(iso)`,
which reads a bare date as UTC: west of Greenwich that renders as the day before,
which on a Monday lecture is last week.

The last column is a **Watched** tick. It is stored on the lecture row and is the
one thing in the library the pipeline never writes — so it does not bump
`updated_at`, which would otherwise reorder the list every time you ticked one.
Folders with no database row have nowhere to keep it and show a dash instead.

**It has three states, because watching has three.** A checkbox already has a
third look and this is what it is for: an empty box is a lecture you have not
opened, a tick is one you are done with, and the indeterminate dash is one you
are part-way through — where an empty box would claim you had never started it
and a tick would be a lie. The tooltip carries the numbers the dash can't:
`43% watched — picks up at 12:34`.

The dash is not set by hand. The player writes `resume_at` every few seconds and
whenever it stops, and `video_seconds` beside it — the length is stored because
"43%" has to be answerable from the Library, where no video is open to measure.
Passing `player.watchedAt` (90% by default) ticks the box for you: a lecture is
over before the video is, the last minutes being questions and packing up, so
waiting for the final second means the box never ticks itself and the column
goes back to being maintained by hand. **The threshold is applied on the server**,
in `setProgress`, so the rule holds wherever progress arrives from and a browser
closed at 89% can't leave a lecture stuck one percent short forever.

Unticking by hand also forgets the position. Without that, clearing a lecture you
had watched to the end would put a "97% watched" dash straight back into the box
you just cleared, and reopening it would resume ninety seconds from the end — the
untick would look like it had failed and then behave as though it had.

**Wk** is derived, never stored. A week is a view of a date through a term whose
start date you can edit; storing it would mean correcting a term silently left
every lecture filed where it already was. The cell's tooltip carries the date and
where it came from, because "week 8" being wrong is a question about the date.

### Moving what a template renamed

Everything else here follows one rule: nothing at a destination is ever moved or
deleted. That rule is right — those folders are yours, and a tool that rearranges
an Obsidian vault because you edited a text box is one you stop trusting — but it
has a cost, and the cost is a duplicate. Change a template and every note exists
twice under two names, identical, with nothing to say which is current.

So there is exactly one exception, and `src/notes/exportLedger.ts` is the whole
of it: a JSON file at each destination root recording where each lecture's note
was last written. A note moves when that file says we put it somewhere and we are
now putting it somewhere else. Anything not recorded is not touched, which covers
every file you filed, renamed or wrote yourself.

A file at the destination rather than a column in the database, because the
ledger describes a *folder*: point the workspace at another drive and the new one
is correctly empty; restore a folder from backup and its ledger comes back with
it. It is never authoritative — a missing, corrupt or hand-edited ledger costs a
rename, never a note, since the copy happens regardless and the worst case is the
duplicate you'd have had anyway. An occupied destination blocks the move and
reports both paths, because choosing between two files in someone's notes folder
is not a file operation. `npm run sync -- --dry-run` lists every move first.

### Terms, weeks and naming

`{number}` — which lecture of its course this is — arrived from a parallel
implementation of exported names (PR #1) and is the one part of it that survived
the merge intact. Two naming systems couldn't both own a path, and templates
already did everything that one did except this, so it became a token rather than
a second scheme with its own on/off switch and its own opinion about filenames.

`Exports/` leads with the number by default; the second copy doesn't. A course
folder under `Exports/` holds a whole semester, flat, read as an alphabetical
list — sorting is the only thing standing between you and a pile. The workspace
copy is already broken into `Week N/Lectures/` folders holding a handful of notes
each, so the same change would buy nothing and lengthen every name.

Numbering is a course-wide operation, which is why it is passed into
`destinationFor` rather than derived inside it: "the third lecture" is a fact
about a recording's siblings. The number is read out of the title where the title
states one — `parseLectureNumber` in `src/notes/exportName.ts`, which is all that
remains of that module — and taken from date order where it doesn't. The original
ordered unnumbered lectures by month and day scraped out of the notes, with the
year deliberately discarded because Gemini's dates were unreliable; that is no
longer necessary here, since resolveDate has already settled a real date by the
time numbering runs.

Settings holds a **Terms & weeks** group and a **Naming** group. Terms are the one
setting whose value isn't a scalar, so they get a bespoke editor and validator
rather than a second config file — everything `settings.json` provides (one place
to reset, one record of what differs from default) keeps working for them.

Naming is two templates per destination, folder and file, which is only safe to
offer beside something that shows what they do. The **preview** under the Naming
group resolves three *real* lectures — a preview against invented titles proves
nothing about the ones the tool has to cope with — and is computed **server-side**
by the same functions that do the writing. A preview that is a second
implementation is one that eventually disagrees with the writer.

Clicking a row opens a detail drawer: full status history, error text, file paths,
Panopto/Gemini links, `Open folder`, and a rendered preview of the raw or pretty notes.

The list is a **union of the database and the disk**, not just the DB. 63 lectures on
disk predate parts of the tracking, and a library that silently omitted them would be
worse than useless. Disk-only entries are marked and still support Prettify and Open.

### The player

Press **play** in the library, or **Play video** in a lecture's details, and the
drawer stops being a drawer and takes the window: watching a lecture against its
notes is the whole task, not a peek at a row. A title bar, the recording on one
side, the notes on the other, and the facts behind a **Details** toggle rather
than a permanent band across the top.

Opt-in, and that was a correction. Opening straight into the player whenever a
video happened to be cached took the decision away from you: the side panel is
how you reach the folder, the date, the week and every per-lecture action, and it
became unreachable for exactly the lectures you had done the most with. A cached
video is not by itself a request to watch one.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ COMPSYS 730 — L03 Pipelining              ⓘ Details  ⛶ Full screen   ✕   │
├────────────────────────────────────┬─────────────────────────────────────┤
│                                    │  Pretty  Raw                        │
│                                    │                                     │
│                                    │  ## Hazards                         │
│              ▶ video               │  ▏[12:04] A data hazard is …   ◀ now │
│                                    │  ▏• Forwarding resolves most …      │
│                                    │                                     │
│                                    │  ## Branch prediction               │
│ ──────●────────────────  16:45     │   [18:30] Two-bit saturating …      │
├────────────────────────────────────┤                                     │
│ [Synced|Following|Swap]      16:45 │                                     │
└────────────────────────────────────┴─────────────────────────────────────┘
```

**Pretty is the tab a lecture opens on**, watching or not, and after that it is
whichever you last chose. Opening a video onto Raw was tried, on the reasoning
that the prettifier thins out the timestamps the sync runs on — but Pretty is
the version worth reading, and being dropped onto the raw dump every time a
player opened meant one more click before the notes were legible. Enough
timestamps survive prettifying to sync against; Raw is a tab away when you want
the dense ones.

**A tab switch is not a scroll**, which took a guard to make true. Replacing the
pane's contents resets `scrollTop` to 0 and the browser reports that like any
other scroll, so switching from Pretty to Transcript used to switch Following off
and leave you to press the button again. Every content swap is stamped, and the
scroll handler ignores anything within half a second of one — a window rather
than a flag, so a failed load can't leave following stuck on for the rest of the
lecture. Following then re-centres the new tab on the current moment, so the
switch lands you at the same place in a different document.

With following off there is no current moment to land on, so each tab remembers
where you were reading, per lecture. Session-only: a reading position is not a
fact worth writing to disk.

**Swap sides** lives in the player bar, not only in Settings. Which side you want
depends on the lecture — slides dense on one edge, a lecturer's face on the other
— so it belongs next to the video. It still writes `player.notesSide`, because a
preference you have to re-express every time isn't one.

**Scrolling is passive, clicking is active.** That one rule decides the rest. No
scroll handler ever seeks, so reading ahead while a lecture plays can't yank the
video somewhere. Only a click seeks. The reverse direction — the video scrolling
the notes — is opt-in, switches itself off the moment you scroll, and the pill
turns it back on and takes you to wherever playback has got to.

Every block inherits a time rather than only the ones the model stamped, so a
click anywhere in a paragraph works, not just on the `[12:34]`. Headings are the
exception: an unstamped heading takes the time of the block *after* it, because a
heading introduces what follows — without that, entering a section leaves its
title highlighted with the section you just left.

A click seeks a couple of seconds *before* the timestamp so you hear the run-up,
which by the plain rule would light up the previous group. So a click pins its
own group for exactly that lead-in, bounded at both ends: scrubbing away during
those seconds breaks the pin instead of freezing the highlight.

**A click resumes playing only if it already was.** Clicking a note used to
start the video unconditionally, on the reasoning that pointing at a line is
asking to hear it. That is true while you're watching and wrong while you're
reading: working down a paused lecture, clicking through the points and dragging
the picture along with you, meant reaching for pause after every click. So the
paused state is read before the seek — seeking is itself enough to change it —
and only a video that was running is told to carry on.

Paused also drops the lead-in. It buys the run-up to something you are about to
*hear*; with nothing playing the frame is the whole answer, and landing two
seconds early shows the slide before the one you pointed at. So a click while
playing lands early and pins the highlight through the run-up, and a click while
paused lands exactly on the timestamp.

**The video is a local file, not Panopto.** Panopto's pages send
`frame-ancestors 'self' https:`, so they will embed from an https origin but
refuse a page served over `http://127.0.0.1`, and an embed would additionally
want a Panopto sign-in in whichever browser profile is showing the panel. Even
where it loads, the embed API exposes only a polled current time. `src/gui/video.ts`
serves the file with byte-range support instead — without ranges Chrome plays the
file but cannot seek, which is the one interaction everything here is built on.

**The notes column is sized, and the text fills it.** No line-length cap in the
player: the column is yours to size, and a cap means widening it only ever buys
margins — which is exactly how it first read, a 68-character line adrift in a
column twice its width. The default is a readable line at minimum and about a
third of the window where there's room; the divider takes it anywhere between
that floor and leaving the video its own minimum. Double-clicking gives the
default back.

The floor is *measured* rather than assumed, because it's expressed in `ch` and
so depends on the font. Two things bit here and are worth not repeating: a
percentage `flex-basis` resolves against the flex container's *available* main
size, which is still being negotiated with the video pane and came out far wider
than asked for; and a percentage `width` on the pane resolves circularly against
the pane itself, silently collapsing to the floor. The share-of-the-window
default is therefore computed in JS, where the numbers are already exact.

A press on the divider that never moves is a click, not a resize — without that
guard, brushing it pins the current width as a saved setting, and a pinned width
stops the column ever sizing itself again.

**Sync is one switch.** Off, the notes read exactly as they do anywhere else in
the panel while the video plays beside them: no highlight, no self-scrolling, no
click-to-seek. Following is a setting *of* the sync, so it greys out rather than
sitting there as a control that would do nothing. Switching back on lights up
wherever the video has got to by then, not where it was when you switched off.

**The highlight is a filled region, not a margin rule.** A group's blocks are
separate elements with margins between them, so each one bleeds its own fill
outwards with a spread `box-shadow` and the washes meet — the passage reads as
one shaded area rather than a stack of separately tinted paragraphs. The spread
has to exceed the largest gap it must close (an `h2`'s top margin plus the
previous item's bottom margin) or the fill comes out striped wherever the passage
crosses a heading, and the blocks stay square-cornered because a radius on every
one of them notches the edge of the joined region.

**The passage centres, and it's the whole group that centres.** A point can run
to a heading and a dozen bullets; centring only its opening line leaves most of
what's being said below the fold. A group taller than the pane can't be centred
without hiding its start, so that one centres its first block instead.

**Full screen takes the panel, not the video.** The video element already has a
fullscreen button and that one loses the notes, which is the opposite of what
this view is for.

### Transcript and subtitles

Panopto's captions come from `GenerateSRT.ashx?id=<GUID>&language=<n>`, confirmed
by probe rather than assumed — the viewer itself asks for language 0 then 1, so
the fetcher does the same and takes the first with content. Which slot is
populated is a property of the recording, not of the tenant, so neither is
hardcoded. The response is SRT; it is stored as WebVTT because that is the only
format a `<track>` accepts, and same-origin because a cross-origin track needs
CORS headers Panopto doesn't send.

A transcript is cached exactly like the video, keyed by lecture id, and swept
with it. It is small enough that keeping it would cost nothing — but it is just
as much a copy of something on Panopto, and one rule ("anything fetched back from
Panopto is temporary") is easier to hold than two. The lecture folder stays what
it says on the tin: notes.

The Transcript tab renders each cue as a block carrying its own timestamp, so the
existing sync machinery picks it up with no special case — one cue per group
means the highlight tracks line by line, which is what a transcript is for.
Consecutive cues are merged while they're short: the auto-transcript breaks on
breath rather than on sense, and a wall of two-second fragments is unreadable.
The merged block keeps the *first* cue's time so clicking it still lands where
that sentence began. Panopto's "[Auto-generated transcript…]" disclaimer is
stripped from the first cue — it isn't speech, and left in it burns four seconds
of subtitle over the opening — and the tab says the same thing once, at the top,
where it belongs.

The player controls are segmented groups rather than loose pills: the ones in a
group all answer the same question, and reading as a cluster is what makes that
legible. There are two groups, set apart by a gap — everything on the left is
about how the notes behave and costs nothing to press, and the two on the right
send a question to Google. That gap is the only thing saying so.

**A− / A+ live next to the Subtitles button and only exist while subtitles are
showing.** The right size is not a preference you hold once: it depends on how
wide you have dragged the video, which changes several times in a lecture. Both
press against `player.subtitleSize`, applied immediately and saved half a second
later — it is a control you press three or four times in a row while watching the
result, and one write per press would queue a decision you are still making. The header buttons are borderless until you
reach for them, so a row of them is one group instead of several competing
controls, which is what underlined text links beside a large × had become.

**The subtitles are drawn by the page, not by the browser.** `::cue` looked like
the obvious way to size them and is a dead end: a browser whose caption
preferences have been set — Chrome's `chrome://settings/captions`, or the OS
equivalent — overrides every author `::cue` rule, so A− and A+ moved the number
and changed nothing on screen. The fix is to stop asking. The track runs at
`mode = "hidden"`, which still fires `cuechange` while drawing nothing, and a
`cuechange` handler paints the active cues into a `#player-cues` overlay we own.
Size is then just a font size on an ordinary element: `--cue-px` at 5% of the
frame's height scaled by the setting, recomputed by a `ResizeObserver` on the
frame so dragging the divider or going full screen rescales it. The one thing
this loses is the video element's *own* fullscreen button, where the page's
overlay is behind the picture — so entering that hands the cues back to the
browser and leaving takes them again.

**Offset, on the right of the player bar, is for a recording Panopto trimmed and
a download it didn't.** A few recordings are cut at the front for playback, and
the transcript is cut with them — but the file you can download is the untrimmed
original, so the two clocks disagree by however much was removed: a few seconds
usually, four minutes on a bad one. This is not a subtitle problem. Every
timestamp in the notes and every span in a highlights reel is a transcript time,
so on those lectures a click that should land on a definition lands before it and
a reel plays the wrong minutes throughout.

**Which clock a thing is in is decided by what it was made from**, and that is
worth stating precisely, because guessing it wrong is how this was first built.
The notes are written by a model reading *the downloaded video*, so their
timestamps are in the file's clock — measured on the lecture that prompted all
this, the notes put a quotation at 10:59 that the transcript has at 07:01, and it
is the notes that agree with the picture. The Transcript tab and the subtitles
are in the file's clock too, because `serveCaptions` shifts the WebVTT before
either of them sees it. So everything on screen shares one clock and needs no
conversion at all.

One thing is in the transcript's clock: **the saved reel**, whose spans are
snapped to the cues as Panopto wrote them. That is the one crossing, through
`toVideo`/`toTranscript`. Where you got to is stored in the file's clock, being a
position in a file — the one thing that doesn't move when a transcript is
refetched.

**Everything sent to a model is in the recording's clock**, both features, no
exceptions. That is the clock the notes are already in, so nothing of yours is
rewritten on the way out; it is the clock you are looking at, so a time the model
mentions in prose is a time you can find; and it is one rule to hold rather than
two opposite ones. Explain sends nothing else. Highlights shifts the *transcript*
up to meet the notes and then brings the answer back down before saving it, which
is worth the extra step for what it buys: a reel stored in the transcript's clock
survives the offset being corrected afterwards, where a reel stored in the file's
would be silently wrong by the difference, for good, with nothing on screen to
say so.

The alternative — rebasing the notes down into the transcript's clock — was
built first and is a worse trade for one reason beyond the above: it rewrites the
student's own notes before the model reads them, so a timestamp the model quotes
back is a number that appears nowhere in the file they have.

The first version of this converted the notes as well, on the assumption that a
timestamp is a timestamp. It made every click land four minutes late on exactly
the lectures the offset had been added for, and a screenshot of it went past
unnoticed: the video was on the closing slide while the notes highlighted a
section from four minutes earlier.

The correction is stored per lecture, in `caption_offset`, because it is a
property of how that one recording was cut. It is applied on the way out rather
than written into the cached transcript: that file is Panopto's copy and gets
swept and refetched every session, so an edit in place would be lost by morning.

The control is one number box, sitting clear of the two button groups. It could
have been a stepper with nudge buttons and a "line up from here" — it was, for an
hour — but that is a row of controls for something most lectures never need, and
the bar had room for a box. It takes `90` or `1:30`, applies on change rather than
per keystroke since each change refetches the transcript, and rejects junk by
reverting to what it was: zero is a real setting here, so quietly adopting it
would throw away a correction over a typo. Set, it lights up — an offset you typed
and forgot is a lecture that seeks wrong all afternoon.

**The clock beside it counts in notes time, and shows the total.** Every other
time on screen is in that frame, and the file's own clock is already a few pixels
below in the browser's controls. The total is what makes the fault findable in
the first place: a recording whose transcript stops four minutes before the
picture does is exactly the case this exists for, and you cannot see that from a
clock that only counts up.

**A lecture opens where you left it.** The position is applied from a single
permanent `loadedmetadata` handler holding a pending value, not a one-shot
listener per lecture: a lecture closed before its metadata arrived would leave
its handler attached, and the next lecture would then be seeked to the previous
one's position. Two positions are ignored — the first fifteen seconds, which is
a lecture you opened rather than one you got into, and anything within ten
seconds of the end, where what you want is the beginning again. It says so in a
line of toast, because a video that silently starts in the middle reads as a
bug.

Writes are throttled to one every five seconds while playing and forced on
pause, on end and on teardown — teardown being what records the lecture you are
leaving when you open the next one, since `setupPlayer` tears the old one down
first. Closing the browser outright reaches none of those, so `pagehide` posts
the last position with `fetch(..., { keepalive: true })`; `sendBeacon` can't be
used, as it cannot set the `X-UniNotes` header every mutation requires.

**← and → skip, from anywhere in the player.** The keys are bound to the
document rather than to the video, because the video only has focus if you
clicked it and the thing you were doing before you wanted to hear that again was
reading the notes. Left and right, not up and down: those still have to scroll
the pane. `player.skipSeconds` decides how far, defaulting to 15 — the browser's
own 5 means pressing the key four times to reach a sentence you missed, and how
far back that actually is depends on how fast the lecturer talks. The clock
carries the hint, since a keybinding with nothing on screen is a keybinding
nobody finds.

Two things it deliberately doesn't do. It doesn't turn Following back on, unlike
clicking a note: skipping back is "say that again", not "take me elsewhere", and
if you had scrolled off to read something further down, dragging the pane back is
the opposite of what you asked for. And it stands aside for anything with a
caret — a focused input, textarea or contenteditable keeps its own arrow keys, as
do the two pane dividers, which resize with the same keys and get the event first
by being focused. `defaultPrevented` is the whole arbitration.

**Fetching a video doesn't move you.** Every other job jumps to the Run tab,
because a job started from the Library would otherwise look like it did nothing.
A video fetch is the exception: it is a download you start and then carry on
around, and being thrown onto a progress log loses your place in the list you
were working through. So it stays put, says one line of toast, and the row turns
into "play" on its own when the file lands.

**What comes back from Panopto is cached, not stored.** The player needs a local file, but a
lecture video is the largest thing this tool touches. So a kept recording goes to
`temp/video-cache/`, which is emptied when the control panel starts *and* when it
stops — at both ends, because a hard kill never runs the shutdown path and the
cache is exactly what must not survive one. Notes are permanent, videos are not,
and that is the whole storage story.

Keyed by lecture id in its own directory rather than filed with the notes. A
cached file is a temporary copy of something that lives on Panopto, and putting
it in the lecture folder is what made it look permanent enough to leave lying
around. It also keeps the sweep away from split parts, checkpoints and the lock
file — a twice-a-session delete loop pointed at a configurable path should be
able to reach as little as possible. A video you supplied via `Incoming/` is
archived beside its notes instead and is never swept: it's your file, not a copy.

`player.keep` sends newly processed lectures to the cache; **Fetch video for the
player** downloads one back for a lecture already processed, which is the usual
way in.

### Explain this

A question about the lecture, asked from inside it. Two ways in: the **Explain**
chip in the player bar, which asks about wherever the video has got to, and a
small button that follows a text selection in the notes. Answers land in a dock
below the video and the conversation continues from there.

A third, deliberately separate, control opens the dock and asks nothing. Explain
spends a call the moment you press it, and wanting the panel — to type your own
question, or to re-read the last answer — is not the same as wanting an answer
about right now.

```
┌──────────────────────┬─────────────────┐
│        video         │ Pretty Raw Trans│
│ ──●───────── 16:45   │ ▓[12:04] A data │
├──────────────────────┤ ▓ hazard is …   │
│ Synced Follow Explain│                 │
├──────────────────────┤  ## Branch pred │
│ EXPLAIN        Clear ×│  [18:30] Two-  │
│ A data hazard is when│   bit saturat…  │
│ one instruction needs│                 │
│ ┌──────────────┐ ┌──┐│                 │
│ │ ask a follow…│ │Ask││                 │
└──────────────────────┴─────────────────┘
```

**Below the video, not in the notes.** The notes column is the pane already
negotiating for width; the video pane has slack under its own controls; and a
chat needs a persistent input box, which a fourth tab would hide every time you
switched back to Pretty. Squeezing a video letterboxes gracefully. Squeezing a
paragraph does not.

**Vertex only, and that is a real constraint rather than a preference.** The
`browser` provider drives a Gemini web session through Playwright: one tab, one
PID lock, minutes per answer. That is a fine way to process a lecture overnight
and a hopeless way to answer a question while you are sat paused at 14:32. With
no Cloud project configured the button still appears and the refusal names what
to set, which is more use than a control that quietly isn't there.

**It does not go through `jobs.ts`, and that is the one architectural departure
in the panel.** Jobs run one at a time behind a PID lock and stream to the global
console; asking what a term means must not be blocked by a prettify run, must not
block one, and does not belong in a console shared by every lecture. So
`POST /api/explain` calls Vertex in-process. The costs are paid where they arise:
the shared `vertexLimit` still bounds concurrency, and the call carries its own
timeout because there is no Cancel button behind it.

**The page says where it is; it never says what to send.** Everything the model
sees is read back off disk server-side and capped there — so what leaves the
machine is bounded by settings rather than by whatever a page decided to post.
The conversation is the exception, because a question is by definition the user's
own text, and it is capped per turn and per conversation.

**Finding the right part of the notes turned out to be the whole problem**, and
two things about real notes broke the obvious implementations:

- *Timestamps are not monotonic.* A single back-reference near the end of a file
  ("as we saw at [12:30]") makes "the last line whose time has been reached" the
  bottom of the document, so a question about minute 27 gets answered from minute
  40. The anchor is therefore the stamped line **closest to** the moment without
  overshooting it, not the last one.
- *Sections are not a uniform size.* One is a page on branch prediction; the next
  is two bullets about a drop-in clinic. Sending only the section a moment falls
  in sometimes sends four lines, and a model given four lines correctly reports
  that it hasn't been told enough — which reads as the feature not working. So a
  thin slice grows outwards, a heading-block at a time, until it reaches
  `explain.contextChars`. Blocks rather than whole sections, because the entire
  document sits under one `#` title and "expand to the enclosing section" goes
  from four lines to the whole file in a single step.
- *A heading belongs to what follows it.* An unstamped heading inheriting the
  time of the passage above made it look like part of that passage, which pulled
  the whole of the next section into every slice that ended at one. The player's
  `stampTimes()` already took the other view; the server now agrees.

**The lecture's own overview goes first.** Every other part of the context is a
window a few minutes wide, so without it the model knows what is being said and
not what lecture it is in — and "how does this connect to the rest?" is
unanswerable from a file that says so at the top. The topics and summary come out
of the note's YAML frontmatter, from the pretty file in preference to the raw one
because the prettifier rewrites the summary and its version is the better one.
Read with a twenty-line parser rather than a YAML dependency: this frontmatter is
written by our own pipeline, so a parser that understands only what we emit
cannot be surprised by a construct we never emit.

**The preceding block always comes too**, size budget or no. A lecturer sets
something up and then makes the point, so the sentence that explains a passage is
very often in the passage before it — and growing backwards only when the slice
was too small meant a section big enough on its own arrived with no lead-in at
all. That is precisely the case where the model has plenty to read and still
can't see what any of it follows from.

That setting is an amount, not a choice between "this section" and "the whole
file", for the same reason: a section is not a unit of anything. The whole
document is deliberately *not* a setting — 25 KB with every question is slow,
dear, and buries what you asked about — so it is a button in the panel, armed one
press at a time. Note what it can't do: the material rides in the system
instruction, rebuilt every turn, so a follow-up inherits the model's answer and
not the document behind it. The button stays available rather than locking after
one use, because a conversation that has lost the thing it was about needs a way
to get it back.

A highlighted passage is located by its own `data-t`, not by the video's
position — you read ahead, and being told "that isn't covered at this timestamp"
about a paragraph you just pointed at is the feature failing. Both are pinned by
`scripts/test-explain.ts`, because every one of these failures is silent: the
request succeeds, an answer comes back, and it is about the wrong minute.

The conversation lives in the page and nowhere else. It is posted with each turn
so the server stays stateless, and it is never written to disk: this is a scratch
conversation *about* a lecture, not an artefact *of* one. Closing the drawer ends
it. The lecture material is rebuilt fresh on every turn and sent as a system
instruction rather than wedged into the first message, so a follow-up asked after
you've scrubbed elsewhere is answered about where you are now.

Each answer says what was sent with it. This ships lecture content to Google —
the notes pipeline already does, so it is not a new exposure, but a button that
fires on a text selection makes it easy to send something without having thought
about it, and the settings and the dock both say so plainly.

### Highlights

The lecture cut down to the parts worth watching. One model call reads the
transcript and the raw notes and returns *every* span worth watching, each scored
1–5; the player then plays those spans back to back and skips the rest. Nothing
is re-encoded — a reel is a list of times.

**Three reels, three calls.** Skim, Highlights and Deep are each built by their
own request, for their own shape — many very short cuts, a middle, and many
longer ones — and saved separately, so a lecture can have one, two or all three.
Pressing a preset that exists switches to it, free and instant; pressing one that
doesn't spends a call on that preset alone.

It was built the other way first: one pass scored every span 1–5 and the three
presets cut those candidates locally, which made switching free. That was the
wrong trade, and the measurement showed it. A reel built to be cut three ways is
built for none of them — what came back was five spans of two to four minutes
each, which suited nothing. A skim and a deep pass are different editing jobs,
not two lengths of the same one.

Each preset is a **share** of the lecture, a **cut length** and a **cut count**:
12% in 10-second cuts about 35 times, 25% in 15s about 50 times, 45% in 25s about
60 times. The share adapts where a number of minutes cannot — ten minutes is most
of a 25-minute lab and nothing of a two-hour lecture. The count reaches the model
explicitly, since "cut often" is advice a model can satisfy with twenty spans and
"around fifty" is not.

**The count is what the arithmetic is held up against** when share ÷ cut length
would ask for fewer. Forty cuts still watches like a summary; what makes a
keynote recap feel like one is the sheer number of times it cuts. It is a
recommendation rather than a quota — somewhat fewer or somewhat more is fine, and
only a reel well short of it earns a second pass — but where it binds, the cut
length is derived back from it rather than left contradicting it, clamped to the
preset's own band so it can't turn Deep into Skim.

The share is a soft ceiling, not a quota. It is enforced at 1.5×, and both
coverage and the cut count outrank it: a lecture with more in it than usual
should give a longer reel rather than a thinner one, a percentage is never worth
a hole in the story, and trimming may not undo the count that was asked for.

**The count is per-preset because it is the only lever that changes a reel's
length.** One shared floor of fifty was tried first, and on the 44-minute lecture
all three came out between 13 and 25 minutes — because fifty cuts of a length
anyone can follow *is* thirteen to twenty-five minutes, whatever share it was
given. They differed by the character of the cut, not by how long they ran, which
is not what someone choosing Skim over Deep is choosing. Thirty-five against
fifty against sixty is that choice, and measured on the same lecture it gives
9:09, 19:36 and 26:19, none of them with a hole in it.

Two things that measurement settled, both against what the arithmetic assumed.
**Cut length has a floor the model will not go under**: spans snap to cue
boundaries, cues run about six and a half seconds, and nothing comes back shorter
than two of them — a Skim asked for 9-second cuts returned a median of 16. And
because of that, **the count is what a reel is actually held to, not the share**.
Every build now overshoots its share, comes back with more spans than asked after
the second pass, and is trimmed weakest-first down to exactly its count. The
share survives as the ceiling that decides how much of what the model offers is
kept.

**No run-up before a span.** `leadInSeconds` was 2, by analogy with the lead-in a
click in the notes gets. The analogy was wrong, and it took watching a reel to
see it. Clicking a note is a jump into a lecture that carries on playing, so two
seconds of run-up costs nothing; a reel is a cut, and it pays those two seconds
every time it cuts. At fifty cuts that is a minute and a half of run-ups, each one
the tail of something you were not meant to hear. Snapping the start back to a cue
boundary is what stops a cut landing mid-word, and it was always doing the work
the lead-in was credited with. It stays as a setting, at zero.

**The transcript shows both ends of a block.** It used to print only the start —
`[12:30] the words` — while the prompt required every time the model gave to be
one that appeared in the transcript. Those two rules together made it impossible
to say "up to the end of this": the only times available were starts, so an end
was either the next block's start, a few seconds past the words meant to be
kept, or the wanted block's own start, a few seconds short of them. A systematic
bias towards cutting people off, produced by a formatting decision. Labels are
now `[12:30–12:41]`, which costs about 2.7k characters on a 44-minute lecture,
and the ends are the times the brief asks spans to close on.

It also makes the silence visible, which is the more interesting half. Measured
on the ENGGEN 403 transcript: **no** cue runs straight into the next — all 407
have a gap before them, up to 6.5 seconds. Those gaps are pauses, and a cut that
lands in one is inaudible, so the prompt now asks the model to prefer a boundary
with silence after it. That is inference the model can actually do, because the
numbers are finally in front of it.

**Nothing enforces a preset's cut length any more.** Each reel's `maxSeconds` is
in the brief and nowhere else; `maxSegmentSeconds` is a single backstop against
one span swallowing the lecture. Cutting a span back to a per-preset ceiling
overruled the model precisely where it mattered — a long span is long because
something was still being explained, and the cap landed in the middle of it.
The preset's `minSeconds` likewise no longer floors what the model may choose:
the ten seconds where the number is said is the point of a reel, not an error to
round away. Same reasoning for the share, which is now allowed to overrun by
`overrunAllowance` before anything is dropped: a reel that covers the lecture at
40% beats one cut to 25% by deleting its weakest third.

**Spans with nothing between them are one span.** `joinGapSeconds` joins spans
that touch or nearly touch, keeping both reasons and the stronger weight. The
old rule refused to merge, on the grounds that a merged span inherits a reason
describing half of itself — true, and the answer is to carry both halves rather
than leave the cut broken in two. The prompt asks for it as well, and that is
the better half of the fix: three timestamps in a row with a second between them
are not three cuts, because nothing is being cut, and a model producing them is
thinking in claims rather than in cuts. The prompt used to *ask* for that —
"prefer two short spans over one long one, always" — which is where the
behaviour came from.

**A span finishes its sentence.** `finishSentenceSeconds` carries an end forward
to the next full stop within the allowance. A cue boundary is a breath, not a
sentence, so snapping to one still ends on "and the reason for that is—". The
transcript is punctuated, so the real boundary is available to the code, which
is why this is not something the model has to be trusted to get right.

**But a run-out after one.** `tailSeconds` is 2, and the asymmetry is the point.
A span ends on a cue boundary, and a cue's end is where the transcriber stopped
writing rather than where the speaker stopped talking — measured on a real reel
the cut took the last word or two off, by almost exactly two seconds, every
time. So the run-up buys the tail of something you were not meant to hear and
the run-out buys the end of the sentence you were. It is added last of all:
after the preset's ceiling, which would otherwise cap it away on exactly the
spans most likely to be cut mid-sentence, and after the pass that resolves
overlaps by dropping a span, which would delete a span for reaching a second
into its neighbour rather than shorten it. Then it is clamped to wherever the
next span starts, so where two spans already abut it comes to nothing — playback
is continuous across that join and nothing was being clipped there. It is baked
into the stored cut, so changing it applies to reels built from then on.

**Two buttons, not one that means two things.** Highlights plays the reel and
stops it; the button beside it opens and closes the panel. That is the second
arrangement — the first had a single button whose meaning depended on whether a
reel happened to exist, which opened a panel when there was nothing built and
started the video jumping when there was.

The bar's right-hand end is now two groups of two, one per feature: the thing
itself, then the panel behind it. **The two panel buttons carry the same icon on
purpose.** It is one gesture meaning "show me this", and which panel it shows is
said by the group it sits in, not by a second picture to learn. Each reports
whether *its* panel is the one showing rather than merely that the dock is open,
which had Explain looking pressed while you were reading the reel.

Playing and showing are independent: closing the panel does not stop the reel,
and the Highlights button stays lit while it steers, because that is the fact
that explains why the video keeps moving and it has to read from wherever you
are.

**The reel is saved beside the notes**, as `highlights.json` in the lecture's own
folder. That is load-bearing rather than an optimisation: the transcript it was
built from lives in the video cache, which is emptied every time the panel starts
*and* stops, so an unsaved reel would die with the session that made it and cost
another call the next morning.

**The notes decide, the transcript times.** The two inputs do different jobs and
the prompt says so at the top. The notes were written from this recording and
already name what mattered in it — they are the list of things to look for. The
transcript is where each of those was said, and the only source of times. Working
from our own notes rather than from the model's idea of the subject is the same
anti-invention principle the notes prompts are built on.

**Why the times can be trusted.** The model may only name times that appear in
the transcript it was given, and every boundary is snapped back to a real cue in
`src/gui/highlights.ts` — a start to the cue covering it, an end to the end of
its cue. A model that invents 07:41 gets the cue that actually starts at 07:38,
so a span cannot open mid-word. The transcript is sent as five-second paragraphs
rather than as breath-length cues: the merge sets the finest boundary the model
can name, so it has to stay well under the length of the spans being chosen.
Everything else is validated too — inside the recording, within the preset's own
ceiling, longer than the floor, in order, non-overlapping — and an overlap keeps
the stronger span rather than merging, because a merged span would carry a reason
describing only half of itself.

**A second pass, when the first one was thin.** Three things are measured against
the brief once the answer is cleaned: the span count, the average length, and —
the one that matters most — whether any stretch of the lecture longer than three
minutes goes unmentioned. If any of them is off, the model gets one editor's
note, in the same conversation, carrying its own numbers and the *specific*
timestamps it skipped. "Cover the whole lecture" is advice a model can believe it
has followed while leaving a six-minute hole where the willingness-to-pay
methodology was; "nothing between 20:37 and 26:57 — go and read it" is not. The
revision is kept only if it has more cuts or fewer holes than what it replaced.
Once, not until satisfied: each pass costs a call, and a model that ignores the
note twice will not yield on the third.

Measured on a 44-minute policy lecture, that pass took Skim from 16 cuts with
five holes to 24 with none, and Deep from 31 to 49. On a 78-minute technical
lecture it gave 63 cuts over 29 minutes with exactly one stretch left out — seven
minutes of "thank you, see you Friday" and questions about lab groups, which is
the right thing to leave out and what the note tells it to do when the gap turns
out to be admin.

**Two failures found by running it, not by reading it.** The token budget covers
*thinking* as well as output, and at level high the thinking alone ran to 31k of a
32k budget — so the JSON came back cut off mid-array and the build failed
outright. The budget is now the model's maximum, and a truncated array is
salvaged up to its last complete object rather than thrown away, because forty
good spans followed by half of a forty-first is still forty good spans. Separately,
the Schedule tab bound `document.querySelectorAll("[data-preset]")` across the
whole page, so choosing Skim also tried to schedule a pipeline run at "sk:im";
that selector is now scoped to its own tab and the reel buttons use `data-reel`.

`scripts/test-highlights.ts` pins all of it, since every one of these failures is
silent.

**It lives in the dock, not in a notes tab.** A fourth notes tab was the first
instinct and it is wrong: the notes pane is the one thing that has to stay
visible while the reel plays, and a contents page you can only read by hiding the
lecture is not a contents page. So the dock under the video gained a tab strip.
The two tabs answer different questions — Explain answers *what does this mean*,
Highlights answers *where should I be looking* — and keep different things: the
conversation is thrown away when the drawer closes, the reel is on disk.

**The button never builds.** With a reel it plays it; without one it opens the
panel and stops. Building is the expensive irreversible thing here, so the press
that starts it is a named preset — Skim, Highlights or Deep — and not a generic
button that picks for you. Each shows what it will cost before you press it: a
run time and a cut count once built, a dashed border and its target share
before. Building runs in the background with a line of toast, because thinking at
level high over a whole transcript takes a minute or two and the thing it would
block is a lecture you can watch meanwhile.

Highlights sits past the gap in the player bar, with Explain — that gap means
"these send something to Google", and this sends the most of anything here.

A **reel bar** under the video, drawing the spans against the whole lecture, was
built and then taken out: the panel's list already says which cuts exist and
which one is playing, and a second view of the same thing under the video is
furniture.

**Taking over, and what counts as taking over.** Playback advances when a span
*ends*. A seek that isn't ours turns the steering off — the same convention as
scrolling turning Following off — with one exception: a seek that lands *inside*
a chosen span keeps the reel on and re-lands the index. The arrow keys exist to
nudge past a slow explanation, and killing the reel for that would make the two
features fight.

### Tab 3 — Settings

Rendered from a schema (`src/settings/schema.ts`) rather than hand-written HTML, so
adding a setting is one array entry and it gets a form control, validation and
persistence for free.

**Every group starts collapsed.** Eleven groups is a wall to scroll past when you
came to change one thing, and the group names are a better index than the fields
are. A group with an unsaved change opens itself — a change you can't see is
worse than a long page. Which groups you have open is session-only: where you
were up to in a form is not a fact about your notes pipeline.

**Reset is per group, on the heading row.** Putting one group back is what you
actually want after experimenting, and it is a far smaller commitment than the
page-wide reset at the bottom. It drops those keys from `settings.json` rather
than writing the defaults into it: a setting whose override *is* the default is
still an override, and would go stale the day the default changes.

There is no longer a per-setting "changed from default" badge. Once anything was
configured it marked most of the page, which made it noise rather than
information — and the thing it was really for, putting a group back, is the Reset
link. "unsaved" stays, because that one is about work you might lose.

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
