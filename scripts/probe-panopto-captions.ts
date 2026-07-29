/**
 * Find out how this Panopto tenant hands over a recording's captions.
 *
 * Read-only, like the other probes. Written before the caption downloader
 * because the endpoints are undocumented and vary by tenant version: guessing
 * one and building on it is how you end up with a feature that works here and
 * nowhere else.
 *
 * Tries, in order of how pleasant each would be to depend on:
 *   1. GenerateSRT.ashx  — a plain GET returning SRT, the nicest outcome.
 *   2. DeliveryInfo.aspx — the viewer's own JSON, which lists caption tracks.
 *   3. The viewer page   — what the player itself requests, watched live.
 *
 * Usage: npx tsx scripts/probe-panopto-captions.ts [lectureId]
 */

import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";
import { ensureDirectories } from "../src/utils/paths.js";
import { getDb, closeDb } from "../src/db/schema.js";
import type { LectureRow } from "../src/db/tracker.js";
import { launchPanoptoBrowser } from "../src/panopto/scraper.js";
import { panoptoBaseUrl, viewerUrl } from "../src/panopto/endpoints.js";

ensureDirectories();
const db = getDb();

function pickLecture(): LectureRow {
  const wanted = process.argv[2];
  const row = wanted
    ? (db.prepare("SELECT * FROM lectures WHERE id = ?").get(wanted) as LectureRow | undefined)
    : (db
        .prepare("SELECT * FROM lectures WHERE source = 'panopto' ORDER BY created_at DESC LIMIT 1")
        .get() as LectureRow | undefined);
  if (!row) {
    console.error(wanted ? `No lecture with id ${wanted}.` : "No Panopto lectures tracked yet.");
    process.exit(2);
  }
  return row;
}

function summarise(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return "(empty)";
  return trimmed.slice(0, 400).replace(/\r/g, "");
}

async function main(): Promise<void> {
  const lecture = pickLecture();
  const base = panoptoBaseUrl();
  console.log(`Lecture: ${lecture.title}`);
  console.log(`Id:      ${lecture.id}\n`);

  const context = await launchPanoptoBrowser();
  const outDir = CONFIG.paths.temp;

  try {
    const page = context.pages()[0] || (await context.newPage());

    // Watch what the player itself asks for. Anything caption-shaped that the
    // viewer requests is, by definition, an endpoint that works on this tenant.
    const seen: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (/caption|transcript|srt|vtt|DeliveryInfo/i.test(url)) seen.push(`${req.method()} ${url}`);
    });

    console.log("Opening the viewer so the session is warm and the player shows its hand...");
    await page.goto(viewerUrl(lecture.id), {
      timeout: CONFIG.panopto.navigationTimeout,
      waitUntil: "load",
    });
    await page.waitForTimeout(6000);

    // ── 1. The direct SRT endpoint ───────────────────────────────────────────
    for (const language of [0, 1]) {
      const url = `${base}/Panopto/Pages/Transcription/GenerateSRT.ashx?id=${lecture.id}&language=${language}`;
      const result = await page.evaluate(async (target) => {
        try {
          const res = await fetch(target, { credentials: "include" });
          const text = await res.text();
          return { status: res.status, type: res.headers.get("content-type"), length: text.length, body: text.slice(0, 600) };
        } catch (err) {
          return { status: -1, type: null, length: 0, body: String(err) };
        }
      }, url);

      console.log(`\n=== GenerateSRT.ashx language=${language} ===`);
      console.log(`status ${result.status} · ${result.type ?? "no content-type"} · ${result.length} bytes`);
      console.log(summarise(result.body));

      if (result.status === 200 && result.length > 0) {
        const file = path.join(outDir, `captions-probe-${language}.srt`);
        fs.writeFileSync(file, result.body, "utf-8");
        console.log(`(first 600 bytes saved to ${file})`);
      }
    }

    // ── 2. The viewer's own delivery info ────────────────────────────────────
    const delivery = await page.evaluate(async (id) => {
      try {
        const res = await fetch("/Panopto/Pages/Viewer/DeliveryInfo.aspx", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: `deliveryId=${id}&responseType=json&isEmbed=true`,
        });
        const text = await res.text();
        return { status: res.status, length: text.length, body: text };
      } catch (err) {
        return { status: -1, length: 0, body: String(err) };
      }
    }, lecture.id);

    console.log(`\n=== DeliveryInfo.aspx ===`);
    console.log(`status ${delivery.status} · ${delivery.length} bytes`);
    if (delivery.status === 200 && delivery.length > 0) {
      const file = path.join(outDir, "captions-probe-delivery.json");
      fs.writeFileSync(file, delivery.body, "utf-8");
      console.log(`saved to ${file}`);
      try {
        const parsed = JSON.parse(delivery.body) as Record<string, unknown>;
        const keys = Object.keys(parsed);
        console.log(`top-level keys: ${keys.join(", ")}`);
        for (const key of keys) {
          if (/caption|transcript|language/i.test(key)) {
            console.log(`  ${key}: ${JSON.stringify(parsed[key]).slice(0, 500)}`);
          }
        }
      } catch {
        console.log(summarise(delivery.body));
      }
    } else {
      console.log(summarise(delivery.body));
    }

    // ── 3. What the player asked for by itself ───────────────────────────────
    console.log(`\n=== Caption-shaped requests the viewer made (${seen.length}) ===`);
    for (const line of [...new Set(seen)].slice(0, 25)) console.log(`  ${line}`);

    const shot = path.join(outDir, "captions-probe.png");
    await page.screenshot({ path: shot, fullPage: false });
    console.log(`\nScreenshot: ${shot}`);
  } finally {
    const browser = context.browser();
    await context.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

main()
  .catch((err: unknown) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
