/**
 * Scheduled runs, backed by Windows Task Scheduler.
 *
 * This replaces scripts/setup-scheduler.bat with something you can see and edit.
 * The bat file created one hourly task and gave you `schtasks /delete` in an echo
 * as the only way back out.
 *
 * Two design choices worth stating:
 *
 * **One task per time slot.** A single schtasks task cannot hold two daily start
 * times. `/ri` repetition would technically work but fires through the night as
 * well, which is not what "twice a day" means. Two tasks is the honest encoding.
 *
 * **Each task points at its own generated .cmd file** rather than a long inline
 * command. schtasks' /tr argument has a length limit and its own quoting rules on
 * top of the ones cmd applies, so a command with paths and redirections in it is
 * a reliable source of tasks that silently do nothing. A one-line path has no
 * such failure mode, and the .cmd is readable when you want to know what runs.
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG } from "../../config.js";
import { getJobDefinition, JOB_DEFINITIONS } from "./jobs.js";

const execFileAsync = promisify(execFile);

const TASK_PREFIX = "UniNotes-";
const SCHEDULED_DIR = path.join(CONFIG.rootDir, "scripts", "scheduled");
const META_PATH = path.join(SCHEDULED_DIR, "tasks.json");

export type Frequency = "DAILY" | "HOURLY" | "WEEKLY";

export interface ScheduledTask {
  /** Full Task Scheduler name, e.g. "UniNotes-pipeline-0730". */
  name: string;
  jobId: string;
  jobLabel: string;
  frequency: Frequency;
  /** "HH:MM", 24-hour. */
  time: string;
  /** Present only when the task still exists in Task Scheduler. */
  status: string | null;
  nextRun: string | null;
  exists: boolean;
  cmdPath: string;
}

interface TaskMeta {
  name: string;
  jobId: string;
  frequency: Frequency;
  time: string;
}

/** Jobs it makes sense to run unattended — anything that waits for a human doesn't. */
export function schedulableJobs(): Array<{ id: string; label: string }> {
  return JOB_DEFINITIONS.filter((d) => !d.interactive && d.id !== "selected" && d.id !== "prettify-selected")
    .map((d) => ({ id: d.id, label: d.label }));
}

// ── Metadata ──────────────────────────────────────────────────────────────────

function readMeta(): TaskMeta[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(META_PATH, "utf-8"));
    return Array.isArray(parsed) ? (parsed as TaskMeta[]) : [];
  } catch {
    return [];
  }
}

function writeMeta(meta: TaskMeta[]): void {
  fs.mkdirSync(SCHEDULED_DIR, { recursive: true });
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2) + "\n", "utf-8");
}

// ── Task Scheduler ────────────────────────────────────────────────────────────

interface QueriedTask {
  name: string;
  nextRun: string;
  status: string;
}

/**
 * Every UniNotes task Task Scheduler currently knows about.
 *
 * Queried rather than trusted from the metadata file, so a task deleted by hand
 * in taskschd.msc shows up as gone in the GUI instead of as a phantom row.
 */
async function queryTasks(): Promise<Map<string, QueriedTask>> {
  const found = new Map<string, QueriedTask>();
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("schtasks", ["/query", "/fo", "CSV", "/nh"], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch {
    return found; // no tasks at all, or schtasks unavailable
  }

  for (const row of stdout.split(/\r?\n/)) {
    const cells = parseCsvRow(row);
    if (cells.length < 3) continue;
    // Task Scheduler reports names with a leading folder separator.
    const name = cells[0].replace(/^\\+/, "");
    if (!name.startsWith(TASK_PREFIX)) continue;
    found.set(name, { name, nextRun: cells[1], status: cells[2] });
  }

  return found;
}

function parseCsvRow(row: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

export async function listTasks(): Promise<ScheduledTask[]> {
  const meta = readMeta();
  const live = await queryTasks();

  const tasks: ScheduledTask[] = meta.map((m) => {
    const q = live.get(m.name);
    return {
      name: m.name,
      jobId: m.jobId,
      jobLabel: getJobDefinition(m.jobId)?.label ?? m.jobId,
      frequency: m.frequency,
      time: m.time,
      status: q?.status ?? null,
      nextRun: q?.nextRun ?? null,
      exists: q !== undefined,
      cmdPath: cmdPathFor(m.name),
    };
  });

  // A task created outside the GUI (or by the old setup-scheduler.bat) still
  // belongs in the list — hiding it would make the schedule look wrong.
  for (const [name, q] of live) {
    if (tasks.some((t) => t.name === name)) continue;
    tasks.push({
      name,
      jobId: "unknown",
      jobLabel: "Created outside the GUI",
      frequency: "DAILY",
      time: "",
      status: q.status,
      nextRun: q.nextRun,
      exists: true,
      cmdPath: "",
    });
  }

  tasks.sort((a, b) => a.time.localeCompare(b.time) || a.name.localeCompare(b.name));
  return tasks;
}

function cmdPathFor(taskName: string): string {
  return path.join(SCHEDULED_DIR, `${taskName}.cmd`);
}

/**
 * Write the batch file the task runs.
 *
 * Uses the same `node --import tsx` invocation the GUI uses for manual runs, so a
 * scheduled run and a button press execute an identical command — one fewer thing
 * to explain when only one of them works.
 */
function writeCmdFile(taskName: string, jobId: string): string {
  const def = getJobDefinition(jobId);
  if (!def) throw new Error(`Unknown job "${jobId}"`);

  const scriptPath = path.join(CONFIG.rootDir, def.script);
  const args = (def.args ?? []).join(" ");
  const cmdPath = cmdPathFor(taskName);

  const body = [
    "@echo off",
    `rem Generated by the UniNotes control panel for task ${taskName}.`,
    "rem Delete the task in the GUI (or taskschd.msc) rather than editing this file.",
    "setlocal",
    `cd /d "${CONFIG.rootDir}"`,
    'if not exist logs mkdir logs',
    `>> "logs\\scheduled.log" echo.`,
    `>> "logs\\scheduled.log" echo ==== %date% %time% :: ${def.label} ====`,
    `"${process.execPath}" --import tsx "${scriptPath}"${args ? " " + args : ""} >> "logs\\scheduled.log" 2>&1`,
    "",
  ].join("\r\n");

  fs.mkdirSync(SCHEDULED_DIR, { recursive: true });
  fs.writeFileSync(cmdPath, body, "utf-8");
  return cmdPath;
}

function validateTime(time: string): void {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error(`Invalid time "${time}" — expected HH:MM in 24-hour form.`);
  }
}

export async function createTask(opts: {
  jobId: string;
  time: string;
  frequency: Frequency;
}): Promise<ScheduledTask[]> {
  validateTime(opts.time);
  if (!getJobDefinition(opts.jobId)) throw new Error(`Unknown job "${opts.jobId}"`);
  if (getJobDefinition(opts.jobId)?.interactive) {
    throw new Error("That job opens a browser window and waits for you — it can't run unattended.");
  }

  const name = `${TASK_PREFIX}${opts.jobId}-${opts.time.replace(":", "")}`;
  const meta = readMeta();
  if (meta.some((m) => m.name === name)) {
    throw new Error(`A ${opts.time} task for this job already exists.`);
  }

  const cmdPath = writeCmdFile(name, opts.jobId);

  const args = ["/create", "/tn", name, "/tr", cmdPath, "/sc", opts.frequency, "/st", opts.time, "/f"];
  try {
    await execFileAsync("schtasks", args, { windowsHide: true });
  } catch (err) {
    fs.rmSync(cmdPath, { force: true });
    throw new Error(schtasksError(err));
  }

  meta.push({ name, jobId: opts.jobId, frequency: opts.frequency, time: opts.time });
  writeMeta(meta);
  return listTasks();
}

export async function deleteTask(name: string): Promise<ScheduledTask[]> {
  assertOurTask(name);
  try {
    await execFileAsync("schtasks", ["/delete", "/tn", name, "/f"], { windowsHide: true });
  } catch (err) {
    // A task already gone from Task Scheduler should still leave the metadata
    // clean, so don't let that failure block the tidy-up below.
    const message = schtasksError(err);
    if (!/cannot find|does not exist/i.test(message)) throw new Error(message);
  }

  fs.rmSync(cmdPathFor(name), { force: true });
  writeMeta(readMeta().filter((m) => m.name !== name));
  return listTasks();
}

export async function setTaskEnabled(name: string, enabled: boolean): Promise<ScheduledTask[]> {
  assertOurTask(name);
  try {
    await execFileAsync("schtasks", ["/change", "/tn", name, enabled ? "/enable" : "/disable"], {
      windowsHide: true,
    });
  } catch (err) {
    throw new Error(schtasksError(err));
  }
  return listTasks();
}

export async function runTaskNow(name: string): Promise<void> {
  assertOurTask(name);
  try {
    await execFileAsync("schtasks", ["/run", "/tn", name], { windowsHide: true });
  } catch (err) {
    throw new Error(schtasksError(err));
  }
}

/**
 * Refuse to touch tasks that aren't ours.
 *
 * The task name arrives from an HTTP request, and it is passed to a command that
 * deletes scheduled tasks. Without this check, a request naming any task on the
 * machine would delete it.
 */
function assertOurTask(name: string): void {
  if (!name.startsWith(TASK_PREFIX) || /[\\/]/.test(name)) {
    throw new Error(`Refusing to modify "${name}" — not a UniNotes task.`);
  }
}

function schtasksError(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  const raw = (e.stderr || e.stdout || e.message || "").trim();
  if (/access is denied/i.test(raw)) {
    return "Access denied — Task Scheduler refused the change. Run the control panel from an elevated terminal.";
  }
  return raw || "schtasks failed";
}
