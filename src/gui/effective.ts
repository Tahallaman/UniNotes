/**
 * What the *next* run will use — not what this process loaded at startup.
 *
 * The GUI server is long-lived and its own `CONFIG` was frozen when it imported
 * config.ts. Jobs are separate processes that re-read settings.json on start, so
 * reporting the server's CONFIG would make the control panel lie in the two
 * places it matters most: the settings form would snap back to the old value the
 * moment you saved, and the header pill would name the wrong backend.
 *
 * Recomputed per request rather than cached. These are a JSON parse and an object
 * clone against a file of a few dozen bytes, and a cache would only reintroduce
 * the staleness this exists to remove.
 */

import { DEFAULTS } from "../../config.js";
import { applyUserSettings } from "../settings/overlay.js";

export type EffectiveConfig = typeof DEFAULTS;

export function effectiveConfig(): EffectiveConfig {
  return applyUserSettings(DEFAULTS);
}

export { DEFAULTS };
