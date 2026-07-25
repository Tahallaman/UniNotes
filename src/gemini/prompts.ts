import { CONFIG } from "../../config.js";

/**
 * The two halves of a notes prompt a user is allowed to rewrite, from
 * CONFIG.prompts (defaults in prompts/notes-*.txt, overridable in Settings).
 *
 * `grounding` is the preamble that forces Gemini to watch the video and ground
 * its notes in this recording rather than in what it already knows about the
 * topic — for a named course it can recite a plausible syllabus fluently and
 * wrongly. `coverage` is what the notes should contain and in what style.
 *
 * Everything else below stays in code: TIMESTAMP_FORMAT is rebased by
 * src/utils/timestamps.ts and the JSON-ACTIONS block is read by
 * src/notes/parser.ts, so an edit to either would break parsing silently.
 */
const grounding = (): string => CONFIG.prompts.grounding;
const coverage = (): string => CONFIG.prompts.coverage;

/**
 * Pins the timestamp format so timestamps can be rebased mechanically.
 *
 * Segments are uploaded as standalone videos, so the model always numbers from
 * 00:00 regardless of where the segment sits in the lecture. Rather than ask it
 * to add its own offset — arithmetic it can get wrong invisibly — we require a
 * single unambiguous format and let src/utils/timestamps.ts do the shifting.
 */
const TIMESTAMP_FORMAT = `## Timestamps — required

Timestamps are the point of these notes: they are what lets a reader jump back to
the moment in the recording. Notes without them are much less useful, so treat
this as a hard requirement rather than a nicety.

1. EVERY section heading you write must begin with a timestamp in square brackets.
2. Add a timestamp to any individual definition, quote, example or demo worth
   returning to.
3. Use [MM:SS], or [H:MM:SS] only once past an hour. Always two-digit minutes.
4. Measure from the START OF THIS VIDEO (00:00). Do NOT add an offset for earlier
   segments — that is applied automatically afterwards.
5. If a stretch of video has no content worth noting, still say so with the range
   it covers, e.g. "[04:10] Nothing on screen until [09:30]."

Shape to follow:

### [00:41] Dispatch and the ready list
- **Ready list** — the queue of tasks eligible to run.
- [01:05] "The dispatcher never decides *which* task, only *when*" — lecturer.
- [02:40] Diagram: per-core ready lists feeding a single dispatcher.

Never write a heading without its timestamp.`;

/**
 * Build the prompt for a non-final segment of a multi-part lecture video.
 * Asks for study notes only — no json-actions (those come with the final part).
 */
export function buildPromptMiddlePart(
  lectureTitle: string,
  courseCode: string,
  partNum: number,
  totalParts: number,
): string {
  return `${grounding()}

This is part ${partNum} of ${totalParts} of a lecture video. The lecture is titled "${lectureTitle}" from ${courseCode}.

Write comprehensive Markdown study notes covering everything in this segment:

${coverage()}

${TIMESTAMP_FORMAT}

More segments of this lecture will follow. Write notes for this segment only.`;
}

/**
 * Build the prompt for the final segment of a multi-part lecture video.
 * Asks for notes on this segment plus a json-actions summary for the whole lecture.
 */
export function buildPromptFinalPart(
  lectureTitle: string,
  courseCode: string,
  partNum: number,
  totalParts: number,
): string {
  return `${grounding()}

This is the FINAL part (${partNum} of ${totalParts}) of the lecture "${lectureTitle}" from ${courseCode}.

Please provide TWO parts in your response:

## PART 1: Study Notes for This Segment

Write comprehensive Markdown study notes for this final segment, continuing from where previous parts left off:

${coverage()}

${TIMESTAMP_FORMAT}

## PART 2: Structured Data for the Complete Lecture

After your notes, include EXACTLY this block (delimiters on their own lines) summarising the ENTIRE lecture (all ${totalParts} parts):

---JSON-ACTIONS-START---
{
  "summary": "A 2-3 sentence summary of the entire lecture (all parts)",
  "actionItems": ["concrete tasks the student should do after watching this lecture"],
  "keyTopics": ["main", "topic", "keywords", "from", "all", "parts"],
  "lectureDate": "YYYY-MM-DD or null if not mentioned"
}
---JSON-ACTIONS-END---

IMPORTANT:
- The ---JSON-ACTIONS-START--- / ---JSON-ACTIONS-END--- block must be the LAST thing in your response
- Do not include any other such blocks`;
}

/**
 * Build the prompt sent to Gemini after uploading a single (unsplit) lecture video.
 */
export function buildPrompt(lectureTitle: string, courseCode: string): string {
  return `${grounding()}

This lecture video is titled "${lectureTitle}" from ${courseCode}.

Please provide TWO parts in your response:

## PART 1: Comprehensive Study Notes

Write extensive Markdown study notes covering everything the lecturer actually discusses. This is the whole recording rather than a segment of one, so open with a title and an overview of the topics it covers, then cover:

${coverage()}

${TIMESTAMP_FORMAT}

## PART 2: Structured Data

After your study notes, include EXACTLY this block (delimiters on their own lines):

---JSON-ACTIONS-START---
{
  "summary": "A 2-3 sentence summary of the entire lecture",
  "actionItems": ["concrete tasks the student should do after watching this lecture"],
  "keyTopics": ["main", "topic", "keywords"],
  "lectureDate": "YYYY-MM-DD or null if not mentioned"
}
---JSON-ACTIONS-END---

IMPORTANT:
- The ---JSON-ACTIONS-START--- / ---JSON-ACTIONS-END--- block must be the LAST thing in your response
- Do not include any other such blocks`;
}
