/**
 * Reading a lecture's number out of its title.
 *
 * Panopto titles arrive in whatever shape the department typed them:
 *
 *   ENGGEN 403 [21 July] Lecture 1 What can ENGGEN 403 do for me
 *   SOFTENG 753 - Tue 21 Jul - Introduction & What is Deep Learning
 *   [423-348] SOFTENG 761 L01CSOFTENG 761 L02C - Mon 20 Jul 0200 PM (NZT)
 *
 * Filed under those names, a course folder sorts by whichever of a Panopto
 * folder ID, a course code or a weekday the title happens to start with — three
 * orderings, none of them the order the lectures were given in. A `{number}`
 * token in a naming template fixes that, and this is where the number comes
 * from when the title states one.
 *
 * What is no longer here: this module used to build filenames and carry its own
 * on/off setting. Naming belongs to src/notes/organise.ts — one template
 * system, one live preview, one place a destination is decided — so what
 * survived is the part organise can't do for itself. Reading a number out of
 * prose is that part; ordering the lectures that state none is
 * assignLectureNumbers(), which has resolved dates to hand and doesn't need to
 * guess from file mtimes.
 *
 * Deliberately imports nothing. organise.ts is loaded by the settings schema,
 * which config.ts loads, so anything reaching CONFIG from here would close a
 * cycle.
 */

/** "Lecture 3", "Lecture 03", "Lec 3" — how a title usually says it in words. */
const WORD_FORM = /\b(?:lectures?|lect|lec)\.?\s*0*(\d{1,2})\b/gi;

/**
 * Panopto's own form: L01, L02C, L10.
 *
 * Two digits are required deliberately. A one-digit rule would read "L2
 * Regularisation" as lecture 2 and "L1 cache" as lecture 1, and a lecture titled
 * after a concept is far more common than one numbered "L1".
 */
const CODE_FORM = /\bL0*(\d{2})[A-Z]?/g;

/**
 * The lecture number a title states, or null when it states none.
 *
 * The word form wins over the code form: a title carrying both ("Lecture 2" in
 * a folder called L02C) states the same number twice, and where they disagree
 * the prose is the one a human wrote on purpose.
 */
export function parseLectureNumber(title: string): number | null {
  const word = firstMatch(title, WORD_FORM);
  if (word !== null) return word;
  return firstMatch(title, CODE_FORM);
}

function firstMatch(title: string, pattern: RegExp): number | null {
  // Fresh regex per call: the module-level patterns are /g and carry lastIndex.
  const re = new RegExp(pattern.source, pattern.flags);
  const m = re.exec(title);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}
