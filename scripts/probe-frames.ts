/**
 * Does the player put a time in the right clock?
 *
 * A lecture has two clocks whenever Panopto trimmed the front of a recording and
 * the download kept it. Almost everything is in the file's — the video, the
 * notes, the Transcript tab, the subtitles — and exactly two things are in the
 * transcript's: the saved reel, and the position Explain sends. Getting that
 * backwards is not a crash. It is every click landing a few minutes late, which
 * looks like the model having written bad timestamps, and it survived a
 * screenshot of it happening.
 *
 * So: drive the real panel, set an offset, and check where things actually land.
 *
 * A probe rather than a test, for the reason the other probe-*.ts scripts are:
 * it needs the panel running and a lecture with a video and a transcript in the
 * cache. It sets an offset on that lecture and puts back whatever it found.
 *
 *   npx tsx scripts/gui.ts --no-open        (in another terminal)
 *   npx tsx scripts/probe-frames.ts
 */

import { chromium } from "playwright";

const PANEL = "http://127.0.0.1:4571";
/** Big enough that a mistake can't hide inside a rounding error. */
const OFFSET = 230;

interface Entry {
  key: string;
  title: string;
  hasVideo: boolean;
  hasCaptions: boolean;
  captionOffset: number;
  id: string | null;
}

async function main(): Promise<void> {
  const fails: string[] = [];
  const check = (name: string, ok: boolean, detail = ""): void => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
    if (!ok) fails.push(name);
  };

  const library = await fetch(`${PANEL}/api/library`).then((r) => r.json()) as { entries: Entry[] };
  const entry = library.entries.find((e) => e.hasVideo && e.hasCaptions && e.id);
  if (!entry) {
    console.log("No lecture with both a video and a transcript in the cache — fetch one first.");
    process.exit(1);
  }
  console.log(`Lecture: ${entry.title}\nOffset it had: ${entry.captionOffset}s\n`);
  const restore = entry.captionOffset;

  const browser = await chromium.launch();
  const page = await browser.newPage();
  // tsx compiles with esbuild's keepNames, which wraps functions in a `__name`
  // helper. That helper exists in this file's module scope, not in the page, so
  // any evaluated callback holding an inner function dies on arrival without it.
  await page.addInitScript("globalThis.__name = globalThis.__name || ((fn) => fn);");
  // Not networkidle: the panel holds an SSE stream open for its status line, so
  // the network is never idle and never will be.
  await page.goto(PANEL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("nav button");

  await page.evaluate(() => {
    const tab = [...document.querySelectorAll("nav button, [role=tab]")]
      .find((b) => b.textContent?.trim() === "Library") as HTMLElement;
    tab.click();
  });
  await page.waitForSelector("#panel-library tbody tr .video-link");
  await page.evaluate((key: string) => {
    const row = [...document.querySelectorAll("#panel-library tbody tr")]
      .find((r) => r.querySelector(".video-link") && (r as HTMLElement).innerHTML.includes(key));
    (((row ?? document.querySelector("#panel-library tbody tr"))!
      .querySelector(".video-link")) as HTMLElement).click();
  }, entry.key);
  await page.waitForSelector("#drawer-notes [data-t]", { timeout: 20000 });

  // Stand in for the media element. The file never decodes in here and does not
  // need to: what is under test is the arithmetic on the way to the playhead.
  await page.evaluate(() => {
    const v = document.getElementById("player-video") as HTMLVideoElement;
    let now = 0;
    Object.defineProperty(v, "currentTime", {
      configurable: true, get: () => now, set: (t: number) => { now = t; },
    });
    Object.defineProperty(v, "duration", { configurable: true, get: () => 3592.566 });
    Object.defineProperty(v, "paused", { configurable: true, get: () => true });
  });

  const setOffset = async (seconds: number): Promise<void> => {
    await page.evaluate((s: number) => {
      const box = document.getElementById("align-value") as HTMLInputElement;
      box.value = String(s);
      box.dispatchEvent(new Event("change"));
    }, seconds);
    await page.waitForTimeout(700);
  };

  await setOffset(OFFSET);

  // ── The notes are in the file's clock ──────────────────────────────────────
  const clicked = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll("#drawer-notes [data-t]")] as HTMLElement[];
    const target = blocks.find((b) => Number(b.dataset.t) > 600) ?? blocks[blocks.length - 1];
    const noteTime = Number(target.dataset.t);
    target.click();
    return { noteTime, landed: Math.round((document.getElementById("player-video") as HTMLVideoElement).currentTime) };
  });
  check(
    "a note click lands at the note's own time",
    Math.abs(clicked.landed - clicked.noteTime) < 1,
    `note ${clicked.noteTime}s → video ${clicked.landed}s (converting it would give ${clicked.noteTime + OFFSET}s)`,
  );

  const marked = await page.evaluate((at: number) => {
    const v = document.getElementById("player-video") as HTMLVideoElement;
    v.currentTime = at;
    v.dispatchEvent(new Event("timeupdate"));
    const now = document.querySelector("#drawer-notes .now") as HTMLElement | null;
    return {
      t: Number(now?.dataset?.t ?? -1),
      text: now?.textContent?.trim().slice(0, 44) ?? "",
      clock: document.getElementById("player-clock")?.textContent ?? "",
    };
  }, clicked.noteTime);
  check(
    "the highlight follows the same clock",
    marked.t >= 0 && marked.t <= clicked.noteTime && clicked.noteTime - marked.t < 120,
    `video at ${clicked.noteTime}s → "${marked.text}" (${marked.t}s)`,
  );
  check("the clock shows the file's position", marked.clock.startsWith(clockish(clicked.noteTime)), marked.clock);

  // ── The reel is in the transcript's, and converts ──────────────────────────
  // Clicking a span in the list, not the toolbar button: turning the reel on
  // lands you in the *nearest* span by design, which is the right behaviour and
  // the wrong test — it can legitimately not move at all.
  const reel = await page.evaluate(async (key: string) => {
    const payload = await fetch(`/api/highlights?key=${encodeURIComponent(key)}`, {
      headers: { "x-uninotes": "1" },
    }).then((r) => r.json());
    const built = Object.values(payload.reels ?? {}).find((r: unknown) => r) as
      { preset: string; segments: Array<{ start: number }> } | undefined;
    if (!built) return { stored: -1, landed: -1, shown: "" };

    (document.getElementById("player-highlights-open") as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 400));
    const items = [...document.querySelectorAll("#reel-list .reel-item")] as HTMLElement[];
    if (items.length === 0) return { stored: -1, landed: -1, shown: "" };
    items[0].click();
    await new Promise((r) => setTimeout(r, 400));

    const v = document.getElementById("player-video") as HTMLVideoElement;
    return {
      // The first span *of the preset the panel is showing*, which is the list
      // that was clicked.
      stored: (payload.reels[document.querySelector(".reel-preset[aria-pressed='true']")
        ?.getAttribute("data-reel") ?? built.preset]?.segments ?? built.segments)[0].start,
      landed: Math.round(v.currentTime),
      shown: items[0].querySelector(".ts")?.textContent ?? "",
    };
  }, entry.key);

  if (reel.stored < 0) {
    console.log("SKIP  no reel built for this lecture, so the transcript-clock half is untested");
  } else {
    check(
      "a reel span seeks to its stored time plus the offset",
      Math.abs(reel.landed - (reel.stored + OFFSET)) < 2,
      `stored ${Math.round(reel.stored)}s → video ${reel.landed}s`,
    );
    check(
      "and the panel shows it in the file's clock",
      reel.shown.startsWith(clockish(reel.stored + OFFSET)),
      `list says ${reel.shown}, video clock says ${clockish(reel.stored + OFFSET)}`,
    );
  }

  // ── Zero has to be the same as before any of this existed ──────────────────
  await setOffset(0);
  const plain = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll("#drawer-notes [data-t]")] as HTMLElement[];
    const target = blocks.find((b) => Number(b.dataset.t) > 600) ?? blocks[blocks.length - 1];
    const noteTime = Number(target.dataset.t);
    target.click();
    return { noteTime, landed: Math.round((document.getElementById("player-video") as HTMLVideoElement).currentTime) };
  });
  check(
    "with no offset a note click is unchanged",
    Math.abs(plain.landed - plain.noteTime) < 1,
    `note ${plain.noteTime}s → video ${plain.landed}s`,
  );

  await setOffset(restore);
  const left = await fetch(`${PANEL}/api/library`).then((r) => r.json()) as { entries: Entry[] };
  const now = left.entries.find((e) => e.key === entry.key)?.captionOffset ?? -1;
  check("the lecture's own offset is put back", now === restore, `${now}s`);

  await browser.close();
  console.log(fails.length === 0 ? "\nall frame checks passed" : `\n${fails.length} FAILED`);
  process.exit(fails.length === 0 ? 0 : 1);
}

/** "MM:" or "H:MM:" — enough of a clock to match a prefix without rounding rows. */
function clockish(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:` : `${pad(m)}:`;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
