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
import { resetForRetry, forgetLectures, assertInsideLectures } from "./mutations.js";
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
    if (result.value === defaultValue) {
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

    case "POST /api/settings/reset":
      deleteSettingsFile();
      sendJson(res, 200, {
        message: "Reset to the defaults in config.ts. Takes effect on the next run.",
        settings: settingsPayload(),
      });
      return;

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

    case "POST /api/lectures/forget": {
      const removed = forgetLectures(stringArray(body.ids));
      sendJson(res, 200, {
        message: `Removed ${removed} tracking row${removed === 1 ? "" : "s"}. Note files on disk were not touched.`,
      });
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
