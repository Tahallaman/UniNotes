/**
 * Merge user overrides from settings.json over the defaults in config.ts.
 *
 * The GUI writes this file; config.ts applies it. The alternative — having the
 * GUI rewrite config.ts itself — would mean generating TypeScript from a form,
 * which destroys the comments that explain *why* each default is what it is and
 * leaves a config nobody trusts to read. Keeping defaults in reviewable source
 * and overrides in a small gitignored JSON file means `git diff config.ts` still
 * means something, and "reset to defaults" is a file deletion rather than an edit.
 *
 * Imports nothing from the project: config.ts imports this, so anything this
 * pulled in would be a cycle. That rules out the logger too, hence console.warn.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getField, coerce } from "./schema.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const SETTINGS_PATH = path.join(ROOT, "settings.json");

/** Raw contents of settings.json, or {} if absent/unreadable. */
export function readSettingsFile(): Record<string, unknown> {
  try {
    const text = fs.readFileSync(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    console.warn("[settings] settings.json is not an object — ignoring");
  } catch (err) {
    // ENOENT is the normal case: no overrides yet.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.warn(`[settings] Could not read settings.json: ${(err as Error).message} — using defaults`);
    }
  }
  return {};
}

export function writeSettingsFile(settings: Record<string, unknown>): void {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

export function deleteSettingsFile(): void {
  try {
    fs.unlinkSync(SETTINGS_PATH);
  } catch {
    // Already absent — that *is* "reset to defaults".
  }
}

function setByPath(target: Record<string, unknown>, dotted: string, value: unknown): void {
  const keys = dotted.split(".");
  let node = target;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    if (next === null || typeof next !== "object") return; // path doesn't exist in defaults
    node = next as Record<string, unknown>;
  }
  node[keys[keys.length - 1]] = value;
}

export function getByPath(source: unknown, dotted: string): unknown {
  let node: unknown = source;
  for (const key of dotted.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * Apply settings.json on top of the defaults.
 *
 * Only paths in the schema are honoured, and every value is re-validated here
 * rather than trusted from the file — settings.json is hand-editable, and a
 * string where a number belongs would otherwise fail somewhere far away with an
 * error that says nothing about the cause. An invalid entry is warned about and
 * skipped so the run continues on the default instead of dying at import time.
 *
 * Returns the same type it was given: the shape never changes, only values.
 */
export function applyUserSettings<T>(defaults: T): T {
  const overrides = readSettingsFile();
  const entries = Object.entries(overrides);
  if (entries.length === 0) return defaults;

  // Structured clone keeps the caller's `as const` object untouched, which matters
  // because config.ts's CONFIG is imported by ~30 modules that assume it's stable.
  const merged = structuredClone(defaults) as unknown as Record<string, unknown>;

  for (const [dotted, raw] of entries) {
    const field = getField(dotted);
    if (!field) {
      console.warn(`[settings] Unknown setting "${dotted}" — ignoring`);
      continue;
    }
    const result = coerce(field, raw);
    if (!result.ok) {
      console.warn(`[settings] ${result.error} — using default`);
      continue;
    }
    setByPath(merged, dotted, result.value);
  }

  return merged as unknown as T;
}
