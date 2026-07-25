/**
 * Runs pipeline work as child processes and streams the output to the browser.
 *
 * Every button in the GUI maps to a command you could have typed. The alternative
 * — calling processLecture() inside the server — would put a long-lived HTTP
 * process in charge of the PID lock, the browser pool and a database write
 * connection, and several of the entry points call process.exit(), which would
 * take the GUI down with them. Spawning keeps the CLI as the only implementation,
 * makes Cancel a real kill rather than a cooperative flag, and means a run that
 * crashes hard leaves the control panel standing.
 *
 * One job at a time. The pipeline's own lock file already enforces that between
 * processes; doing it here as well turns "lock file exists, exiting" 200ms into a
 * run into an immediate, explainable refusal.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { CONFIG } from "../../config.js";

export interface JobDefinition {
  id: string;
  label: string;
  /** Path relative to the project root. */
  script: string;
  args?: string[];
  description: string;
  /** Takes the pipeline PID lock, so it can't overlap another such job. */
  usesLock: boolean;
  /** Opens a real window and waits for the user — the UI says so while it runs. */
  interactive?: boolean;
}

export const JOB_DEFINITIONS: readonly JobDefinition[] = [
  {
    id: "pipeline",
    label: "Run full pipeline",
    script: "src/main.ts",
    description: "Scrape Panopto, download new lectures, generate notes, prettify.",
    usesLock: true,
  },
  {
    id: "pipeline-retry",
    label: "Retry errored lectures",
    script: "src/main.ts",
    args: ["--retry"],
    description: "Reset errored Panopto lectures and run the pipeline again.",
    usesLock: true,
  },
  {
    id: "scan",
    label: "Scan Panopto only",
    script: "scripts/scan-panopto.ts",
    description: "Find new lectures and record them, without downloading anything.",
    usesLock: false,
  },
  {
    id: "local",
    label: "Process Incoming videos",
    script: "scripts/process-local.ts",
    description: "Process every video sitting in Incoming/<Course>/.",
    usesLock: true,
  },
  {
    id: "local-retry",
    label: "Process Incoming (retry errors)",
    script: "scripts/process-local.ts",
    args: ["--retry"],
    description: "As above, but also re-run local lectures that previously errored.",
    usesLock: true,
  },
  {
    id: "pretty",
    label: "Prettify missing",
    script: "scripts/run-pretty.ts",
    description: "Generate lecture.pretty.md wherever it's missing.",
    usesLock: false,
  },
  {
    id: "pretty-force",
    label: "Prettify everything",
    script: "scripts/run-pretty.ts",
    args: ["--force"],
    description: "Regenerate every lecture.pretty.md, overwriting existing ones.",
    usesLock: false,
  },
  {
    id: "selected",
    label: "Process selected lectures",
    script: "scripts/process-selected.ts",
    description: "Download (if needed) and process only the lectures you picked.",
    usesLock: true,
  },
  {
    id: "prettify-selected",
    label: "Prettify selected lectures",
    script: "scripts/process-selected.ts",
    args: ["--pretty-only"],
    description: "Regenerate pretty notes for the lectures you picked.",
    usesLock: false,
  },
  {
    id: "export",
    label: "Export notes",
    script: "scripts/export-notes.ts",
    description: "Copy notes into Exports/ and sync to the workspace folder.",
    usesLock: false,
  },
  {
    id: "auth-panopto",
    label: "Sign in to Panopto",
    script: "src/main.ts",
    args: ["--auth", "panopto"],
    description: "Opens a browser window. Log in, then close the window.",
    usesLock: false,
    interactive: true,
  },
  {
    id: "auth-gemini",
    label: "Sign in to Google",
    script: "src/main.ts",
    args: ["--auth", "gemini"],
    description: "Opens a browser window. Log in, then close the window.",
    usesLock: false,
    interactive: true,
  },
  {
    id: "probe-vertex",
    label: "Probe Vertex",
    script: "scripts/probe-vertex.ts",
    description: "Check the configured Vertex model is reachable and billing works.",
    usesLock: false,
  },
  {
    id: "probe-browser",
    label: "Probe browser",
    script: "scripts/probe-browser.ts",
    description: "Check the Gemini profile is still signed in and tabs run in parallel.",
    usesLock: false,
  },
];

const BY_ID = new Map(JOB_DEFINITIONS.map((d) => [d.id, d]));

export type JobPhase = "running" | "success" | "failed" | "cancelled";

export interface JobState {
  runId: number;
  jobId: string;
  label: string;
  command: string;
  phase: JobPhase;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  interactive: boolean;
}

export interface LogLine {
  seq: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
  at: string;
}

/** Enough to hold a full multi-lecture run without unbounded growth. */
const LOG_BUFFER_MAX = 2000;

class JobRunner extends EventEmitter {
  private child: ChildProcess | null = null;
  private current: JobState | null = null;
  private last: JobState | null = null;
  private buffer: LogLine[] = [];
  private seq = 0;
  private nextRunId = 1;
  /** Set when we killed it deliberately, so the exit isn't reported as a failure. */
  private cancelling = false;

  isRunning(): boolean {
    return this.child !== null;
  }

  getState(): { current: JobState | null; last: JobState | null } {
    return { current: this.current, last: this.last };
  }

  getBuffer(): LogLine[] {
    return this.buffer;
  }

  clearBuffer(): void {
    if (this.isRunning()) return; // clearing mid-run would hide the run in progress
    this.buffer = [];
    this.emit("event", { type: "cleared" });
  }

  start(jobId: string, extraArgs: string[] = []): JobState {
    if (this.child) {
      throw new Error(`"${this.current?.label}" is already running. Cancel it first.`);
    }
    const def = BY_ID.get(jobId);
    if (!def) throw new Error(`Unknown job "${jobId}"`);

    const scriptPath = path.join(CONFIG.rootDir, def.script);
    const args = [...(def.args ?? []), ...extraArgs];

    // `node --import tsx` rather than `npx tsx`: no shell, no npx resolution step,
    // and a PID we can actually kill (npx would give us the wrapper's).
    const child = spawn(process.execPath, ["--import", "tsx", scriptPath, ...args], {
      cwd: CONFIG.rootDir,
      env: { ...process.env, FORCE_COLOR: "0", UNINOTES_LAUNCHED_BY: "gui" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.child = child;
    this.cancelling = false;
    this.current = {
      runId: this.nextRunId++,
      jobId: def.id,
      label: def.label,
      command: `tsx ${def.script}${args.length ? " " + args.join(" ") : ""}`,
      phase: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      interactive: def.interactive ?? false,
    };

    this.push("system", `$ ${this.current.command}`);
    if (def.interactive) {
      this.push("system", "A browser window will open — sign in, then close it to continue.");
    }
    this.emit("event", { type: "job", job: this.current });

    this.pipe(child, "stdout");
    this.pipe(child, "stderr");

    child.on("error", (err) => {
      this.push("system", `Failed to start: ${err.message}`);
      this.finish(null, "failed");
    });

    child.on("close", (code) => {
      if (this.cancelling) {
        this.push("system", "Cancelled.");
        this.finish(code, "cancelled");
      } else if (code === 0) {
        this.push("system", "Finished successfully.");
        this.finish(code, "success");
      } else {
        this.push("system", `Exited with code ${code}.`);
        this.finish(code, "failed");
      }
    });

    return this.current;
  }

  async cancel(): Promise<void> {
    const child = this.child;
    if (!child?.pid) return;
    this.cancelling = true;
    this.push("system", "Cancelling…");

    // The tree matters: tsx spawns node, the pipeline spawns ffmpeg, and Playwright
    // spawns Edge. Killing only the direct child would orphan all of them, and an
    // orphaned Edge holds the browser profile lock against the next run.
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("close", () => resolve());
      killer.on("error", () => {
        child.kill("SIGKILL");
        resolve();
      });
    });
  }

  private pipe(child: ChildProcess, stream: "stdout" | "stderr"): void {
    const source = stream === "stdout" ? child.stdout : child.stderr;
    if (!source) return;

    // Chunks split mid-line, so hold the tail until a newline arrives. Without
    // this, long log lines arrive at the browser cut in half.
    let pending = "";
    source.setEncoding("utf-8");
    source.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) this.push(stream, line);
    });
    source.on("end", () => {
      if (pending.length > 0) {
        this.push(stream, pending);
        pending = "";
      }
    });
  }

  private push(stream: LogLine["stream"], text: string): void {
    const line: LogLine = {
      seq: ++this.seq,
      stream,
      text,
      at: new Date().toISOString(),
    };
    this.buffer.push(line);
    if (this.buffer.length > LOG_BUFFER_MAX) {
      this.buffer.splice(0, this.buffer.length - LOG_BUFFER_MAX);
    }
    this.emit("event", { type: "log", line });
  }

  private finish(code: number | null, phase: JobPhase): void {
    if (this.current) {
      this.current.phase = phase;
      this.current.exitCode = code;
      this.current.finishedAt = new Date().toISOString();
      this.last = this.current;
      this.emit("event", { type: "job", job: this.current });
    }
    this.current = null;
    this.child = null;
    this.cancelling = false;
  }
}

export const jobs = new JobRunner();
export function getJobDefinition(id: string): JobDefinition | undefined {
  return BY_ID.get(id);
}
