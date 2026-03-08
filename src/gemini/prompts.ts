/**
 * Preamble added to every prompt that forces Gemini to watch the video
 * and ground its notes in actual content rather than training-data knowledge.
 */
const VIDEO_GROUNDING_PREAMBLE = `Watch the lecture video I have shared with you from beginning to end before writing anything.

Your notes must be grounded exclusively in what the lecturer actually says and shows in this specific recording:
- Quote the lecturer directly for important definitions or memorable statements
- Describe actual examples, demos, or diagrams as they appear on screen
- Do NOT include any information that was not explicitly covered in this video — no additions from outside knowledge`;

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
  return `${VIDEO_GROUNDING_PREAMBLE}

This is part ${partNum} of ${totalParts} of a lecture video. The lecture is titled "${lectureTitle}" from ${courseCode}.

Write comprehensive Markdown study notes covering everything in this segment:

- All concepts the lecturer explains, with their exact wording where notable
- Definitions, theorems, formulas, or frameworks as stated by the lecturer
- All examples and demonstrations shown, described concretely
- Any diagrams or slides (represent as text/ASCII)
- Timestamps for each major topic shift

Use proper Markdown: headings (##, ###), bullet points, bold for key terms, code blocks where appropriate.

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
  return `${VIDEO_GROUNDING_PREAMBLE}

This is the FINAL part (${partNum} of ${totalParts}) of the lecture "${lectureTitle}" from ${courseCode}.

Please provide TWO parts in your response:

## PART 1: Study Notes for This Segment

Write comprehensive Markdown study notes for this final segment, continuing from where previous parts left off:

- All concepts the lecturer explains in this segment, with timestamps
- Definitions, formulas, or frameworks as stated by the lecturer
- All examples and demonstrations, described concretely
- Any diagrams or slides (represent as text/ASCII)
- Direct quotes for important statements

Use proper Markdown: headings (##, ###), bullet points, bold for key terms, code blocks where appropriate.

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
  return `${VIDEO_GROUNDING_PREAMBLE}

This lecture video is titled "${lectureTitle}" from ${courseCode}.

Please provide TWO parts in your response:

## PART 1: Comprehensive Study Notes

Write extensive Markdown study notes covering everything the lecturer actually discusses:

- A title and overview of the topics covered in this specific recording
- All concepts explained, with timestamps and the lecturer's exact wording where notable
- Definitions, theorems, formulas, or frameworks as stated by the lecturer
- All examples and demonstrations shown, described concretely
- Any diagrams or slides (represent as text/ASCII)
- Direct quotes for important or memorable statements

Use proper Markdown: headings (##, ###), bullet points, bold for key terms, code blocks where appropriate.

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
