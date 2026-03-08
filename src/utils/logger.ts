import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../../config.js";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LOG_FILE = path.join(
  CONFIG.paths.logs,
  `uninotes-${new Date().toISOString().slice(0, 10)}.log`,
);

function formatMessage(level: LogLevel, message: string): string {
  const ts = new Date().toISOString();
  return `[${ts}] [${level}] ${message}`;
}

function writeToFile(line: string): void {
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // If log dir doesn't exist yet, silently skip
  }
}

export const log = {
  debug(msg: string): void {
    const line = formatMessage("DEBUG", msg);
    console.debug(line);
    writeToFile(line);
  },
  info(msg: string): void {
    const line = formatMessage("INFO", msg);
    console.log(line);
    writeToFile(line);
  },
  warn(msg: string): void {
    const line = formatMessage("WARN", msg);
    console.warn(line);
    writeToFile(line);
  },
  error(msg: string): void {
    const line = formatMessage("ERROR", msg);
    console.error(line);
    writeToFile(line);
  },
};
