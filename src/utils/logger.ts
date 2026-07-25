import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../../config.js";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

/**
 * Identifies which concurrent unit of work produced a line.
 *
 * With 3 lectures × 4 parts in flight, an unprefixed log is unreadable — every
 * "Waiting for response..." looks the same. Every call site that runs inside a
 * concurrent task should pass one.
 */
export interface LogContext {
  /** Usually "<COURSE> · <lecture title>". */
  label?: string;
  /** "2/8", "single", or similar. */
  part?: string;
}

const LOG_FILE = path.join(
  CONFIG.paths.logs,
  `uninotes-${new Date().toISOString().slice(0, 10)}.log`,
);

function prefixOf(ctx?: LogContext): string {
  if (!ctx?.label && !ctx?.part) return "";
  const bits = [ctx.label, ctx.part && `part ${ctx.part}`].filter(Boolean);
  return `[${bits.join(" · ")}] `;
}

function formatMessage(level: LogLevel, message: string, ctx?: LogContext): string {
  const ts = new Date().toISOString();
  return `[${ts}] [${level}] ${prefixOf(ctx)}${message}`;
}

function writeToFile(line: string): void {
  try {
    // appendFileSync is atomic enough for whole lines, so concurrent writers
    // interleave by line but never corrupt each other.
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // If log dir doesn't exist yet, silently skip
  }
}

export const log = {
  debug(msg: string, ctx?: LogContext): void {
    const line = formatMessage("DEBUG", msg, ctx);
    console.debug(line);
    writeToFile(line);
  },
  info(msg: string, ctx?: LogContext): void {
    const line = formatMessage("INFO", msg, ctx);
    console.log(line);
    writeToFile(line);
  },
  warn(msg: string, ctx?: LogContext): void {
    const line = formatMessage("WARN", msg, ctx);
    console.warn(line);
    writeToFile(line);
  },
  error(msg: string, ctx?: LogContext): void {
    const line = formatMessage("ERROR", msg, ctx);
    console.error(line);
    writeToFile(line);
  },
};
