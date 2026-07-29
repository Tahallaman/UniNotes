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
│ ☐ │ Lecture                     │ Course      │ Status   │ Notes  │Video│Wk│ ✓ │
│ ☐ │ L04 – Te Tiriti o Waitangi  │ CAPSTONE750 │ complete │ raw prt │play │ 3│ ☑ │
│ ☑ │ L01 – Computer Architecture │ COMPSYS 730 │ complete │ raw ·   │fetch│ 1│ ☐ │
│ ☐ │ Meeting week 8              │ SOFTENG 700 │ error    │ · ·     │  —  │ —│ ☐ │
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

The last column is a **Watched** tick you set yourself. It is stored on the lecture
row and is the one thing in the library the pipeline never writes — so it does not
bump `updated_at`, which would otherwise reorder the list every time you ticked one.
Folders with no database row have nowhere to keep it and show a dash instead.

**Wk** is derived, never stored. A week is a view of a date through a term whose
start date you can edit; storing it would mean correcting a term silently left
every lecture filed where it already was. The cell's tooltip carries the date and
where it came from, because "week 8" being wrong is a question about the date.

### Terms, weeks and naming

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

The three player controls are one segmented group rather than three loose pills:
they all answer the same question — how the notes behave — and reading as a
cluster is what makes that legible. The header buttons are borderless until you
reach for them, so a row of them is one group instead of several competing
controls, which is what underlined text links beside a large × had become.

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
