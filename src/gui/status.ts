/**
 * Everything the control panel needs to tell you what state the system is in,
 * and the small maintenance actions that fix the states you don't want.
 *
 * The point of the health section is to turn failures that currently surface
 * fifteen minutes into a run — no ffmpeg, expired Google session, missing ADC —
 * into something visible before you press the button.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG } from "../../config.js";
import { effectiveConfig, type EffectiveConfig } from "./effective.js";
import { findPendingPretty } from "../pipeline/prettyBackfill.js";
import { lectureCounts } from "./library.js";

const execFileAsync = promisify(execFile);

const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".mov", ".avi", ".webm"]);

export interface HealthCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  /** Shown as a warning rather than a failure — the pipeline still runs without it. */
  advisory?: boolean;
  /** Job id that fixes it, if there is one. */
  fixJob?: string;
}

export interface SystemStatus {
  providers: { notes: string; pretty: string };
  concurrency: Record<string, number>;
  models: { notes: string; pretty: string; webPicker: string; location: string };
  incomingCount: number;
  pendingPrettyCount: number;
  /** Lecture count per database status, for the waiting list. */
  lectureCounts: Record<string, number>;
  lock: { held: boolean; pid: number | null; alive: boolean };
  temp: { bytes: number; orphanParts: number; checkpoints: number };
  checks: HealthCheck[];
  settingsOverrides: number;
}

// ── Cheap filesystem probes ───────────────────────────────────────────────────

function countIncomingVideos(): number {
  if (!fs.existsSync(CONFIG.paths.incoming)) return 0;
  let count = 0;
  for (const course of fs.readdirSync(CONFIG.paths.incoming)) {
    const dir = path.join(CONFIG.paths.incoming, course);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const file of fs.readdirSync(dir)) {
        if (VIDEO_EXTENSIONS.has(path.extname(file).toLowerCase())) count++;
      }
    } catch {
      // Unreadable folder — not worth failing the whole status call over.
    }
  }
  return count;
}

function dirSize(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirSize(full);
      else total += fs.statSync(full).size;
    } catch {
      // Vanished mid-scan (a run is cleaning up) — skip it.
    }
  }
  return total;
}

/** Split parts left behind by an interrupted run — the resume data, not garbage. */
function listOrphanParts(): string[] {
  try {
    return fs
      .readdirSync(CONFIG.paths.temp)
      .filter((f) => /_part\d+\./i.test(f))
      .map((f) => path.join(CONFIG.paths.temp, f));
  } catch {
    return [];
  }
}

function countCheckpoints(): number {
  const root = path.join(CONFIG.paths.temp, "checkpoints");
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
  } catch {
    return 0;
  }
}

export function readLock(): { held: boolean; pid: number | null; alive: boolean } {
  if (!fs.existsSync(CONFIG.paths.lockFile)) return { held: false, pid: null, alive: false };
  let pid: number | null = null;
  try {
    pid = parseInt(fs.readFileSync(CONFIG.paths.lockFile, "utf-8").trim(), 10);
    if (!Number.isFinite(pid)) pid = null;
  } catch {
    pid = null;
  }

  let alive = false;
  if (pid !== null) {
    try {
      process.kill(pid, 0); // signal 0 tests existence without touching the process
      alive = true;
    } catch {
      alive = false;
    }
  }
  return { held: true, pid, alive };
}

// ── Health checks ─────────────────────────────────────────────────────────────

let ffmpegCache: { ok: boolean; detail: string } | null = null;

async function checkFfmpeg(): Promise<HealthCheck> {
  if (!ffmpegCache) {
    try {
      const { stdout } = await execFileAsync("ffmpeg", ["-version"], { windowsHide: true });
      // Just the version. The full banner is a build string and a copyright line
      // that crowd the other checks off the row for no information.
      const version = /ffmpeg version (\S+)/.exec(stdout)?.[1] ?? "found";
      ffmpegCache = { ok: true, detail: `version ${version.split("-")[0]}` };
    } catch {
      ffmpegCache = { ok: false, detail: "Not on PATH — videos longer than one segment can't be split." };
    }
  }
  return { id: "ffmpeg", label: "ffmpeg", ...ffmpegCache };
}

function profileLooksAuthenticated(dir: string): boolean {
  // A persistent Playwright profile that has been used has a Default/ subfolder
  // with cookies in it. An empty directory is what `ensureDirectories` creates.
  try {
    return fs.existsSync(path.join(dir, "Default", "Network", "Cookies"));
  } catch {
    return false;
  }
}

function adcPath(): string {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "gcloud", "application_default_credentials.json");
}

async function buildChecks(effective: EffectiveConfig): Promise<HealthCheck[]> {
  const providers = effective.providers;
  const checks: HealthCheck[] = [];

  checks.push(await checkFfmpeg());

  // Before the session check, deliberately: "sign in to Panopto" is unactionable
  // advice when the tool doesn't yet know which Panopto.
  const site = (process.env.UNINOTES_PANOPTO_URL || effective.panopto.baseUrl).trim();
  checks.push({
    id: "panopto-site",
    label: "Panopto site",
    ok: site.length > 0,
    detail: site.length > 0
      ? site
      : "Not set — Settings → Institution. Use your institution's Panopto address, e.g. https://yourschool.hosted.panopto.com.",
  });

  const panoptoOk = profileLooksAuthenticated(CONFIG.paths.browserData.panopto);
  checks.push({
    id: "panopto-auth",
    label: "Panopto session",
    ok: panoptoOk,
    detail: panoptoOk
      ? "Profile has saved cookies."
      : "No saved session — scraping will fail until you sign in.",
    fixJob: "auth-panopto",
  });

  const geminiOk = profileLooksAuthenticated(CONFIG.paths.browserData.gemini);
  const needsGemini = providers.notes === "browser" || providers.pretty === "browser";
  checks.push({
    id: "gemini-auth",
    label: "Google session",
    ok: geminiOk,
    // Only a hard failure if something actually uses the browser backend.
    advisory: !needsGemini,
    detail: geminiOk
      ? "Profile has saved cookies. Cookies can still expire — the browser probe confirms."
      : needsGemini
        ? "No saved session — the browser backend will fail until you sign in."
        : "Not signed in, but no stage is using the browser backend.",
    fixJob: "auth-gemini",
  });

  const needsAdc = providers.notes === "api" || providers.pretty === "api";
  const adcOk = fs.existsSync(adcPath());
  checks.push({
    id: "adc",
    label: "Google Cloud credentials",
    ok: adcOk,
    advisory: !needsAdc,
    detail: adcOk
      ? "Application Default Credentials found."
      : needsAdc
        ? "Missing — run `gcloud auth application-default login`."
        : "Missing, but no stage is using the api backend.",
  });

  const project = (process.env.GOOGLE_CLOUD_PROJECT || effective.vertex.project).trim();
  checks.push({
    id: "gcp-project",
    label: "Google Cloud project",
    ok: project.length > 0,
    advisory: !needsAdc,
    detail: project.length > 0
      ? project
      : needsAdc
        ? "Not set — Settings → Google Cloud. The api backend can't run without it."
        : "Not set, but no stage is using the api backend.",
  });

  const lock = readLock();
  checks.push({
    id: "lock",
    label: "Pipeline lock",
    ok: !lock.held || lock.alive,
    advisory: true,
    detail: !lock.held
      ? "Free."
      : lock.alive
        ? `Held by a running process (PID ${lock.pid}).`
        : `Stale — PID ${lock.pid} is gone. Clear it before running.`,
  });

  return checks;
}

export async function getStatus(): Promise<SystemStatus> {
  const orphanParts = listOrphanParts();
  let overrides = 0;
  try {
    overrides = Object.keys(
      JSON.parse(fs.readFileSync(path.join(CONFIG.rootDir, "settings.json"), "utf-8")),
    ).length;
  } catch {
    overrides = 0;
  }

  // Everything settings-derived comes from the effective config, so the panel
  // describes the next run rather than whatever this server started with.
  const effective = effectiveConfig();

  return {
    providers: { notes: effective.providers.notes, pretty: effective.providers.pretty },
    concurrency: { ...effective.concurrency },
    models: {
      notes: effective.vertex.model,
      pretty: effective.vertex.generation.pretty.model,
      webPicker: effective.gemini.model,
      location: effective.vertex.location,
    },
    incomingCount: countIncomingVideos(),
    pendingPrettyCount: findPendingPretty().length,
    lectureCounts: lectureCounts(),
    lock: readLock(),
    temp: {
      bytes: dirSize(CONFIG.paths.temp),
      orphanParts: orphanParts.length,
      checkpoints: countCheckpoints(),
    },
    checks: await buildChecks(effective),
    settingsOverrides: overrides,
  };
}

// ── Maintenance ───────────────────────────────────────────────────────────────

export function clearLock(): string {
  const lock = readLock();
  if (!lock.held) return "No lock file to clear.";
  if (lock.alive) {
    throw new Error(
      `PID ${lock.pid} is still running. Cancel the job (or close that process) before clearing the lock.`,
    );
  }
  fs.unlinkSync(CONFIG.paths.lockFile);
  return `Cleared stale lock left by PID ${lock.pid}.`;
}

/**
 * Delete leftover split parts.
 *
 * These are deliberately kept when a lecture fails — they're what lets the next
 * run resume rather than re-split and re-upload every segment. So this is an
 * explicit action with the count shown, never something that happens quietly.
 */
export function cleanTempParts(): string {
  const parts = listOrphanParts();
  let removed = 0;
  let bytes = 0;
  for (const part of parts) {
    try {
      bytes += fs.statSync(part).size;
      fs.unlinkSync(part);
      removed++;
    } catch {
      // Still locked by a process that hasn't exited yet.
    }
  }
  if (removed === 0) return "Nothing to clean.";
  return `Deleted ${removed} split part${removed === 1 ? "" : "s"} (${formatBytes(bytes)}). Those lectures will restart from part 1.`;
}

export function clearCheckpoints(): string {
  const root = path.join(CONFIG.paths.temp, "checkpoints");
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
      removed++;
    }
  } catch {
    return "No checkpoints to clear.";
  }
  return removed === 0
    ? "No checkpoints to clear."
    : `Cleared ${removed} checkpoint${removed === 1 ? "" : "s"}. Interrupted lectures will restart from part 1.`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
