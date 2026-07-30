# Lecture Highlights — a proposal

*Status: built, and this is the record of why it looks like it does. The code is
`src/gui/highlights.ts`, `prompts/highlights.txt` and the Highlights section of
`web/app.js`; `docs/gui-design.md` describes what it does now. Kept because the
arguments here — the two-rule presets, why the reel is saved, why it is not a
notes tab — are the ones that would otherwise be re-litigated from scratch.*

## What it is

A lecture is fifty minutes long and about twelve of them are worth watching. The
notes already tell you what was said; what they can't give you is the two minutes
where the lecturer draws the thing on the board and it finally makes sense. This
feature finds those minutes and plays only them.

Concretely: one model call reads the lecture's transcript and raw notes and
returns a set of time ranges — "the meat" — each with a line saying why it's
there. The player then plays those ranges back to back, skipping the gaps. No new
video file is produced and nothing is re-encoded; the player simply seeks past
what wasn't chosen.

The result is a **reel**: a 50-minute lecture watched in 10, with the notes
scrolling alongside as they already do.

## Why it belongs here

This is the tool's own thesis applied to the video. Everything else here exists to
get you past the fluff — blank-segment skipping, the pretty prompt's insistence on
timestamps, click-to-seek. Highlights is the same idea pointed at the recording
itself, and it uses machinery that already exists: Explain's Vertex path, the
transcript cache, the timestamp sync, the player's seek.

## The shape of it

### One call, many reels

The model is not asked for "ten minutes of lecture". It is asked for **every span
worth watching, each scored 1–5 for importance** — typically two or three times
more material than you want.

What you actually watch is then chosen locally, and the three presets are the
choosing:

| | Takes | No longer than |
| --- | --- | --- |
| **Skim** | only the 5s | 10% of the lecture |
| **Highlights** | 4 and up | 25% |
| **Deep** | 3 and up | 45% |

Two rules, not one, and the pairing is the point. The **share** adapts where a
fixed number of minutes cannot: ten minutes is most of a 25-minute lab and
nothing of a two-hour lecture. The **quality floor** is what stops a preset
padding itself out to fill its share — a lecture that was mostly admin yields a
two-minute Deep, because there were only two minutes' worth, and that is the
correct answer rather than a failure.

So the share is a ceiling, never a quota. Nothing is ever included to reach it.

This split matters more than it looks:

- Switching preset is instant, offline and free. No second call.
- A skim and a deep pass come from the same call.
- The expensive judgement (*what is worth watching*) is separated from the cheap
  one (*how long have I got*), and only the expensive one goes to a model.
- No number is ever typed. The presets are the whole interface to duration.

### It is saved

The reel is written beside the lecture's notes, as one file per lecture, holding
every candidate segment with its score and reason, plus what produced it (model,
settings, date).

Saving is not an optimisation, it's load-bearing. **The transcript lives in the
video cache, which is emptied every time the panel starts and stops.** If the reel
weren't saved it would die with the session that made it, and you'd pay for it
again every time. Saved beside the notes, it outlives the video, exports with the
lecture, and can be read by a human when you want to know what the model thought
without watching anything.

It also means a reel can be regenerated deliberately — a button, not a
side-effect — when the notes have been reprocessed or the prompt has improved.

### The button

One **Highlights** button in the player bar, on the far side of the gap, with the
two Explain buttons. That gap already means something exact: everything left of it
costs nothing to press, everything right of it sends something to Google.
Highlights belongs on the right by that rule, and it is thereby set apart from the
notes-behaviour buttons without inventing a third group in a small bar.

The first press builds the reel; every press after that turns it on and off. The
label says which it is about to do.

**Building does not block anything.** At thinking level high over a full
transcript this is the better part of a minute, so the press gets a line of toast
and you carry on watching — the same treatment fetching a video gets. The reel
appears when it lands.

### Watching it

- A slim **reel bar** under the video: the whole lecture as a strip, chosen
  segments as blocks, the current one lit. It is honest about what you're
  skipping — you can see the 40 minutes that aren't there — and clicking a block
  jumps to it. Without this the reel is invisible magic, and you can't tell one
  that covered the lecture from one that quietly dropped the second half.
- One line naming why the current segment was chosen. "Derives the two-bit
  saturating counter" is worth reading; "important concept" is not, and the
  prompt is written to make the difference.
- Playback advances when a segment *ends*. Seeking away by hand turns Highlights
  off, exactly as scrolling the notes turns Following off — you took over, and the
  tool should stop steering.
- The notes follow as they always do. In the gaps you skipped, the notes skip too,
  which is a surprisingly good way to see the shape of a lecture.

### Reading it — the dock becomes two tabs

The panel under the video gains a tab strip: **Explain | Highlights**. The reel's
list lives in the second one.

A fourth *notes* tab was the first instinct and it is wrong, for a reason that
settles it: the notes pane is the one thing that has to stay visible while the
reel plays. A contents page you can only read by hiding the lecture is not a
contents page. The dock is already below the video, already resizable by its own
divider, and its own reasoning for being there — the notes column is the pane
fighting for width, the video pane has slack — applies to a list of timestamps
exactly as it did to a chat.

The two tabs keep different things, and that is fine as long as it is said once:
the panel belongs to the lecture you have open, the conversation is thrown away
when you close it, the reel is saved. They answer different questions too —
Explain answers *what does this mean*, Highlights answers *where should I be
looking* — which is what makes them tabs rather than one merged surface.

One thing this costs, worth naming rather than discovering: the dock only exists
in the player, so the reel is readable only with a video open. The notes-tab
version would have given a contents page for a lecture you weren't watching. That
is a fair price for the notes staying on screen, and the saved file is plain JSON
in the lecture's own folder for anyone who wants it without the panel.

### Steering it

The Highlights tab holds three buttons — **Skim**, **Highlights**, **Deep** — and
one input box.

The three are free. They re-pick from candidates already saved, so switching
between them is instant and offline; the model is not consulted again. The input
box is the costed one: a text instruction like "more on the queueing theory, skip
the live demo" is a second call over the same transcript, producing a new set of
candidates that the three buttons then cut as before.

## Getting the selection right

This is the whole feature. A reel that misses the derivation is worse than no reel,
because you'll trust it. The prompt has to be built for that.

### What goes in

The transcript and the raw notes, both, because they fail in opposite directions.
The transcript has every word and exact times but no judgement — it can't tell a
worked example from a digression. The raw notes have judgement and structure but
thinned timestamps. Together, the model can find the meat in the notes and pin it
to real times in the transcript.

**Every boundary must be a timestamp that exists in the transcript.** The model
picks cue boundaries; it never invents a time. This is the single rule that keeps
segments from starting mid-word or drifting thirty seconds off.

Where there is no transcript, the raw notes' own timestamps can carry it alone,
with rougher edges and a warning that says so. Degrade, don't refuse.

### What counts as meat

Keep:

- Where an idea is *built* — a derivation, a proof, a diagram drawn while talking.
- Worked examples, especially ones with a wrong turn corrected.
- The lecturer saying what something is *for*, or why the obvious approach fails.
- Anything flagged: "this is examinable", "people always get this wrong".
- A correction to something said earlier.

Cut:

- Admin, deadlines, room changes — these belong in the notes, not in your ears.
- Reading a slide aloud, when the notes already carry the slide.
- Recaps of last week, and recaps of the last ten minutes.
- Anecdotes and tangents, however good.
- Dead air, setup, waiting for people to arrive.
- Questions from the room whose answer repeats what was already said. A question
  that gets a *new* answer is meat.

### The shape of a segment

- Starts where a thought begins, ends where it finishes. Not a sentence, not a
  slide.
- Starts a few seconds early, for the run-up — the same reasoning as the click
  lead-in already in the player.
- Roughly 45 seconds to 4 minutes. Under about 25 seconds it isn't a segment, it's
  a jump cut, and a reel of those is unwatchable.
- Coverage matters: the reel follows the lecture's arc rather than pooling in the
  first ten minutes, so a lecture's sections each get their due if they've earned
  it.

### Model settings

`gemini-3.6-flash`, thinking level **high**. This is a judgement task over a long
document and it happens once per lecture, so latency is worth spending — the
opposite trade to Explain, which is Flash on minimal thinking because you are
sitting there waiting for a definition.

Everything is validated before it is trusted: times parse, ranges are inside the
video, overlaps merge, too-short fragments are dropped, order is enforced. A model
that returns nonsense produces "couldn't build a reel", never a broken player.

## What this is not

- **Not a summary.** The pretty notes are the summary. This is the recording, cut.
- **Not a new video file.** Nothing is re-encoded. The reel is a list of times.
- **Not automatic.** It costs a call; you ask for it, per lecture. Doing a whole
  course in one go is a job for later, and would belong in the Run tab.
- **Not a replacement for watching.** It's for the second pass — the lecture you
  half-attended, the one you're revising, the one you missed.

## How we'd know it worked

Beyond the mechanical checks: generate reels for three real lectures of different
shapes — a dense technical one, a discussion-heavy one, a mostly-admin one — and
watch each. The questions are whether every segment starts somewhere sensible,
whether the arc is covered, and whether anything in the pretty notes' summary has
no segment behind it. The mostly-admin lecture is the interesting case: the right
answer there is a short reel even on Deep, and a selection that pads itself out to
its full share has failed.

## Settled

- **Nothing in the Library.** No column, no per-row action. It is a thing you do
  while watching a lecture, from the player.
- **Never automatic.** Building a reel is a press, per lecture. Opening a lecture
  that already has one starts as ordinary playback: you opened a lecture, not a
  summary of it.
- **The button sits with Explain**, past the gap, and building runs in the
  background.
- **The list lives in the dock**, which becomes Explain | Highlights, so the
  notes stay on screen while the reel plays.
- **Three named presets**, not a duration you type.
- **Duration is a share of the lecture, not a number of minutes**, and it is a
  ceiling rather than a quota.

## Settings it would add

- On/off, like Explain — and the same caution, since the transcript goes to
  Google.
- The three presets' shares and their importance floors. Six numbers, but they
  are the tuning surface for the whole feature, and nobody has to touch them.
- Shortest allowed segment.
- Model and thinking level, defaulting to `gemini-3.6-flash` at high.
- A cap on how much text may be sent, so what leaves the machine stays bounded.
