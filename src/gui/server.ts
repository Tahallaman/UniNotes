/**
 * The control panel's HTTP server.
 *
 * Binds to 127.0.0.1 only. Three things guard it beyond that, because a server on
 * localhost is reachable by any page your browser happens to have open:
 *
 *   1. The Host header must name loopback, which blocks DNS-rebinding attacks that
 *      resolve an attacker-controlled name to 127.0.0.1.
 *   2. Mutations require an `X-UniNotes` header. A cross-origin page cannot set a
 *      custom header without a CORS preflight, and no preflight is answered here.
 *   3. Any path a request supplies is re-derived from the library or checked
 *      against Lectures/ before use — never trusted as given.
 *
 * That is proportionate for a personal tool that can start jobs, delete scheduled
 * tasks and read your notes, and it costs about thirty lines.
 */

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { CONFIG } from "../../config.js";
import { SETTING_FIELDS, getField, coerce } from "../settings/schema.js";
import {
  readSettingsFile,
  writeSettingsFile,
  deleteSettingsFile,
  getByPath,
} from "../settings/overlay.js";
import { effectiveConfig, DEFAULTS } from "./effective.js";
import { jobs, JOB_DEFINITIONS, getJobDefinition } from "./jobs.js";
import { listLectures, summarize, readNotes, closeLibraryDb } from "./library.js";
import { getStatus, clearLock, cleanTempParts, clearCheckpoints } from "./status.js";
import {
  resetForRetry,
  forgetLectures,
  setWatched,
  setProgress,
  setLectureDate,
  assertInsideLectures,
} from "./mutations.js";
import { destinationFor, lectureNumbersByCourse, validateTerms } from "../notes/organise.js";
import { serveVideo, serveCaptions } from "./video.js";
import { explain, ExplainUnavailableError } from "./explain.js";
import {
  listTasks,
  createTask,
  deleteTask,
  setTaskEnabled,
  runTaskNow,
  schedulableJobs,
  type Frequency,
} from "./scheduler.js";
import { addIgnoredTitle } from "../utils/ignoreList.js";

const WEB_DIR = path.join(CONFIG.rootDir, "web");
const DEFAULT_PORT = 4571;

/** Only these are served, so no request can walk out of web/. */
const STATIC_FILES: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/styles.css": "styles.css",
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

// ── Shutdown ──────────────────────────────────────────────────────────────────

/**
 * What the launcher does when the panel asks to stop.
 *
 * The route only asks. scripts/gui.ts owns what stopping actually means — close
 * the server, sweep the video cache, exit — so the button and Ctrl-C go down one
 * path instead of two that drift apart.
 */
let onShutdown: (() => void) | null = null;

export function setShutdownHandler(fn: () => void): void {
  onShutdown = fn;
}

// ── Request helpers ───────────────────────────────────────────────────────────

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A selection of every lecture is a few KB; anything near a megabyte is wrong.
    if (size > 1_000_000) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

function isLoopbackHost(req: http.IncomingMessage): boolean {
  const host = (req.headers.host ?? "").split(":")[0].toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

// ── Server-sent events ────────────────────────────────────────────────────────

const sseClients = new Set<http.ServerResponse>();

function broadcast(event: unknown): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

jobs.on("event", broadcast);

function handleEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    // Without this, a proxy or the browser itself may hold the stream in a buffer
    // and the console appears frozen until the run finishes.
    "x-accel-buffering": "no",
  });

  // Replay so a reloaded page shows the run already in progress rather than a
  // blank console until the next line happens to arrive.
  const { current, last } = jobs.getState();
  res.write(
    `data: ${JSON.stringify({ type: "snapshot", current, last, lines: jobs.getBuffer() })}\n\n`,
  );

  sseClients.add(res);

  const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
}

// ── Settings ──────────────────────────────────────────────────────────────────

function settingsPayload() {
  const overrides = readSettingsFile();
  // Effective, not the server's own CONFIG — see src/gui/effective.ts.
  const effective = effectiveConfig();
  return {
    fields: SETTING_FIELDS,
    values: Object.fromEntries(SETTING_FIELDS.map((f) => [f.path, getByPath(effective, f.path) ?? ""])),
    overridden: Object.keys(overrides).filter((k) => getField(k) !== undefined),
  };
}

/**
 * Is a submitted value the default?
 *
 * `===` answers this for every scalar setting, but the term list is an array —
 * never identical by reference, so an untouched list would be written back to
 * settings.json as an "override" of itself and then reported as changed from
 * default forever. Structural comparison for those, identity for the rest.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Put one group of settings back to its defaults.
 *
 * Drops those keys from settings.json rather than writing the default values
 * into it — a setting whose override is the default is still an override, and
 * would go stale the day the default changes.
 */
function resetGroup(group: string): { cleared: number } {
  const paths = new Set(SETTING_FIELDS.filter((f) => f.group === group).map((f) => f.path));
  if (paths.size === 0) throw new Error(`No settings group called "${group}".`);

  const overrides = readSettingsFile();
  let cleared = 0;
  for (const key of Object.keys(overrides)) {
    if (!paths.has(key)) continue;
    delete overrides[key];
    cleared++;
  }
  if (cleared > 0) writeSettingsFile(overrides);
  return { cleared };
}

function saveSettings(body: Record<string, unknown>): { saved: string[]; errors: string[] } {
  const submitted = (body.values ?? {}) as Record<string, unknown>;
  const overrides = readSettingsFile();
  const saved: string[] = [];
  const errors: string[] = [];

  for (const [dotted, raw] of Object.entries(submitted)) {
    const field = getField(dotted);
    if (!field) {
      errors.push(`Unknown setting "${dotted}"`);
      continue;
    }
    const result = coerce(field, raw);
    if (!result.ok) {
      errors.push(result.error!);
      continue;
    }

    // Storing a value identical to the default would grow settings.json with
    // entries that do nothing and make "what have I actually changed?"
    // unanswerable. Compared against DEFAULTS rather than CONFIG: CONFIG already
    // has the current overrides folded in, so a setting returned to its true
    // default would look like a change and be written back out forever.
    // An unset value is stored as null so the file still records the intent to
    // override rather than silently reverting to the default.
    const defaultValue = getByPath(DEFAULTS, dotted);
    if (sameValue(result.value, defaultValue)) {
      delete overrides[dotted];
    } else {
      overrides[dotted] = result.value === undefined ? null : result.value;
    }
    saved.push(dotted);
  }

  if (errors.length > 0) return { saved: [], errors };

  if (Object.keys(overrides).length === 0) deleteSettingsFile();
  else writeSettingsFile(overrides);

  return { saved, errors };
}

// ── Naming preview ────────────────────────────────────────────────────────────

/**
 * Where real lectures would land under the templates currently in the form.
 *
 * Computed here, by the same functions that do the writing, rather than
 * reimplemented in the page's JavaScript. Two free-text templates are only safe
 * to offer if you can see what they do before you save them, and a preview that
 * is a second implementation is one that eventually disagrees with the writer.
 *
 * Takes the *submitted* values rather than the saved ones, so the preview
 * updates as you type instead of after you commit.
 */
function namingPreview(body: Record<string, unknown>): unknown {
  const submitted = (body.values ?? {}) as Record<string, unknown>;
  const config = effectiveConfig();

  const pick = <T>(path: string, fallback: T): T =>
    (submitted[path] === undefined ? fallback : submitted[path]) as T;

  const terms = pick("terms.list", config.terms.list);
  const weeksEnabled = pick("terms.enabled", config.terms.enabled);
  const fileTemplate = pick("naming.fileTemplate", config.naming.fileTemplate);

  const destinations = [
    {
      name: "Exports",
      folderTemplate: pick("exports.folderTemplate", config.exports.folderTemplate),
      fileTemplate: pick("exports.fileTemplate", config.exports.fileTemplate) || fileTemplate,
      root: "Exports/Pretty",
    },
    {
      name: "Your folder",
      folderTemplate: pick("workspace.folderTemplate", config.workspace.folderTemplate),
      fileTemplate: pick("workspace.fileTemplate", config.workspace.fileTemplate) || fileTemplate,
      root: pick("workspace.root", config.workspace.root),
    },
  ];

  // Real lectures, not invented ones: a preview against "Sample Lecture 1"
  // proves nothing about the titles this actually has to cope with. Newest
  // first, and one without a date if there is one, since that is the case whose
  // behaviour is hardest to predict from the template alone.
  const all = listLectures().filter((e) => e.courseCode && e.title);
  // Numbered against the whole library, not against the three shown: a lecture's
  // number depends on its siblings, so previewing {number} from the sample alone
  // would show one answer and write another.
  const numbers = lectureNumbersByCourse(
    all.map((e) => ({ key: e.key, title: e.title, courseCode: e.courseCode, date: e.lectureDate })),
  );
  const dated = all.filter((e) => e.lectureDate !== null).slice(0, 3);
  const undated = all.find((e) => e.lectureDate === null);
  const samples = undated ? [...dated.slice(0, 2), undated] : dated;

  return {
    problems: validateTerms(terms as never),
    samples: samples.map((entry) => ({
      title: entry.title,
      courseCode: entry.courseCode,
      date: entry.lectureDate,
      dateSource: entry.dateSource,
      week: entry.week,
      termLabel: entry.termLabel,
      paths: destinations.map((destination) => {
        const result = destinationFor(
          {
            title: entry.title,
            courseCode: entry.courseCode,
            resolvedDate: entry.lectureDate,
            resolvedSource: entry.dateSource,
            lectureNumber: numbers.get(entry.key) ?? null,
          },
          { folderTemplate: destination.folderTemplate, fileTemplate: destination.fileTemplate },
          terms as never,
          weeksEnabled as boolean,
        );
        return {
          name: destination.name,
          root: destination.root,
          path: [...result.segments, result.filename].join("/"),
          week: result.placement.week,
        };
      }),
    })),
  };
}

// ── Job launching ─────────────────────────────────────────────────────────────

function startJob(body: Record<string, unknown>): unknown {
  const jobId = String(body.jobId ?? "");
  const def = getJobDefinition(jobId);
  if (!def) throw new Error(`Unknown job "${jobId}"`);

  const extraArgs: string[] = [];

  // Provider overrides are per-run: "just this once, use the API". They go on the
  // command line rather than into settings.json so they don't silently become the
  // new default for scheduled runs.
  const notes = body.notesProvider;
  const pretty = body.prettyProvider;
  if (notes === "api" || notes === "browser") extraArgs.push(`--uploader=${notes}`);
  if (pretty === "api" || pretty === "browser") extraArgs.push(`--pretty=${pretty}`);

  const selection = body.selection as { ids?: unknown; dirs?: unknown } | undefined;
  if (selection) {
    const ids = stringArray(selection.ids);
    const dirs = stringArray(selection.dirs).map(assertInsideLectures);
    if (ids.length === 0 && dirs.length === 0) {
      throw new Error("Nothing selected.");
    }
    fs.mkdirSync(CONFIG.paths.temp, { recursive: true });
    const file = path.join(CONFIG.paths.temp, "gui-selection.json");
    fs.writeFileSync(file, JSON.stringify({ ids, dirs }, null, 2), "utf-8");
    extraArgs.push(`--selection=${file}`);
  }

  return jobs.start(jobId, extraArgs);
}

// ── Maintenance & lecture actions ─────────────────────────────────────────────

function runMaintenance(action: string): string {
  switch (action) {
    case "clear-lock":
      return clearLock();
    case "clean-temp":
      return cleanTempParts();
    case "clear-checkpoints":
      return clearCheckpoints();
    default:
      throw new Error(`Unknown maintenance action "${action}"`);
  }
}

function openFolder(key: string): string {
  const entry = listLectures().find((e) => e.key === key);
  if (!entry?.lectureDir) throw new Error("That lecture has no folder on disk yet.");
  const dir = assertInsideLectures(entry.lectureDir);

  // explorer.exe reports a non-zero exit even when it succeeds, so the result is
  // not worth waiting for or checking.
  spawn("explorer.exe", [dir], { detached: true, stdio: "ignore", windowsHide: false }).unref();
  return `Opened ${dir}`;
}

function ignoreLectures(keys: string[]): string {
  const entries = listLectures();
  let added = 0;
  for (const key of keys) {
    const entry = entries.find((e) => e.key === key);
    if (entry && addIgnoredTitle(entry.title)) added++;
  }
  return added === 0
    ? "Already ignored."
    : `Added ${added} title${added === 1 ? "" : "s"} to ignored-lectures.txt. They'll be skipped from the next scan.`;
}

// ── Routing ───────────────────────────────────────────────────────────────────

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  query: URLSearchParams,
): Promise<void> {
  const isMutation = req.method === "POST";

  if (isMutation && req.headers["x-uninotes"] === undefined) {
    sendJson(res, 403, { error: "Missing X-UniNotes header — request refused." });
    return;
  }

  const body = isMutation ? await readBody(req) : {};

  switch (`${req.method} ${pathname}`) {
    case "GET /api/bootstrap":
      sendJson(res, 200, {
        status: await getStatus(),
        settings: settingsPayload(),
        jobs: JOB_DEFINITIONS,
        schedulable: schedulableJobs(),
        tasks: await listTasks(),
        root: CONFIG.rootDir,
      });
      return;

    case "GET /api/status":
      sendJson(res, 200, await getStatus());
      return;

    case "GET /api/library": {
      const entries = listLectures();
      sendJson(res, 200, { entries, summary: summarize(entries) });
      return;
    }

    case "GET /api/notes": {
      const which = query.get("which") === "pretty" ? "pretty" : "raw";
      const notes = readNotes(query.get("key") ?? "", which);
      if (!notes) {
        sendJson(res, 404, { error: `No ${which} notes for that lecture.` });
        return;
      }
      sendJson(res, 200, notes);
      return;
    }

    case "GET /api/settings":
      sendJson(res, 200, settingsPayload());
      return;

    case "POST /api/settings": {
      const result = saveSettings(body);
      if (result.errors.length > 0) {
        sendJson(res, 400, { error: result.errors.join("; ") });
        return;
      }
      sendJson(res, 200, {
        message:
          result.saved.length === 0
            ? "No changes."
            : `Saved. Takes effect on the next run${jobs.isRunning() ? " — the job in progress keeps its current settings." : "."}`,
        settings: settingsPayload(),
      });
      return;
    }

    case "POST /api/settings/reset": {
      // A group name resets that group; no group resets the lot.
      const group = typeof body.group === "string" ? body.group : "";
      if (group) {
        const { cleared } = resetGroup(group);
        sendJson(res, 200, {
          message: cleared === 0
            ? `${group} was already at its defaults.`
            : `${group} reset to defaults — ${cleared} setting${cleared === 1 ? "" : "s"} put back.`,
          settings: settingsPayload(),
        });
        return;
      }
      deleteSettingsFile();
      sendJson(res, 200, {
        message: "Reset to the defaults in config.ts. Takes effect on the next run.",
        settings: settingsPayload(),
      });
      return;
    }

    case "POST /api/jobs/start":
      sendJson(res, 200, { job: startJob(body) });
      return;

    case "POST /api/jobs/cancel":
      await jobs.cancel();
      sendJson(res, 200, { message: "Cancelled." });
      return;

    case "POST /api/jobs/clear":
      jobs.clearBuffer();
      sendJson(res, 200, { message: "Cleared." });
      return;

    case "GET /api/schedule":
      sendJson(res, 200, { tasks: await listTasks(), schedulable: schedulableJobs() });
      return;

    case "POST /api/schedule/create":
      sendJson(res, 200, {
        tasks: await createTask({
          jobId: String(body.jobId ?? ""),
          time: String(body.time ?? ""),
          frequency: (String(body.frequency ?? "DAILY").toUpperCase() as Frequency),
        }),
      });
      return;

    case "POST /api/schedule/delete":
      sendJson(res, 200, { tasks: await deleteTask(String(body.name ?? "")) });
      return;

    case "POST /api/schedule/toggle":
      sendJson(res, 200, {
        tasks: await setTaskEnabled(String(body.name ?? ""), body.enabled === true),
      });
      return;

    case "POST /api/schedule/run":
      await runTaskNow(String(body.name ?? ""));
      sendJson(res, 200, { message: "Started. Output goes to logs/scheduled.log." });
      return;

    case "POST /api/maintenance":
      sendJson(res, 200, { message: runMaintenance(String(body.action ?? "")) });
      return;

    case "POST /api/lectures/open":
      sendJson(res, 200, { message: openFolder(String(body.key ?? "")) });
      return;

    case "POST /api/lectures/ignore":
      sendJson(res, 200, { message: ignoreLectures(stringArray(body.keys)) });
      return;

    case "POST /api/lectures/reset": {
      const result = resetForRetry(stringArray(body.ids));
      const parts = [`Reset ${result.reset} lecture${result.reset === 1 ? "" : "s"} for retry.`];
      if (result.skipped.length > 0) parts.push(`Skipped: ${result.skipped.join("; ")}`);
      sendJson(res, 200, { message: parts.join(" ") });
      return;
    }

    case "POST /api/lectures/watched": {
      const watched = body.watched === true;
      const changed = setWatched(stringArray(body.ids), watched);
      sendJson(res, 200, {
        changed,
        message: `Marked ${changed} lecture${changed === 1 ? "" : "s"} as ${watched ? "watched" : "not watched"}.`,
      });
      return;
    }

    // Silent by design: this arrives every few seconds while a video plays, and
    // a message per save would fill the toast queue with where you are.
    case "POST /api/lectures/progress": {
      const result = setProgress(
        String(body.id ?? ""),
        Number(body.seconds),
        Number(body.duration),
      );
      sendJson(res, 200, result);
      return;
    }

    case "POST /api/naming/preview":
      sendJson(res, 200, namingPreview(body));
      return;

    case "POST /api/lectures/date": {
      const raw = body.date;
      const date = raw === null || raw === "" || raw === undefined ? null : String(raw);
      setLectureDate(String(body.id ?? ""), date);
      sendJson(res, 200, {
        message: date === null ? "Date cleared — worked out from the recording again." : `Date set to ${date}.`,
      });
      return;
    }

    // The one route that does its work in-process rather than spawning a job.
    // See src/gui/explain.ts for why, and for what that costs.
    case "POST /api/explain": {
      try {
        sendJson(res, 200, await explain(body));
      } catch (err) {
        if (err instanceof ExplainUnavailableError) {
          // 503, not 500: nothing is broken, the feature just isn't available to
          // you yet, and the message says what to do about it.
          sendJson(res, 503, { error: err.message });
          return;
        }
        throw err;
      }
      return;
    }

    case "POST /api/lectures/forget": {
      const removed = forgetLectures(stringArray(body.ids));
      sendJson(res, 200, {
        message: `Removed ${removed} tracking row${removed === 1 ? "" : "s"}. Note files on disk were not touched.`,
      });
      return;
    }

    // Stopping from the browser exists because closing the terminal doesn't stop
    // anything: Windows never turns a console close into the SIGINT the launcher
    // listens for, so the server is left running with no way left to ask it
    // politely. This is that way.
    case "POST /api/shutdown": {
      if (!onShutdown) {
        sendJson(res, 501, { error: "This server was started without a shutdown handler." });
        return;
      }

      // A job is a process tree — tsx, then ffmpeg, then Playwright's browser.
      // Exiting out from under it orphans the lot, which is the mess this route
      // is here to prevent, so it takes an explicit ask and cancels first.
      if (jobs.isRunning()) {
        if (body.force !== true) {
          sendJson(res, 409, {
            error: "A job is still running.",
            running: true,
          });
          return;
        }
        await jobs.cancel();
      }

      sendJson(res, 200, { message: "Shutting down." });
      // Answer first. Tearing the server down mid-reply would reach the browser
      // as a failed request, which reads as "the button is broken" rather than
      // "it worked".
      res.on("finish", () => setTimeout(() => onShutdown?.(), 50));
      return;
    }

    default:
      sendJson(res, 404, { error: `No route for ${req.method} ${pathname}` });
  }
}

function serveStatic(pathname: string, res: http.ServerResponse): void {
  const filename = STATIC_FILES[pathname];
  if (!filename) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }

  try {
    const content = fs.readFileSync(path.join(WEB_DIR, filename));
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[path.extname(filename)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(content);
  } catch {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`Could not read web/${filename}`);
  }
}

export function startServer(port = DEFAULT_PORT): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (!isLoopbackHost(req)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("This server only accepts requests addressed to localhost.");
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/api/events") {
      handleEvents(req, res);
      return;
    }

    // Ahead of handleApi because this one answers with bytes, not JSON, and has
    // to see the Range header rather than a parsed body.
    if (url.pathname === "/api/video") {
      serveVideo(req, res, url.searchParams.get("key") ?? "");
      return;
    }

    // Also ahead of handleApi: a <track> element wants text/vtt, not JSON.
    if (url.pathname === "/api/subtitles") {
      serveCaptions(res, url.searchParams.get("key") ?? "");
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      handleApi(req, res, url.pathname, url.searchParams).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) sendJson(res, 400, { error: message });
        else res.end();
      });
      return;
    }

    serveStatic(url.pathname, res);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Loopback only. Binding 0.0.0.0 would expose job-starting and note-reading
    // to anything on the network.
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

export async function stopServer(server: http.Server): Promise<void> {
  for (const client of sseClients) client.end();
  sseClients.clear();
  closeLibraryDb();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  // close() stops new connections but waits on every open one, and a browser
  // holds its keep-alive sockets open long after the last reply — including the
  // one that just asked to shut down. Without this the wait never ends.
  server.closeAllConnections();
  await closed;
}
